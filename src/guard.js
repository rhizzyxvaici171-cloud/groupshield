'use strict';

const { analyzeMessage, worse, printable } = require('./detector');
const { mergeThresholds, DEFAULT_THRESHOLDS } = require('./thresholds');
const ids = require('./ids');
const policy = require('./policy');
const { BotWatch, looksLikeCommand, findWord } = require('./botwatch');

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

/** local date and HH:MM in a time zone */
function localClock(timeZone, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

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
    this.bots = new BotWatch();
    this.metaCache = new Map();
    this.sentIds = new Set();
    this.handled = new Set();
    this.lastAlert = 0;
    this.lastRefusal = new Map();
    this.startedAt = Date.now();
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

  ownerNumbers() {
    return this.store.ownerNumbers(this.config.owners);
  }

  /** the linked account itself, OWNER_NUMBERS, and owners added later */
  isOwner(senderIds, fromMe = false) {
    if (fromMe || ids.overlaps(senderIds, ids.selfIds(this.sock))) return true;
    const phone = ids.phoneOf(senderIds);
    return !!phone && this.ownerNumbers().includes(phone);
  }

  async send(jid, text, extra = {}) {
    if (this.config.dryRun && extra.moderation) return true;
    const { moderation, quoted, ...rest } = extra;
    return this.sendContent(jid, { text, ...rest }, quoted);
  }

  async sendContent(jid, content, quoted) {
    return this.queue.run('send', async () => {
      const m = await this.sock.sendMessage(jid, content, quoted ? { quoted } : {});
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
    const owners = this.ownerNumbers();
    const targets = owners.length ? owners.map((n) => `${n}@s.whatsapp.net`) : [self];
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

  member(meta, who) {
    const m = ids.findParticipant(meta, who);
    return {
      jid: m ? ids.normalize(m.id) : who[0],
      all: m ? ids.uniq([...who, ...ids.participantIds(m)]) : who,
      admin: !!m && (m.admin === 'admin' || m.admin === 'superadmin')
    };
  }

  /**
   * Warn, and remove at the limit. Admins and owners are told off but never
   * removed: taking an admin out of a group is a decision for the owner.
   * kind 'rule' (links, spam, words...) and 'cmd' (commanding bots) count separately.
   */
  async punish(groupJid, who, reason, meta, kind = 'rule') {
    const s = this.store.settings(groupJid);
    const t = this.member(meta, who);
    const tag = `@${t.jid.split('@')[0]}`;
    if (this.config.dryRun) return 'dry-run';
    if (t.admin || this.isOwner(t.all)) {
      await this.send(groupJid, `⚠️ ${tag} ${reason}.`, { mentions: [t.jid], moderation: true });
      return 'told off (admin)';
    }
    const n = this.store.strike(groupJid, t.all, kind);
    if (n >= s.warnLimit) {
      if (await this.kick(groupJid, t.jid)) {
        this.store.clearStrikes(groupJid, t.all, [kind]);
        await this.send(groupJid, `👢 ${tag} was removed after ${s.warnLimit} warnings: ${reason}.`, { mentions: [t.jid], moderation: true });
        return 'removed';
      }
    }
    await this.send(groupJid, `⚠️ ${tag} warning ${Math.min(n, s.warnLimit)}/${s.warnLimit}: ${reason}.`, { mentions: [t.jid], moderation: true });
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
    await this.send(groupJid, `🔒 Group locked for ${s.lockMinutes} minutes: ${reason}.`);
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

  /** opens and closes groups at the times set with .autoopen / .autoclose */
  async runSchedules(now = new Date()) {
    const clock = localClock(this.store.state.timezone || 'UTC', now);
    for (const jid of Object.keys(this.store.state.groups)) {
      const s = this.store.settings(jid);
      for (const [what, setting, text] of [
        ['close', 'announcement', '🌙 The group is now closed. Only admins can send messages.'],
        ['open', 'not_announcement', '☀️ The group is open again.']
      ]) {
        const at = what === 'close' ? s.autoClose : s.autoOpen;
        if (!at) continue;
        // Fire within 10 minutes of the set time, once a day, even after a restart.
        const late = clock.minutes - toMinutes(at);
        if (late < 0 || late > 10 || !this.store.claimSchedule(jid, what, clock.day)) continue;
        if (await this.queue.run(`auto${what}`, () => this.sock.groupSettingUpdate(jid, setting))) await this.send(jid, text);
      }
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
    const keyIds = fromMe ? ids.selfIds(this.sock) : ids.senderIds(msg.key);
    if (!keyIds.length) return null;
    const age = Date.now() / 1000 - Number(msg.messageTimestamp || 0);
    const fresh = type === 'notify' && age < FRESH_SECONDS;
    const s = group ? this.store.settings(chat) : null;
    const meta = group ? await this.meta(chat) : null;
    // Groups that hide numbers send only a private id; the member list links it
    // to the phone number, which is what owner numbers are matched against.
    const sender = group ? this.member(meta, keyIds).all : keyIds;
    const senderAdmin = group && ids.isAdmin(meta, sender);
    const owner = this.isOwner(sender, fromMe);
    const trusted = owner || this.store.isWhitelisted(sender);
    const text = policy.commandText(msg.message);
    const c = { msg, chat, group, sender, s, meta, senderAdmin, owner, fresh, text };

    if (group && fresh && !fromMe) this.store.count(chat, this.member(meta, sender).jid);

    // Moderation comes first and covers commands too, so starting a payload
    // with the command prefix does not get it past the scanner.
    if (!trusted && (!s || s.enabled)) {
      const hit = await this.moderate(c);
      if (hit) return hit;
    }

    if (!fresh || edit || !this.commands) return null;

    // Our own commands: obeyed only from people allowed to give them.
    if (text.startsWith(this.config.prefix) && text.length < 2500) {
      const cmd = this.commands.find(text, this.config.prefix);
      if (cmd) {
        const allowed = this.commands.allowed(cmd, { owner, admin: senderAdmin, access: this.store.state.access, group });
        this.logger.info({ command: cmd.name, where: group ? 'group' : 'private', from: fromMe ? 'linked number' : ids.label(sender), owner, allowed }, 'command received');
        if (allowed) {
          await this.commands.handle({ ...c, guard: this, cmd, admin: owner || senderAdmin });
          return { command: cmd.name };
        }
        if (group && s.enabled) {
          this.bots.noteCommand(chat, msg, sender, true);
          return { refused: cmd.name, action: await this.punish(chat, sender, 'only the owner can command me', meta, 'cmd') };
        }
        // In private, say why once in a while instead of staying silent.
        if (!group && Date.now() - (this.lastRefusal.get(sender[0]) || 0) > 10 * 60000) {
          this.lastRefusal.set(sender[0], Date.now());
          if (this.lastRefusal.size > 500) this.lastRefusal.delete(this.lastRefusal.keys().next().value);
          await this.send(chat, `⛔ I only take commands from my owner. Your number ${ids.label(sender)} is not an owner.`, { quoted: msg });
        }
        return { refused: cmd.name };
      }
    }

    // Commands for some other bot: remember them, so the reply can be caught.
    if (group && s.enabled && s.antibot && !trusted && looksLikeCommand(text)) this.bots.noteCommand(chat, msg, sender);
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
    if (!group) return null;

    if (s.antibot && fresh) {
      const hit = this.bots.check(chat, msg, sender, this.store.isKnownBot(chat, sender));
      if (hit) return this.onBotReply(c, hit);
    }
    if (senderAdmin) return null;

    if (this.store.isMuted(chat, sender)) {
      if (ids.isBotAdmin(this.sock, c.meta)) await this.deleteForEveryone(chat, msg.key);
      return { reason: 'muted', action: 'deleted' };
    }

    let reason = null;
    let keys = [msg.key];
    let warn = true;
    let word;
    if (s.antitag && policy.isStatusTag(msg.message)) reason = 'tagging this group in a status is not allowed';
    else if (policy.hasLink(msg.message, s.antilink)) reason = s.antilink === 'all' ? 'links are not allowed here' : 'invite links and channel promotions are not allowed here';
    else if (s.antiword && (word = findWord(policy.visibleText(msg.message), s.words))) reason = 'that word is not allowed here';
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
    const action = warn ? await this.punish(chat, sender, reason, c.meta) : 'deleted';
    this.store.incident({ type: 'rule', group: chat, name: printable(c.meta.subject), who: ids.label(sender), detail: word ? `${reason} (${printable(word)})` : reason, action });
    return { reason, action };
  }

  /** another bot answered a command: delete both, warn the caller, remove the bot */
  async onBotReply(c, hit) {
    const { msg, chat, sender, meta } = c;
    const { command } = hit;
    const botAdmin = ids.isBotAdmin(this.sock, meta);
    const done = [];
    this.bots.forget(chat, command.id);
    this.store.bump('bots');

    if (botAdmin) {
      if (await this.deleteForEveryone(chat, msg.key)) done.push('reply deleted');
      await this.deleteForEveryone(chat, command.key);
    }
    const responder = this.member(meta, sender);
    const seenBefore = this.store.markBot(chat, responder.all);

    if (botAdmin && !command.punished && !this.isOwner(command.sender)) {
      done.push(`caller ${await this.punish(chat, command.sender, hit.selfBot ? 'running a bot in this group is not allowed' : 'calling bots in this group is not allowed', meta, 'cmd')}`);
    }
    // A separate bot account is removed on a second catch, or at once when
    // quoting, speed and bot-only traits all agree (score 5 or more).
    if (botAdmin && !hit.selfBot && !responder.admin && !this.isOwner(responder.all) && (hit.score >= 5 || seenBefore)) {
      this.store.ban(chat, responder.all);
      if (await this.kick(chat, responder.jid)) done.push('bot removed');
    }
    const action = this.config.dryRun ? 'dry-run' : done.join(', ') || 'detected only';
    this.store.incident({ type: 'bot', group: chat, name: printable((meta && meta.subject) || ''), who: `${ids.label(sender)}${hit.selfBot ? '' : ` (called by ${ids.label(command.sender)})`}`, detail: `bot reply, evidence ${hit.score}`, action });
    return { bot: true, score: hit.score, action };
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
      const t = this.member(meta, sender);
      if (sev === 'critical') {
        if (!this.config.dryRun) this.store.ban(chat, t.all);
        if (await this.kick(chat, t.jid)) done.push('removed and banned');
      } else if (sev === 'high') {
        done.push(await this.punish(chat, sender, 'your message looked like a crash/bug message', meta));
      }
    }
    if (this.config.blockAttackers && !this.config.dryRun && sev === 'critical') {
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

  /** a number from a country the group does not allow; unknown numbers pass */
  fakeNumber(s, who) {
    if (!s.antifake || !s.allowedCodes) return false;
    const phone = ids.phoneOf(who);
    return !!phone && !s.allowedCodes.split(',').some((code) => phone.startsWith(code));
  }

  async onParticipants(u) {
    try {
      this.metaCache.delete(u.id);
      const s = this.store.settings(u.id);
      if (!s.enabled) return;
      const self = ids.selfIds(this.sock);
      const people = (u.participants || []).filter((p) => !ids.overlaps(ids.participantIds(p), self));
      if (!people.length) return;

      if (u.action === 'remove') {
        if (s.goodbye && people.length <= 5) {
          const gone = people.map((p) => ids.participantIds(p)[0]);
          await this.send(u.id, `👋 Goodbye ${gone.map((j) => `@${j.split('@')[0]}`).join(' ')}`, { mentions: gone });
        }
        return;
      }
      if (u.action !== 'add') return;
      const meta = await this.meta(u.id, true);
      const botAdmin = ids.isBotAdmin(this.sock, meta);

      const welcome = [];
      for (const p of people) {
        const t = this.member(meta, ids.participantIds(p));
        let why = null;
        if (this.store.isBanned(u.id, t.all)) why = 'banned member rejoined';
        else if (this.fakeNumber(s, t.all)) why = 'number from a country not allowed here';
        if (botAdmin && why && !this.isOwner(t.all)) {
          await this.kick(u.id, t.jid);
          this.store.incident({ type: 'join', group: u.id, name: printable(meta.subject), who: ids.label(t.all), detail: why, action: 'removed' });
        } else {
          welcome.push(t.jid);
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

  /** requests to join a group that needs approval */
  async onJoinRequest(r) {
    try {
      if (!r || r.action !== 'created' || !ids.isGroup(r.id)) return;
      const s = this.store.settings(r.id);
      if (!s.enabled) return;
      const who = ids.uniq([r.participant, r.participantPn]);
      let why = null;
      if (this.store.isBanned(r.id, who)) why = 'banned';
      else if (this.fakeNumber(s, who)) why = 'number from a country not allowed here';
      if (!why || this.config.dryRun) return;
      if (await this.queue.run('reject', () => this.sock.groupRequestParticipantsUpdate(r.id, [r.participant], 'reject'))) {
        this.store.incident({ type: 'join', group: r.id, name: '', who: ids.label(who), detail: `join request: ${why}`, action: 'rejected' });
      }
    } catch (e) {
      this.logger.error({ error: e.message }, 'join request check failed');
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

module.exports = { Guard, ActionQueue, withTimeout, localClock };
