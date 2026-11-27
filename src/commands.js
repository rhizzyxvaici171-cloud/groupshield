'use strict';

const ids = require('./ids');
const policy = require('./policy');
const { analyzeMessage } = require('./detector');
const { BOUNDS } = require('./store');

/**
 * Who may use a command:
 *   public - everyone (only .rules)
 *   admin  - the owner, plus group admins when access is set to "admins"
 *   owner  - the owner only, always
 */
const NUMBERS = { warnlimit: 'warnLimit', floodcount: 'floodCount', floodseconds: 'floodSeconds', raidjoins: 'raidJoins', lockminutes: 'lockMinutes' };
const SWITCHES = {
  shield: ['enabled', 'all protection in this group'],
  antibug: ['antibug', 'crash/bug messages'],
  antispam: ['antispam', 'floods and repeated messages'],
  antiraid: ['antiraid', 'mass joins and attacks'],
  antitag: ['antitag', 'status mentions of the group'],
  antibot: ['antibot', 'other bots and people calling them'],
  antiword: ['antiword', 'banned words'],
  antifake: ['antifake', 'numbers from other countries'],
  welcome: ['welcome', 'welcome message'],
  goodbye: ['goodbye', 'goodbye message']
};

const COMMANDS = [];
function def(name, level, category, usage, run, opts = {}) {
  COMMANDS.push({ name, level, category, usage, run, aliases: opts.aliases || [], group: opts.group !== false });
}

const on = (v) => (v ? '✅' : '❌');
const at = (jid) => `@${jid.split('@')[0]}`;

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
    ids: member ? ids.uniq([...base, ...ids.participantIds(member)]) : base,
    admin: !!member && (member.admin === 'admin' || member.admin === 'superadmin')
  };
}

const NEED_TARGET = 'Reply to the person, tag them, or add their number.';
const NOT_ADMIN = '❌ WhatsApp refused that. Am I a group admin?';

// ------------------------------------------------------------------ general

def('menu', 'admin', 'General', 'show this list', async (x) => x.reply(menu(x)), { aliases: ['help', 'commands'], group: false });
def('ping', 'admin', 'General', 'check the bot is awake', async (x) => {
  const ms = Math.max(0, Date.now() - Number(x.msg.messageTimestamp || 0) * 1000);
  await x.reply(`🏓 Pong (${ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : 'delayed'})`);
}, { group: false });
def('uptime', 'admin', 'General', 'how long the bot has run', async (x) => {
  const m = Math.floor((Date.now() - x.guard.startedAt) / 60000);
  await x.reply(`⏱️ Running for ${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h ${m % 60}m`);
}, { group: false });
def('rules', 'public', 'General', 'show the group rules', async (x) => x.reply(x.s.rules ? `📜 *Rules*\n${x.s.rules}` : 'No rules have been set.'));

// ------------------------------------------------------------------ protection

def('status', 'admin', 'Protection', 'what is switched on', async (x) => {
  const { s, meta, guard } = x;
  const st = guard.store.state.stats;
  await x.reply([
    `🛡️ *${guard.config.botName}*${guard.config.dryRun ? ' (test mode)' : ''}`,
    `I am an admin here: ${on(ids.isBotAdmin(guard.sock, meta))}`,
    `Who can command me: ${guard.store.state.access === 'owner' ? 'owner only' : 'owner and group admins'}`,
    `Protection: ${on(s.enabled)}`,
    `Bugs ${on(s.antibug)}  Spam ${on(s.antispam)}  Raids ${on(s.antiraid)}  Tags ${on(s.antitag)}`,
    `Bots ${on(s.antibot)}  Words ${on(s.antiword)}  Foreign numbers ${on(s.antifake)}${s.antifake ? ` (allowed: ${s.allowedCodes || 'none set'})` : ''}`,
    `Links: ${s.antilink}`,
    `Warnings before removal: ${s.warnLimit}`,
    `Flood: ${s.floodCount} messages in ${s.floodSeconds}s`,
    s.autoClose || s.autoOpen ? `Schedule: close ${s.autoClose || '-'}, open ${s.autoOpen || '-'} (${guard.store.state.timezone})` : '',
    `So far: ${st.bugs} bugs, ${st.bots || 0} bot replies, ${st.deleted} deleted, ${st.kicked} removed`
  ].filter(Boolean).join('\n'));
});
for (const [cmd, [name, what]] of Object.entries(SWITCHES)) {
  def(cmd, 'admin', 'Protection', `on/off - ${what}`, async (x) => {
    const v = x.arg;
    if (v !== 'on' && v !== 'off') return x.reply(`Use ${x.p}${cmd} on or ${x.p}${cmd} off. Now: ${x.s[name] ? 'on' : 'off'}`);
    x.store.set(x.chat, name, v === 'on');
    const extra = cmd === 'antiword' && v === 'on' && !x.s.words.length ? `\nAdd words with ${x.p}addword` : cmd === 'antifake' && v === 'on' && !x.s.allowedCodes ? `\nSet allowed country codes with ${x.p}allowcc 234` : '';
    return x.reply(`${v === 'on' ? '✅' : '❌'} ${cmd} is ${v}.${extra}`);
  });
}
def('antilink', 'admin', 'Protection', 'off / invites / all', async (x) => {
  const v = x.arg === 'on' ? 'invites' : x.arg;
  await x.reply(x.store.set(x.chat, 'antilink', v) ? `🔗 antilink: ${v}` : `Use ${x.p}antilink off, invites or all. Now: ${x.s.antilink}`);
});
def('addword', 'admin', 'Protection', 'word - ban a word', async (x) => {
  const add = x.rest.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
  if (!add.length) return x.reply(`Use ${x.p}addword word1, word2`);
  x.store.set(x.chat, 'words', [...x.s.words, ...add]);
  if (!x.s.antiword) x.store.set(x.chat, 'antiword', true);
  return x.reply(`✅ Banned words: ${x.store.settings(x.chat).words.length}. antiword is on.`);
});
def('delword', 'admin', 'Protection', 'word - allow a word again', async (x) => {
  const del = x.rest.toLowerCase().split(/[,\n]/).map((w) => w.trim());
  x.store.set(x.chat, 'words', x.s.words.filter((w) => !del.includes(w)));
  await x.reply(`✅ Banned words: ${x.store.settings(x.chat).words.length}`);
});
def('words', 'admin', 'Protection', 'list banned words', async (x) => {
  await x.reply(x.s.words.length ? `🚫 *Banned words* (${x.s.antiword ? 'on' : 'off'})\n${x.s.words.join(', ')}` : `No banned words. Add some with ${x.p}addword`);
});
def('allowcc', 'admin', 'Protection', '234,233 - country codes allowed to join', async (x) => {
  if (x.arg === 'off') {
    x.store.set(x.chat, 'antifake', false);
    return x.reply('❌ Foreign number filter is off.');
  }
  if (!x.store.set(x.chat, 'allowedCodes', x.rest) || !x.store.settings(x.chat).allowedCodes) return x.reply(`Use ${x.p}allowcc 234 or ${x.p}allowcc 234,233`);
  x.store.set(x.chat, 'antifake', true);
  return x.reply(`✅ Only numbers starting with ${x.store.settings(x.chat).allowedCodes} can join. Others are removed or refused.`);
});
def('set', 'admin', 'Protection', 'warnlimit 3 (also floodcount, floodseconds, raidjoins, lockminutes)', async (x) => {
  const key = Object.hasOwn(NUMBERS, x.arg) ? NUMBERS[x.arg] : null;
  if (key && x.store.set(x.chat, key, Number(x.args[1]))) return x.reply(`✅ ${x.arg} = ${x.args[1]}`);
  const range = key ? ` (${BOUNDS[key][0]}-${BOUNDS[key][1]})` : '';
  return x.reply(`Use ${x.p}set <name> <number>${range}. Names: ${Object.keys(NUMBERS).join(', ')}`);
});
def('scan', 'admin', 'Protection', 'reply to a message to test it', async (x) => {
  const q = policy.contextInfo(x.msg.message).quotedMessage;
  if (!q) return x.reply(`Reply to a message with ${x.p}scan`);
  const r = analyzeMessage(q, { thresholds: x.guard.thresholds });
  return x.reply(r.flagged ? `🚨 ${r.severity} (${r.score}/100)\n${r.reasons.map((y) => `• ${y.code}: ${y.detail}`).join('\n')}` : `✅ Clean (${r.score}/100)`);
}, { group: false });

// ------------------------------------------------------------------ members

function memberCommand(name, usage, run, opts = {}) {
  def(name, 'admin', 'Members', usage, async (x) => {
    const t = target(x.msg, x.args, x.meta);
    if (!t) return x.reply(NEED_TARGET);
    const self = ids.overlaps(t.ids, ids.selfIds(x.guard.sock));
    const owner = x.guard.isOwner(t.ids);
    if (opts.protect && (self || owner || t.admin)) return x.reply('I will not do that to an admin, the owner or myself.');
    if (opts.protectOwner && (self || owner)) return x.reply('I will not do that to the owner or myself.');
    return run(x, t, `@${t.jid.split('@')[0]}`, { mentions: [t.jid] });
  });
}
memberCommand('kick', 'remove a member', async (x, t, name, tag) => x.reply((await x.guard.kick(x.chat, t.jid)) ? `👢 ${name} removed.` : NOT_ADMIN, tag), { protect: true });
memberCommand('ban', 'remove and keep out', async (x, t, name, tag) => {
  x.store.ban(x.chat, t.ids);
  if (t.member && !(await x.guard.kick(x.chat, t.jid))) return x.reply(`Banned, but I could not remove them now. ${NOT_ADMIN}`);
  return x.reply(`🚫 ${name} is banned.`, tag);
}, { protect: true });
memberCommand('unban', 'allow back in', async (x, t, name, tag) => x.reply(x.store.unban(x.chat, t.ids) ? `✅ ${name} can join again.` : `${name} is not banned here.`, tag));
memberCommand('warn', 'give a warning', async (x, t) => { await x.guard.punish(x.chat, t.ids, 'warned by the owner', x.meta); }, { protect: true });
memberCommand('unwarn', 'clear all warnings', async (x, t, name, tag) => {
  x.store.clearStrikes(x.chat, t.ids);
  return x.reply(`✅ Warnings cleared for ${name}.`, tag);
});
memberCommand('warnings', 'see warnings', async (x, t, name, tag) => {
  const lim = x.s.warnLimit;
  return x.reply(`${name}: rules ${x.store.strikes(x.chat, t.ids, 'rule')}/${lim}, commanding bots ${x.store.strikes(x.chat, t.ids, 'cmd')}/${lim}`, tag);
});
memberCommand('mute', 'minutes - delete their messages for a while', async (x, t, name, tag) => {
  const mins = Number(x.args.find((a) => /^\d+$/.test(a) && a.length <= 4)) || 30;
  x.store.mute(x.chat, t.ids, Math.min(mins, 7 * 1440));
  return x.reply(`🔇 ${name} is muted for ${mins} minutes. Their messages will be deleted.`, tag);
}, { protect: true });
memberCommand('unmute', 'let them talk again', async (x, t, name, tag) => x.reply(x.store.unmute(x.chat, t.ids) ? `🔊 ${name} can talk again.` : `${name} is not muted.`, tag));
memberCommand('promote', 'make admin', async (x, t, name, tag) => x.run('promote', () => x.sock.groupParticipantsUpdate(x.chat, [t.jid], 'promote'), `⬆️ ${name} is now an admin.`, tag));
memberCommand('demote', 'remove admin', async (x, t, name, tag) => x.run('demote', () => x.sock.groupParticipantsUpdate(x.chat, [t.jid], 'demote'), `⬇️ ${name} is no longer an admin.`, tag), { protectOwner: true });
def('add', 'admin', 'Members', 'number - add someone', async (x) => {
  const n = x.rest.replace(/[^0-9]/g, '');
  if (n.length < 7 || n.length > 15) return x.reply(`Use ${x.p}add 2348012345678`);
  let status = '';
  const ok = await x.guard.queue.run('add', async () => {
    const res = await x.sock.groupParticipantsUpdate(x.chat, [`${n}@s.whatsapp.net`], 'add');
    status = String((Array.isArray(res) && res[0] && res[0].status) || '200');
  });
  if (!ok) return x.reply(NOT_ADMIN);
  const why = { 200: `✅ Added +${n}.`, 403: `+${n} only lets contacts add them. Send them the link with ${x.p}link.`, 408: `+${n} left recently. Send them the link.`, 409: `+${n} is already here.` };
  return x.reply(why[status] || `WhatsApp answered ${status}.`);
});
def('del', 'admin', 'Members', 'reply to delete a message', async (x) => {
  const ctx = policy.contextInfo(x.msg.message);
  if (!ctx.stanzaId) return x.reply(`Reply to a message with ${x.p}del`);
  const mine = ids.overlaps(ids.uniq([ctx.participant]), ids.selfIds(x.sock));
  if (!(await x.guard.deleteForEveryone(x.chat, { remoteJid: x.chat, id: ctx.stanzaId, participant: ctx.participant, fromMe: mine }))) await x.reply(`❌ Could not delete it. ${NOT_ADMIN}`);
  await x.guard.deleteForEveryone(x.chat, x.msg.key);
}, { aliases: ['delete'] });

// ------------------------------------------------------------------ group

def('lock', 'admin', 'Group', 'only admins can talk', async (x) => {
  x.store.lockUntil(x.chat, 0);
  return x.run('lock', () => x.sock.groupSettingUpdate(x.chat, 'announcement'), '🔒 Only admins can send messages now.');
}, { aliases: ['close', 'mutegroup'] });
def('unlock', 'admin', 'Group', 'everyone can talk', async (x) => {
  x.store.lockUntil(x.chat, 0);
  return x.run('unlock', () => x.sock.groupSettingUpdate(x.chat, 'not_announcement'), '🔓 Everyone can send messages.');
}, { aliases: ['open', 'unmutegroup'] });
for (const [name, key, verb] of [['autoclose', 'autoClose', 'close'], ['autoopen', 'autoOpen', 'open']]) {
  def(name, 'admin', 'Group', `22:00 or off - ${verb} every day`, async (x) => {
    const v = x.arg === 'off' ? '' : x.arg;
    if (!x.store.set(x.chat, key, v)) return x.reply(`Use ${x.p}${name} 22:00 (24-hour time) or ${x.p}${name} off`);
    return x.reply(v ? `⏰ I will ${verb} the group every day at ${v} (${x.store.state.timezone}).` : `⏰ Daily ${verb} is off.`);
  });
}
def('tagall', 'admin', 'Group', 'text - mention everyone', async (x) => {
  const people = x.meta.participants.map((p) => ids.normalize(p.id));
  await x.guard.send(x.chat, `📢 ${x.rest || 'Attention everyone'}\n\n${people.map(at).join(' ')}`, { mentions: people });
}, { aliases: ['everyone'] });
def('hidetag', 'admin', 'Group', 'text - notify everyone without the list', async (x) => {
  if (!x.rest) return x.reply(`Use ${x.p}hidetag your message`);
  await x.guard.send(x.chat, x.rest, { mentions: x.meta.participants.map((p) => ids.normalize(p.id)) });
  await x.guard.deleteForEveryone(x.chat, x.msg.key);
}, { aliases: ['announce'] });
def('admins', 'admin', 'Group', 'list the admins', async (x) => {
  const list = x.meta.participants.filter((p) => p.admin).map((p) => ids.normalize(p.id));
  await x.reply(`👮 *Admins* (${list.length})\n${list.map(at).join('\n')}`, { mentions: list });
});
def('groupinfo', 'admin', 'Group', 'facts about this group', async (x) => {
  const m = x.meta;
  const made = m.creation ? new Date(m.creation * 1000).toDateString() : 'unknown';
  await x.reply([
    `ℹ️ *${m.subject}*`,
    `Members: ${m.participants.length} (${m.participants.filter((p) => p.admin).length} admins)`,
    `Created: ${made}`,
    `Messages: ${m.announce ? 'admins only' : 'everyone'}`,
    `Edit info: ${m.restrict ? 'admins only' : 'everyone'}`,
    `Join approval: ${m.joinApprovalMode ? 'on' : 'off'}`,
    m.desc ? `\n${String(m.desc).slice(0, 500)}` : ''
  ].filter(Boolean).join('\n'));
}, { aliases: ['info'] });
def('link', 'admin', 'Group', 'get the invite link', async (x) => {
  let code;
  const ok = await x.guard.queue.run('link', async () => { code = await x.sock.groupInviteCode(x.chat); });
  await x.reply(ok && code ? `https://chat.whatsapp.com/${code}` : NOT_ADMIN);
});
def('resetlink', 'admin', 'Group', 'make the old link stop working', async (x) => x.run('resetlink', () => x.sock.groupRevokeInvite(x.chat), '✅ The old invite link no longer works.'), { aliases: ['revoke'] });
def('setname', 'admin', 'Group', 'text - rename the group', async (x) => {
  if (!x.rest || x.rest.length > 100) return x.reply(`Use ${x.p}setname New name (up to 100 characters)`);
  return x.run('setname', () => x.sock.groupUpdateSubject(x.chat, x.rest), '✅ Group renamed.');
});
def('setdesc', 'admin', 'Group', 'text - change the description', async (x) => {
  if (x.rest.length > 2000) return x.reply('That is too long (2000 characters at most).');
  return x.run('setdesc', () => x.sock.groupUpdateDescription(x.chat, x.rest || undefined), '✅ Description updated.');
});
def('setrules', 'admin', 'Group', 'text - save the rules', async (x) => {
  if (!x.rest) return x.reply(`Use ${x.p}setrules followed by the rules.`);
  x.store.set(x.chat, 'rules', x.rest);
  return x.reply('✅ Rules saved. Members can see them with .rules');
});
def('requests', 'admin', 'Group', 'people waiting to join', async (x) => {
  let list = [];
  const ok = await x.guard.queue.run('requests', async () => { list = await x.sock.groupRequestParticipantsList(x.chat); });
  if (!ok) return x.reply(NOT_ADMIN);
  if (!list.length) return x.reply('Nobody is waiting to join.');
  const who = list.map((r) => ids.normalize(r.phone_number || r.jid)).filter(Boolean);
  return x.reply(`🚪 *Waiting to join* (${list.length})\n${who.map(at).join('\n')}\n\n${x.p}approve all · ${x.p}reject all · or add a number`, { mentions: who });
});
for (const action of ['approve', 'reject']) {
  def(action, 'admin', 'Group', `all or number - ${action} join requests`, async (x) => {
    let list = [];
    const ok = await x.guard.queue.run('requests', async () => { list = await x.sock.groupRequestParticipantsList(x.chat); });
    if (!ok) return x.reply(NOT_ADMIN);
    const n = x.rest.replace(/[^0-9]/g, '');
    const pick = x.arg === 'all' ? list : list.filter((r) => n && `${r.phone_number || ''}${r.jid || ''}`.includes(n));
    if (!pick.length) return x.reply(`Nobody matched. Use ${x.p}${action} all or ${x.p}${action} 2348012345678`);
    return x.run(action, () => x.sock.groupRequestParticipantsUpdate(x.chat, pick.map((r) => r.jid), action), `✅ ${action === 'approve' ? 'Approved' : 'Rejected'} ${pick.length}.`);
  });
}
def('active', 'admin', 'Group', 'who talks the most', async (x) => {
  const { since, counts } = x.store.activity(x.chat);
  const top = x.meta.participants.map((p) => [ids.normalize(p.id), (counts[ids.normalize(p.id)] || {}).n || 0])
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!top.length) return x.reply('No messages counted yet.');
  return x.reply(`📊 *Most active* since ${new Date(since).toDateString()}\n${top.map(([j, n], i) => `${i + 1}. ${at(j)} - ${n}`).join('\n')}`, { mentions: top.map(([j]) => j) });
});
def('inactive', 'admin', 'Group', 'who has not said anything', async (x) => {
  const { since, counts } = x.store.activity(x.chat);
  const quiet = x.meta.participants.filter((p) => !p.admin && !(counts[ids.normalize(p.id)] || {}).n).map((p) => ids.normalize(p.id))
    .filter((j) => !ids.overlaps([j], ids.selfIds(x.sock)));
  if (!quiet.length) return x.reply('Everyone has said something.');
  return x.reply(`💤 *Silent* since ${new Date(since).toDateString()} (${quiet.length})\n${quiet.slice(0, 50).map(at).join('\n')}${quiet.length > 50 ? '\n…' : ''}`, { mentions: quiet.slice(0, 50) });
});
def('poll', 'admin', 'Group', 'Question | option | option', async (x) => {
  const [q, ...opts] = x.rest.split('|').map((v) => v.trim()).filter(Boolean);
  if (!q || opts.length < 2 || opts.length > 12) return x.reply(`Use ${x.p}poll Question | Option 1 | Option 2 (2 to 12 options)`);
  await x.guard.sendContent(x.chat, { poll: { name: q.slice(0, 250), values: opts.map((o) => o.slice(0, 100)), selectableCount: 1 } });
});

// ------------------------------------------------------------------ owner

def('access', 'owner', 'Owner', 'owner / admins - who can command me', async (x) => {
  if (!x.store.setGlobal('access', x.arg)) return x.reply(`Use ${x.p}access owner (only you) or ${x.p}access admins (you and group admins). Now: ${x.store.state.access}`);
  return x.reply(x.arg === 'owner' ? '🔐 Only the owner can command me now. Everyone else gets a warning.' : '🔓 Group admins can use my group commands too.');
}, { group: false });
for (const [name, add] of [['addowner', true], ['delowner', false]]) {
  def(name, 'owner', 'Owner', `number - ${add ? 'add' : 'remove'} a co-owner`, async (x) => {
    const t = target(x.msg, x.args, x.meta);
    const phone = t && ids.phoneOf(t.ids);
    if (!phone) return x.reply(`Use ${x.p}${name} 2348012345678 (their number, not a tag, if their number is hidden).`);
    const now = x.store.state.owners;
    x.store.setGlobal('owners', add ? [...now, phone] : now.filter((n) => n !== phone));
    return x.reply(add ? `👑 +${phone} is now an owner.` : `+${phone} is no longer an owner.`);
  }, { group: false });
}
def('owners', 'owner', 'Owner', 'list owners', async (x) => {
  const list = x.guard.ownerNumbers();
  await x.reply(`👑 *Owners*\nThe linked number${list.length ? `\n${list.map((n) => `+${n}`).join('\n')}` : ''}`);
}, { group: false });
for (const [name, add] of [['trust', true], ['untrust', false]]) {
  def(name, 'owner', 'Owner', add ? 'never moderate this person' : 'moderate this person again', async (x) => {
    const t = target(x.msg, x.args, x.meta);
    if (!t) return x.reply(NEED_TARGET);
    if (add) x.store.whitelist(t.ids);
    else x.store.unwhitelist(t.ids);
    return x.reply(add ? '✅ Trusted. I will not moderate them.' : '✅ No longer trusted.');
  }, { group: false });
}
def('trusted', 'owner', 'Owner', 'list trusted people', async (x) => {
  const list = x.store.state.whitelist;
  await x.reply(list.length ? list.map((i) => `• ${i.split('@')[0]}`).join('\n') : 'Nobody is trusted yet.');
}, { group: false });
def('timezone', 'owner', 'Owner', 'Africa/Lagos - for daily open/close', async (x) => {
  const tz = x.args[0] || '';
  if (!x.store.setGlobal('timezone', tz)) return x.reply(`Use ${x.p}timezone Africa/Lagos (a name like Europe/London). Now: ${x.store.state.timezone}`);
  return x.reply(`🌍 Time zone set to ${tz}.`);
}, { group: false });

// ------------------------------------------------------------------ dispatch

const BY_NAME = new Map();
for (const c of COMMANDS) for (const n of [c.name, ...c.aliases]) BY_NAME.set(n, c);

function parse(text, prefix) {
  const body = text.slice(prefix.length).trimStart();
  const word = (body.split(/\s+/)[0] || '').toLowerCase();
  return { word, rest: body.slice(word.length).trim() };
}

function find(text, prefix) {
  if (!text.startsWith(prefix)) return null;
  const { word } = parse(text, prefix);
  return /^[a-z]{2,15}$/.test(word) ? BY_NAME.get(word) || null : null;
}

function allowed(cmd, { owner, admin, access }) {
  if (cmd.level === 'public' || owner) return true;
  return cmd.level === 'admin' && access === 'admins' && !!admin;
}

function menu(x) {
  const lines = [`🛡️ *${x.guard.config.botName}*`, `_${x.owner ? 'Owner' : 'Admin'} menu. Reply to a person, tag them or add their number where needed._`];
  let cat = '';
  for (const c of COMMANDS) {
    if (!allowed(c, { owner: x.owner, admin: x.admin, access: x.store.state.access }) || (!x.group && c.group)) continue;
    if (c.category !== cat) {
      cat = c.category;
      lines.push('', `*${cat}*`);
    }
    // "on/off - what it does" reads as arguments; a plain phrase is a description.
    lines.push(c.usage.includes(' - ') ? `${x.p}${c.name} ${c.usage}` : `${x.p}${c.name} - ${c.usage}`);
  }
  if (!x.group) lines.push('', '_Group commands appear when you use .menu inside a group._');
  return lines.join('\n');
}

async function handle(c) {
  const { guard, msg, chat, group, text, cmd } = c;
  const p = guard.config.prefix;
  const { rest } = parse(text, p);
  const args = rest ? rest.split(/\s+/) : [];
  const x = {
    ...c,
    p, rest, args,
    arg: (args[0] || '').toLowerCase(),
    store: guard.store,
    sock: guard.sock,
    s: group ? guard.store.settings(chat) : {},
    reply: (t, extra = {}) => guard.send(chat, t, { quoted: msg, ...extra }),
    run: async (name, fn, ok, extra) => x.reply((await guard.queue.run(name, fn)) ? ok : NOT_ADMIN, extra)
  };
  if (cmd.group && !group) return x.reply(`Use ${p}${cmd.name} inside the group.`);
  // Commands that act on members or settings work from fresh facts.
  if (group && cmd.level !== 'public') x.meta = (await guard.meta(chat, true)) || c.meta;
  if (group && !x.meta) return x.reply('I could not read this group. Try again in a moment.');
  // Someone demoted a moment ago loses admin commands at once.
  if (group && !c.owner && cmd.level === 'admin' && !ids.isAdmin(x.meta, c.sender)) return x.reply('⛔ Only the owner can command me.');
  await cmd.run(x);
  return true;
}

module.exports = { handle, find, allowed, target, menu, COMMANDS };
