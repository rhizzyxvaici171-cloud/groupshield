'use strict';

const ids = require('./ids');
const policy = require('./policy');
const { analyzeMessage } = require('./detector');

const TOGGLES = ['antibug', 'antispam', 'antiraid', 'antitag', 'welcome'];
const NUMBERS = { warnlimit: 'warnLimit', floodcount: 'floodCount', floodseconds: 'floodSeconds', raidjoins: 'raidJoins', lockminutes: 'lockMinutes' };

function help(p, name) {
  return [
    `🛡️ *${name}*`, '',
    '*Everyone*',
    `${p}rules · ${p}help`, '',
    '*Protection (group admins)*',
    `${p}status - what is on`,
    `${p}shield on|off - all protection in this group`,
    `${p}antibug on|off - crash/bug messages`,
    `${p}antilink off|invites|all`,
    `${p}antispam on|off - floods and repeats`,
    `${p}antiraid on|off - mass joins and attacks`,
    `${p}antitag on|off - status mentions`,
    `${p}set warnlimit 3 - also floodcount, floodseconds, raidjoins, lockminutes`,
    `${p}scan - reply to a message to test it`, '',
    '*Members (group admins)*',
    `${p}kick · ${p}ban · ${p}unban · ${p}warn · ${p}unwarn · ${p}warnings`,
    `${p}promote · ${p}demote · ${p}del`,
    '_Reply to the person, tag them, or add their number._', '',
    '*Group (group admins)*',
    `${p}lock · ${p}unlock · ${p}tagall · ${p}link · ${p}resetlink`,
    `${p}setrules text · ${p}welcome on|off`, '',
    '*Owner only*',
    `${p}trust · ${p}untrust · ${p}trusted - never moderate this person`
  ].join('\n');
}

/** who the command is about: reply, tag, or typed number */
function target(msg, args, meta) {
  const ctx = policy.contextInfo(msg.message);
  let found = [];
  if (Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length) found = [ctx.mentionedJid[0]];
  else if (ctx.participant) found = [ctx.participant];
  else {
    const n = args.join('').replace(/[^0-9]/g, '');
    if (n.length >= 7 && n.length <= 15) found = [`${n}@s.whatsapp.net`];
  }
  const base = ids.uniq(found);
  if (!base.length) return null;
  const member = ids.findParticipant(meta, base);
  return {
    member,
    jid: member ? ids.normalize(member.id) : base[0],
    ids: member ? ids.uniq([...base, ...ids.participantIds(member)]) : base
  };
}

async function handle(c) {
  const { guard, msg, chat, group, sender, text, owner, admin } = c;
  const { config, store, sock } = guard;
  const p = config.prefix;
  const [word, ...args] = text.slice(p.length).split(/\s+/);
  const cmd = (word || '').toLowerCase();
  const arg = (args[0] || '').toLowerCase();
  if (!/^[a-z]{2,15}$/.test(cmd)) return false;

  const reply = (t, extra = {}) => guard.send(chat, t, { quoted: msg, ...extra });
  const run = async (name, fn, ok) => {
    await reply((await guard.queue.run(name, fn)) ? ok : '❌ WhatsApp refused that. Am I a group admin?');
    return true;
  };

  if (cmd === 'help' || cmd === 'menu') {
    await reply(help(p, config.botName));
    return true;
  }

  // ---- owner only
  if (['trust', 'untrust', 'trusted'].includes(cmd)) {
    if (!owner) return true;
    if (cmd === 'trusted') {
      await reply(store.state.whitelist.length ? store.state.whitelist.map((i) => `• ${i.split('@')[0]}`).join('\n') : 'Nobody is trusted yet.');
      return true;
    }
    const t = target(msg, args, c.meta);
    if (!t) return reply('Reply to the person, tag them, or add their number.').then(() => true);
    if (cmd === 'trust') store.whitelist(t.ids);
    else store.unwhitelist(t.ids);
    await reply(cmd === 'trust' ? '✅ Trusted. I will not moderate them.' : '✅ No longer trusted.');
    return true;
  }

  if (!group) return false;
  const s = store.settings(chat);

  if (cmd === 'rules') {
    await reply(s.rules ? `📜 *Rules*\n${s.rules}` : 'No rules have been set.');
    return true;
  }

  const known = [...TOGGLES, 'status', 'shield', 'antilink', 'set', 'scan', 'kick', 'ban', 'unban', 'warn', 'unwarn', 'warnings',
    'promote', 'demote', 'del', 'lock', 'unlock', 'tagall', 'link', 'resetlink', 'setrules'];
  if (!known.includes(cmd)) return false;
  if (!admin) {
    await reply('⛔ Only group admins can use that.');
    return true;
  }

  // Settings that change members need current facts, not a cached list.
  const meta = await guard.meta(chat, true);
  if (!owner && !ids.isAdmin(meta, sender)) {
    await reply('⛔ Only group admins can use that.');
    return true;
  }

  switch (cmd) {
    case 'status': {
      const on = (v) => (v ? '✅' : '❌');
      await reply([
        `🛡️ *${config.botName}*${config.dryRun ? ' (test mode)' : ''}`,
        `I am an admin here: ${on(ids.isBotAdmin(sock, meta))}`,
        `Protection: ${on(s.enabled)}`,
        `Bugs: ${on(s.antibug)}  Spam: ${on(s.antispam)}  Raids: ${on(s.antiraid)}  Tags: ${on(s.antitag)}`,
        `Links: ${s.antilink}`,
        `Warnings before removal: ${s.warnLimit}`,
        `Flood: ${s.floodCount} messages in ${s.floodSeconds}s`,
        `Caught so far: ${store.state.stats.bugs} bugs, ${store.state.stats.deleted} deleted, ${store.state.stats.kicked} removed`
      ].join('\n'));
      return true;
    }
    case 'shield':
    case 'antibug': case 'antispam': case 'antiraid': case 'antitag': case 'welcome': {
      const name = cmd === 'shield' ? 'enabled' : cmd;
      if (arg !== 'on' && arg !== 'off') await reply(`Use ${p}${cmd} on or ${p}${cmd} off. Now: ${s[name] ? 'on' : 'off'}`);
      else {
        store.set(chat, name, arg === 'on');
        await reply(`${arg === 'on' ? '✅' : '❌'} ${cmd} is ${arg}.`);
      }
      return true;
    }
    case 'antilink': {
      const v = arg === 'on' ? 'invites' : arg;
      await reply(store.set(chat, 'antilink', v) ? `🔗 antilink: ${v}` : `Use ${p}antilink off, invites or all. Now: ${s.antilink}`);
      return true;
    }
    case 'set': {
      const key = Object.hasOwn(NUMBERS, arg) ? NUMBERS[arg] : null;
      await reply(key && store.set(chat, key, Number(args[1]))
        ? `✅ ${arg} = ${args[1]}`
        : `Use ${p}set <name> <number>. Names: ${Object.keys(NUMBERS).join(', ')}`);
      return true;
    }
    case 'setrules': {
      const rules = text.slice(p.length + word.length).trim();
      if (!rules) await reply(`Use ${p}setrules followed by the rules.`);
      else {
        store.set(chat, 'rules', rules);
        await reply('✅ Rules saved.');
      }
      return true;
    }
    case 'scan': {
      const q = policy.contextInfo(msg.message).quotedMessage;
      if (!q) return reply(`Reply to a message with ${p}scan`).then(() => true);
      const r = analyzeMessage(q, { thresholds: guard.thresholds });
      await reply(r.flagged ? `🚨 ${r.severity} (${r.score}/100)\n${r.reasons.map((x) => `• ${x.code}: ${x.detail}`).join('\n')}` : `✅ Clean (${r.score}/100)`);
      return true;
    }
    case 'lock':
      store.lockUntil(chat, 0);
      return run('lock', () => sock.groupSettingUpdate(chat, 'announcement'), '🔒 Only admins can send messages now.');
    case 'unlock':
      store.lockUntil(chat, 0);
      return run('unlock', () => sock.groupSettingUpdate(chat, 'not_announcement'), '🔓 Everyone can send messages.');
    case 'link': {
      let code;
      const ok = await guard.queue.run('link', async () => { code = await sock.groupInviteCode(chat); });
      await reply(ok && code ? `https://chat.whatsapp.com/${code}` : '❌ WhatsApp refused that. Am I a group admin?');
      return true;
    }
    case 'resetlink':
      return run('resetlink', () => sock.groupRevokeInvite(chat), '✅ Old invite link no longer works.');
    case 'tagall': {
      const people = (meta ? meta.participants : []).map((x) => ids.normalize(x.id));
      const note = args.join(' ').slice(0, 500);
      await guard.send(chat, `📢 ${note || 'Attention everyone'}`, { mentions: people });
      return true;
    }
    case 'del': {
      const ctx = policy.contextInfo(msg.message);
      if (!ctx.stanzaId) return reply(`Reply to a message with ${p}del`).then(() => true);
      const mine = ids.overlaps(ids.uniq([ctx.participant]), ids.selfIds(sock));
      const ok = await guard.deleteForEveryone(chat, { remoteJid: chat, id: ctx.stanzaId, participant: ctx.participant, fromMe: mine });
      if (!ok) await reply('❌ Could not delete it. Am I a group admin?');
      return true;
    }
    default:
  }

  // ---- commands about one member
  const t = target(msg, args, meta);
  if (!t) {
    await reply('Reply to the person, tag them, or add their number.');
    return true;
  }
  const name = `@${t.jid.split('@')[0]}`;
  const tag = { mentions: [t.jid] };
  const isProtected = ids.overlaps(t.ids, ids.selfIds(sock)) || guard.isOwner(t.ids) || ids.isAdmin(meta, t.ids);

  if (['kick', 'ban', 'warn'].includes(cmd) && isProtected) {
    await reply('I will not do that to an admin, the owner or myself.');
    return true;
  }
  if (cmd === 'demote' && !owner && isProtected && (ids.overlaps(t.ids, ids.selfIds(sock)) || guard.isOwner(t.ids))) {
    await reply('I will not demote the owner or myself.');
    return true;
  }

  switch (cmd) {
    case 'warnings':
      await reply(`${name} has ${store.warnings(chat, t.ids)}/${s.warnLimit} warnings.`, tag);
      return true;
    case 'unwarn':
      store.clearWarnings(chat, t.ids);
      await reply(`✅ Warnings cleared for ${name}.`, tag);
      return true;
    case 'warn': {
      const result = await guard.warnOrKick(chat, t.ids, 'given by an admin', meta);
      if (result === 'kicked') await reply(`👢 ${name} reached the limit and was removed.`, tag);
      return true;
    }
    case 'unban':
      await reply(store.unban(chat, t.ids) ? `✅ ${name} can join again.` : `${name} is not banned here.`, tag);
      return true;
    case 'ban':
      store.ban(chat, t.ids);
      if (t.member && !(await guard.kick(chat, t.jid))) await reply('Banned, but I could not remove them now. Am I a group admin?');
      else await reply(`🚫 ${name} is banned.`, tag);
      return true;
    case 'kick':
      await reply((await guard.kick(chat, t.jid)) ? `👢 ${name} removed.` : '❌ Could not remove them. Am I a group admin?', tag);
      return true;
    case 'promote':
    case 'demote':
      return run(cmd, () => sock.groupParticipantsUpdate(chat, [t.jid], cmd), `✅ Done (${cmd}).`);
    default:
      return true;
  }
}

module.exports = { handle, help, target };
