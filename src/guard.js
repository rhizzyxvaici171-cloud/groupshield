'use strict';

const { analyzeMessage, worse, printable } = require('./detector');
const { mergeThresholds, DEFAULT_THRESHOLDS } = require('./thresholds');
const ids = require('./ids');
const policy = require('./policy');

const RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const FRESH_SECONDS = 120;

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error('timeout')), ms);
    })
  ]).finally(() => clearTimeout(t));
}

/** Runs WhatsApp actions one at a time so a burst cannot trip rate limits. */
class ActionQueue {
  constructor(logger, { gapMs = 250, max = 500 } = {}) {
    this.logger = logger;
    this.gapMs = gapMs;
    this.max = max;
    this.size = 0;
    this.chain = Promise.resolve();
  }

  run(name, fn) {
    if (this.size >= this.max) {
      this.logger.warn({ name }, 'action dropped, queue is full');
      return Promise.resolve(false);
    }
    this.size++;
    const task = this.chain.then(async () => {
      try {
        await withTimeout(Promise.resolve().then(fn), 15000);
        return true;
      } catch (e) {
        this.logger.warn({ name, error: e.message }, 'action failed');
        return false;
      } finally {
        this.size--;
        if (this.gapMs) await new Promise((r) => setTimeout(r, this.gapMs));
      }
    });
    this.chain = task;
    return task;
  }
}

class Guard {
  constructor({ sock, config, store, logger, commands, queue }) {
    this.sock = sock;
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.commands = commands;
    this.queue = queue || new ActionQueue(logger);
    this.thresholds = mergeThresholds(DEFAULT_THRESHOLDS, config.thresholds || {});
    this.flood = new policy.FloodTracker();
    this.joins = new policy.RateWindow();
    this.attacks = new policy.RateWindow();
    this.repeat = new policy.RateWindow();
    this.metaCache = new Map();
    this.sentIds = new Set();
    this.handled = new Set();
    this.lastAlert = 0;
  }

  // ------------------------------------------------------------- helpers

  async meta(groupJid, fresh = false) {
    const hit = this.metaCache.get(groupJid);
    if (hit && !fresh && Date.now() - hit.at < 5 * 60000) return hit.meta;
    try {
      const meta = await withTimeout(this.sock.groupMetadata(groupJid), 10000);
      this.metaCache.set(groupJid, { at: Date.now(), meta });
      return meta;
    } catch (e) {
      this.logger.warn({ groupJid, error: e.message }, 'could not read group info');
      return hit ? hit.meta : null;
    }
  }

  isOwner(senderIds, fromMe = false) {
    if (fromMe) return true;
    const phone = ids.phoneOf(senderIds);
    return !!phone && this.config.owners.includes(phone);
  }

  async send(jid, text, extra = {}) {
    if (this.config.dryRun && extra.moderation) return true;
    const { moderation, quoted, ...rest } = extra;
    return this.queue.run('send', async () => {
      const m = await this.sock.sendMessage(jid, { text, ...rest }, quoted ? { quoted } : {});
      if (m && m.key && m.key.id) {
        this.sentIds.add(m.key.id);
        if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value);
      }
    });
  }

  /** private alert to the owner(s); at most one every 10 seconds */
  async alert(lines) {
    if (Date.now() - this.lastAlert < 10000) return;
    this.lastAlert = Date.now();
    const self = ids.selfIds(this.sock).find((i) => i.endsWith('@s.whatsapp.net'));
    const targets = this.config.owners.length ? this.config.owners.map((n) => `${n}@s.whatsapp.net`) : [self];
    for (const t of targets.filter(Boolean)) await this.send(t, lines.join('\n'));
  }

  async deleteForEveryone(groupJid, key) {
    if (this.config.dryRun) return false;
    const ok = await this.queue.run('delete', () => this.sock.sendMessage(groupJid, { delete: key }));
    if (ok) this.store.bump('deleted');
    return ok;
  }

  /** removes ONE message from the linked account's own chat */
  async deleteForMe(msg) {
    if (this.config.dryRun) return false;
    const { remoteJid, id, fromMe } = msg.key;
    return this.queue.run('deleteForMe', () => this.sock.chatModify({
      deleteForMe: {
        deleteMedia: true,
        key: { remoteJid, id, fromMe: !!fromMe },
        timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)
      }
    }, remoteJid));
  }

  async kick(groupJid, participant) {
    if (this.config.dryRun) return false;
    const ok = await this.queue.run('kick', async () => {
      const res = await this.sock.groupParticipantsUpdate(groupJid, [participant], 'remove');
      const status = Array.isArray(res) && res[0] && res[0].status;
      if (status && String(status) !== '200') throw new Error(`WhatsApp answered ${status}`);
    });
    if (ok) this.store.bump('kicked');
    return ok;
  }

  async warnOrKick(groupJid, senderIds, reason, meta) {
    const s = this.store.settings(groupJid);
    const member = ids.findParticipant(meta, senderIds);
    const allIds = member ? ids.uniq([...senderIds, ...ids.participantIds(member)]) : senderIds;
    const jid = member ? ids.normalize(member.id) : senderIds[0];
    if (this.config.dryRun) return 'dry-run';
    const n = this.store.warn(groupJid, allIds);
    if (n >= s.warnLimit) {
      if (await this.kick(groupJid, jid)) {
        this.store.clearWarnings(groupJid, allIds);
        return 'kicked';
      }
    }
    const tag = `@${jid.split('@')[0]}`;
    await this.send(groupJid, `⚠️ ${tag} warning ${Math.min(n, s.warnLimit)}/${s.warnLimit}: ${reason}`, { mentions: [jid], moderation: true });
    return `warned ${n}/${s.warnLimit}`;
  }

  async lockdown(groupJid, reason) {
    if (this.store.isLocked(groupJid)) return;
    const s = this.store.settings(groupJid);
    const meta = await this.meta(groupJid);
    this.store.incident({ type: 'raid', group: groupJid, name: meta && printable(meta.subject), who: '-', detail: reason, action: this.config.dryRun ? 'dry-run' : 'lockdown' });
    if (this.config.dryRun || !ids.isBotAdmin(this.sock, meta)) {
      await this.alert([`🚨 Possible attack on your group: ${reason}.`, 'I could not lock it. Make me an admin.']);
      return;
    }
    // Already admins-only by choice: leave it that way, do not reopen later.
    if (meta.announce) return;
    this.store.lockUntil(groupJid, Date.now() + s.lockMinutes * 60000);
    const ok = await this.queue.run('lock', () => this.sock.groupSettingUpdate(groupJid, 'announcement'));
    if (!ok) {
      this.store.lockUntil(groupJid, 0);
      return;
    }
    this.store.bump('raids');
    await this.send(groupJid, `🔒 Group locked for ${s.lockMinutes} minutes: ${reason}. Admins can reopen it with ${this.config.prefix}unlock`);
    await this.alert([`🚨 *${this.config.botName}* locked a group`, reason]);
  }

  async unlock(groupJid) {
    const ok = await this.queue.run('unlock', () => this.sock.groupSettingUpdate(groupJid, 'not_announcement'));
    if (ok) this.store.lockUntil(groupJid, 0);
    return ok;
  }

  async releaseExpiredLocks() {
    for (const jid of this.store.expiredLocks()) {
      if (await this.unlock(jid)) await this.send(jid, '🔓 Lockdown over. The group is open again.');
      // Try again later instead of hammering a group we lost admin rights in.
      else this.store.lockUntil(jid, Date.now() + 5 * 60000);
    }
  }

  // ------------------------------------------------------------- messages

  async onMessages({ messages, type }) {
    for (const msg of messages || []) {
      try {
        await this.inspect(msg, type);
      } catch (e) {
        this.logger.error({ error: e.message }, 'message check failed');
      }
    }
  }

  async inspect(msg, type = 'notify') {
    if (!msg || !msg.key || !msg.message || msg.messageStubType) return null;
    const chat = msg.key.remoteJid;
    const group = ids.isGroup(chat);
    if (!group && !ids.isDirect(chat)) return null; // channels, status, broadcasts
    if (this.sentIds.has(msg.key.id)) return null;

    // Reconnects can replay a message; never warn twice for the same one.
    const edit = !!(msg.message.protocolMessage && msg.message.protocolMessage.editedMessage) || !!msg.message.editedMessage;
    if (msg.message.protocolMessage && !edit) return null;
    const uid = `${chat}|${msg.key.id}|${edit}`;
    if (this.handled.has(uid)) return null;
    this.handled.add(uid);
    if (this.handled.size > 3000) this.handled.delete(this.handled.values().next().value);

    const fromMe = !!msg.key.fromMe;
    const sender = fromMe ? ids.selfIds(this.sock) : ids.senderIds(msg.key);
    if (!sender.length) return null;
    const age = Date.now() / 1000 - Number(msg.messageTimestamp || 0);
    const fresh = type === 'notify' && age < FRESH_SECONDS;
    const s = group ? this.store.settings(chat) : null;
    const meta = group ? await this.meta(chat) : null;
    const senderAdmin = group && ids.isAdmin(meta, sender);

    // Moderation comes first and covers commands too, so starting a payload
    // with the command prefix does not get it past the scanner.
    if (!fromMe && !this.store.isWhitelisted(sender) && (!s || s.enabled)) {
      const hit = await this.moderate({ msg, chat, group, sender, s, meta, senderAdmin, fresh });
      if (hit) return hit;
    }

    if (fresh && !edit && this.commands) {
      const text = policy.commandText(msg.message);
      if (text.startsWith(this.config.prefix) && text.length < 2500) {
        const owner = this.isOwner(sender, fromMe);
        const used = await this.commands.handle({ guard: this, msg, chat, group, sender, text, owner, admin: owner || senderAdmin, meta });
        if (used) return { command: true };
      }
    }
    return null;
  }

  async moderate(c) {
    const { msg, chat, group, sender, s, senderAdmin, fresh } = c;
    this.store.state.stats.scanned++;

    if (!group || s.antibug) {
      const r = analyzeMessage(msg.message, { thresholds: this.thresholds });
      let sev = r.severity;
      if (RANK[sev] >= RANK.medium && this.repeat.add(sender[0], 1, this.thresholds.burstWindowMs) > this.thresholds.burstCount) {
        sev = worse(sev, 'high');
      }
      // Admins may tag everyone or post long notices; real payloads score higher.
      if (RANK[sev] >= (senderAdmin ? RANK.high : RANK.medium)) return this.onBug(c, r, sev);
    }

    if (!group || senderAdmin || this.isOwner(sender)) return null;

    let reason = null;
    let keys = [msg.key];
    let warn = true;
    if (s.antitag && policy.isStatusTag(msg.message)) reason = 'tagging this group in a status is not allowed';
    else if (policy.hasLink(msg.message, s.antilink)) reason = s.antilink === 'all' ? 'links are not allowed here' : 'invite links are not allowed here';
    else if (s.antispam && fresh) {
      const f = this.flood.hit(chat, sender[0], msg.key, policy.visibleText(msg.message), s);
      if (f) {
        reason = f.kind === 'flood' ? 'too many messages too fast' : 'repeating the same message';
        keys = f.keys;
        warn = f.warn;
      }
    }
    if (!reason) return null;

    if (!ids.isBotAdmin(this.sock, c.meta)) {
      this.logger.warn({ chat, reason }, 'rule broken but the bot is not an admin');
      return { reason, action: 'not admin' };
    }
    for (const k of keys) await this.deleteForEveryone(chat, k);
    const action = warn ? await this.warnOrKick(chat, sender, reason, c.meta) : 'deleted';
    this.store.incident({ type: 'rule', group: chat, name: printable(c.meta.subject), who: ids.label(sender), detail: reason, action });
    return { reason, action };
  }

  async onBug(c, result, sev) {
    const { msg, chat, group, sender, meta, senderAdmin, s } = c;
    const botAdmin = group && ids.isBotAdmin(this.sock, meta);
    const done = [];
    // An edit has its own id; the message people see is the one it points at.
    const edited = msg.message.protocolMessage && msg.message.protocolMessage.key;
    const seen = edited && edited.id ? { ...msg, key: { ...msg.key, id: edited.id } } : msg;
    this.store.bump('bugs');
    this.logger.warn({ chat, who: ids.label(sender), sev, reasons: result.reasons.map((r) => r.code) }, 'bug message');

    // For the whole group first, then for the linked account itself.
    if (botAdmin && (await this.deleteForEveryone(chat, seen.key))) done.push('deleted for everyone');
    if (await this.deleteForMe(seen)) done.push('deleted for me');

    if (botAdmin && !senderAdmin) {
      const member = ids.findParticipant(meta, sender);
      if (sev === 'critical') {
        if (!this.config.dryRun) this.store.ban(chat, ids.uniq([...sender, ...ids.participantIds(member)]));
        if (await this.kick(chat, member ? member.id : sender[0])) done.push('removed and banned');
      } else if (sev === 'high') {
        done.push(await this.warnOrKick(chat, sender, 'your message looked like a crash/bug message', meta));
      }
    }
    if (this.config.blockAttackers && !this.config.dryRun && sev === 'critical' && !this.isOwner(sender)) {
      if (await this.queue.run('block', () => this.sock.updateBlockStatus(sender[0], 'block'))) done.push('blocked');
    }

    const action = this.config.dryRun ? 'dry-run' : done.join(', ') || 'detected only';
    const detail = result.reasons.map((r) => r.code).join(', ');
    this.store.incident({ type: 'bug', group: chat, name: group ? printable((meta && meta.subject) || '') : 'private chat', who: ids.label(sender), detail, severity: sev, action });
    await this.alert([
      `🚨 *${this.config.botName}* caught a ${sev} bug message`,
      `From: ${ids.label(sender)}`,
      `Where: ${group ? printable((meta && meta.subject) || chat) : 'private chat'}`,
      `Why: ${detail}`,
      `Done: ${action}`,
      group && !botAdmin ? 'Make me a group admin so I can delete it for everyone.' : ''
    ].filter(Boolean));

    if (group && s.antiraid && RANK[sev] >= RANK.high && this.attacks.add(chat, 1, 60000) >= 3) {
      this.attacks.reset(chat);
      await this.lockdown(chat, 'several bug messages in one minute');
    }
    return { severity: sev, action };
  }

  // ------------------------------------------------------------- group events

  async onParticipants(u) {
    try {
      this.metaCache.delete(u.id);
      if (u.action !== 'add') return;
      const s = this.store.settings(u.id);
      if (!s.enabled) return;
      const meta = await this.meta(u.id, true);
      const self = ids.selfIds(this.sock);
      const people = (u.participants || []).filter((p) => !ids.overlaps(ids.participantIds(p), self));
      if (!people.length) return;
      const botAdmin = ids.isBotAdmin(this.sock, meta);

      const welcome = [];
      for (const p of people) {
        const who = ids.participantIds(p);
        const member = ids.findParticipant(meta, who);
        const all = member ? ids.uniq([...who, ...ids.participantIds(member)]) : who;
        if (botAdmin && this.store.isBanned(u.id, all)) {
          await this.kick(u.id, who[0]);
          this.store.incident({ type: 'ban', group: u.id, name: printable(meta.subject), who: ids.label(all), detail: 'banned member rejoined', action: 'removed' });
        } else {
          welcome.push(who[0]);
        }
      }
      if (s.antiraid && this.joins.add(u.id, people.length, s.raidSeconds * 1000) >= s.raidJoins) {
        this.joins.reset(u.id);
        await this.lockdown(u.id, 'too many people joined at once');
      } else if (s.welcome && welcome.length && welcome.length <= 5 && !this.store.isLocked(u.id)) {
        const tags = welcome.map((j) => `@${j.split('@')[0]}`).join(' ');
        await this.send(u.id, `👋 Welcome ${tags}${s.rules ? `\n\n*Rules*\n${s.rules}` : ''}`, { mentions: welcome });
      }
    } catch (e) {
      this.logger.error({ error: e.message }, 'join check failed');
    }
  }

  async onGroups(updates) {
    for (const u of updates || []) {
      if (!u || !u.id) continue;
      this.metaCache.delete(u.id);
      for (const field of ['subject', 'desc']) {
        if (typeof u[field] !== 'string') continue;
        const r = analyzeMessage({ conversation: u[field] }, { thresholds: this.thresholds });
        if (RANK[r.severity] < RANK.medium) continue;
        const what = field === 'desc' ? 'description' : 'name';
        this.store.incident({ type: 'bug', group: u.id, name: '', who: '-', detail: `group ${what} contains a bug payload`, severity: r.severity, action: 'owner alerted' });
        await this.alert([`🚨 A group ${what} was changed to a bug payload. Change it back from WhatsApp Web.`]);
      }
    }
  }
}

module.exports = { Guard, ActionQueue, withTimeout };
