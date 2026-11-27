'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Guard, ActionQueue, localClock } = require('../src/guard');
const { Store } = require('../src/store');
const commands = require('../src/commands');

const G = '120363000000000000@g.us';
const BOT = '2340000000001@s.whatsapp.net';
const ADMIN = '2340000000002@s.whatsapp.net';
const MEMBER = '2340000000003@s.whatsapp.net';
const OWNER = '2349999999999@s.whatsapp.net';
const OTHER_BOT = '2340000000007@s.whatsapp.net';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const PAYLOAD = '​'.repeat(4000);
let seq = 0;

function setup({ botAdmin = true, config = {}, lid = false, access } = {}) {
  const calls = { deletes: [], texts: [], kicks: [], chatModify: [], settings: [], parts: [], rejects: [], polls: [] };
  const mem = new Map();
  const store = new Store({ get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) });
  if (access) store.setGlobal('access', access);
  const people = [
    lid ? { id: '900@lid', phoneNumber: BOT, admin: botAdmin ? 'admin' : null } : { id: BOT, admin: botAdmin ? 'admin' : null },
    lid ? { id: '901@lid', phoneNumber: ADMIN, admin: 'superadmin' } : { id: ADMIN, admin: 'superadmin' },
    lid ? { id: '902@lid', phoneNumber: MEMBER, admin: null } : { id: MEMBER, admin: null },
    { id: OWNER, admin: null },
    { id: OTHER_BOT, admin: null }
  ];
  const sock = {
    user: { id: '2340000000001:12@s.whatsapp.net', lid: '900:12@lid' },
    sendMessage: async (jid, c) => {
      if (c.delete) calls.deletes.push(c.delete.id);
      else if (c.poll) calls.polls.push(c.poll);
      else calls.texts.push({ jid, ...c });
      return { key: { id: `OUT${++seq}` } };
    },
    chatModify: async (mod, jid) => calls.chatModify.push({ mod, jid }),
    groupParticipantsUpdate: async (jid, who, action) => {
      (action === 'remove' ? calls.kicks : calls.parts).push(who[0]);
      return [{ status: '200' }];
    },
    groupSettingUpdate: async (jid, s) => calls.settings.push(s),
    groupRequestParticipantsUpdate: async (jid, who, action) => calls.rejects.push([who[0], action]),
    groupRequestParticipantsList: async () => [{ jid: '5@lid', phone_number: '2348111111111@s.whatsapp.net' }],
    updateBlockStatus: async () => {},
    groupMetadata: async () => ({ id: G, subject: 'Test', announce: false, participants: people })
  };
  const guard = new Guard({
    sock, store, logger: quiet, commands,
    queue: new ActionQueue(quiet, { gapMs: 0 }),
    config: { botName: 'GroupShield', prefix: '.', owners: ['2349999999999'], dryRun: false, blockAttackers: false, thresholds: {}, ...config }
  });
  const send = (message, from = MEMBER, opts = {}) => guard.inspect({
    key: { remoteJid: opts.chat || G, participant: from, id: opts.id || `M${++seq}`, fromMe: !!opts.fromMe, ...opts.key },
    messageTimestamp: opts.ts ?? Math.floor(Date.now() / 1000),
    message: typeof message === 'string' ? { conversation: message } : message
  }, opts.type || 'notify');
  const lastText = () => (calls.texts.at(-1) || {}).text || '';
  return { guard, store, sock, calls, send, lastText };
}

// ------------------------------------------------------------------ protection

test('normal conversation is left alone', async () => {
  const { send, calls } = setup();
  for (const t of ['hello all', 'How are you?', 'see you at 5.30', 'Price is 2.000', '...ok', '. lol']) await send(t);
  assert.deepEqual([calls.deletes, calls.kicks, calls.texts], [[], [], []]);
});

test('bug message: deleted for everyone, sender removed and banned', async () => {
  const { send, calls, store } = setup();
  await send(PAYLOAD, MEMBER, { id: 'BUG1' });
  assert.deepEqual(calls.deletes, ['BUG1']);
  assert.deepEqual(calls.kicks, [MEMBER]);
  assert.ok(store.isBanned(G, [MEMBER]));
});

test('delete-for-me removes one message and never clears the chat', async () => {
  const { send, calls } = setup();
  await send(PAYLOAD, MEMBER, { id: 'BUG1' });
  assert.equal(calls.chatModify[0].mod.deleteForMe.key.id, 'BUG1');
  assert.ok(!('clear' in calls.chatModify[0].mod));
});

test('a payload that starts with the command prefix is still caught', async () => {
  const { send, calls } = setup();
  await send(`.menu ${PAYLOAD}`);
  assert.equal(calls.deletes.length, 1);
});

test('editing a message into a payload deletes the original', async () => {
  const { send, calls } = setup();
  await send({ protocolMessage: { key: { id: 'ORIG' }, editedMessage: { conversation: PAYLOAD } } });
  assert.deepEqual(calls.deletes, ['ORIG']);
});

test('works when the group uses private @lid ids', async () => {
  const { send, calls, store } = setup({ lid: true, access: 'admins' });
  await send(PAYLOAD, '902@lid', { id: 'L1', key: { participantAlt: MEMBER } });
  assert.deepEqual(calls.kicks, ['902@lid']);
  assert.ok(store.isBanned(G, [MEMBER]), 'ban also covers the phone number');
  await send('.lock', '901@lid', { key: { participantAlt: ADMIN } });
  assert.deepEqual(calls.settings, ['announcement']);
});

test('without admin rights it alerts the owner and takes no group action', async () => {
  const { send, calls } = setup({ botAdmin: false });
  await send(PAYLOAD);
  assert.deepEqual([calls.deletes, calls.kicks], [[], []]);
  assert.equal(calls.texts[0].jid, OWNER);
  assert.ok(!calls.texts[0].text.includes('​'), 'alert must not carry the payload');
});

test('dry run never touches the group', async () => {
  const { send, calls, store } = setup({ config: { dryRun: true } });
  await send(PAYLOAD);
  await send('join https://chat.whatsapp.com/AAAABBBB');
  await send('.kick');
  assert.deepEqual([calls.deletes, calls.kicks, calls.chatModify], [[], [], []]);
  assert.equal(store.strikes(G, [MEMBER], 'rule'), 0);
});

test('links, channel promotions and hidden characters; admins exempt', async () => {
  const { send, calls, store } = setup();
  await send('join chat.whatsapp.com/AbCdEf');
  await send('join chat.wh​atsapp.com/AbCdEf');
  await send({ extendedTextMessage: { text: 'new post!', contextInfo: { forwardedNewsletterMessageInfo: { newsletterJid: '1@newsletter' } } } });
  assert.equal(calls.deletes.length, 3);
  assert.deepEqual(calls.kicks, [MEMBER], 'removed at the third warning');
  await send('join chat.whatsapp.com/AbCdEf', ADMIN);
  await send('see https://example.com', '2340000000009@s.whatsapp.net');
  assert.equal(calls.deletes.length, 3);
  store.set(G, 'antilink', 'all');
  await send('see https://example.com', '2340000000009@s.whatsapp.net');
  assert.equal(calls.deletes.length, 4);
});

test('flood: the whole burst is deleted and the sender is warned once', async () => {
  const { send, calls, store } = setup();
  for (let i = 0; i < 8; i++) await send(`msg ${i}`);
  assert.equal(calls.deletes.length, 8);
  assert.equal(store.strikes(G, [MEMBER], 'rule'), 1);
});

test('replayed messages count once; old backlog is not a flood', async () => {
  const { send, calls } = setup();
  await send('join chat.whatsapp.com/AbCdEf', MEMBER, { id: 'SAME' });
  await send('join chat.whatsapp.com/AbCdEf', MEMBER, { id: 'SAME' });
  for (let i = 0; i < 20; i++) await send(`old ${i}`, MEMBER, { ts: 1000, type: 'append' });
  assert.equal(calls.deletes.length, 1);
});

test('several attackers lock the group, and it reopens by itself', async () => {
  const { send, calls, store, guard } = setup();
  for (let i = 0; i < 3; i++) await send(PAYLOAD, `23480000000${i}@s.whatsapp.net`);
  assert.deepEqual(calls.settings, ['announcement']);
  store.lockUntil(G, Date.now() - 1);
  await guard.releaseExpiredLocks();
  assert.deepEqual(calls.settings, ['announcement', 'not_announcement']);
});

test('mass joins lock the group; banned and foreign numbers are removed on join', async () => {
  const { guard, calls, store } = setup();
  store.ban(G, ['2348000000000@s.whatsapp.net']);
  store.set(G, 'allowedCodes', '234');
  store.set(G, 'antifake', true);
  await guard.onParticipants({ id: G, action: 'add', participants: [{ id: '2348000000000@s.whatsapp.net' }, { id: '917000000000@s.whatsapp.net' }, { id: '2347000000000@s.whatsapp.net' }] });
  assert.deepEqual(calls.kicks, ['2348000000000@s.whatsapp.net', '917000000000@s.whatsapp.net']);
  await guard.onParticipants({ id: G, action: 'add', participants: Array.from({ length: 10 }, (_, i) => ({ id: `2341${i}@s.whatsapp.net` })) });
  assert.deepEqual(calls.settings, ['announcement']);
});

test('join requests from banned or foreign numbers are refused', async () => {
  const { guard, calls, store } = setup();
  store.set(G, 'allowedCodes', '234');
  store.set(G, 'antifake', true);
  await guard.onJoinRequest({ id: G, action: 'created', participant: '7@lid', participantPn: '447700900123@s.whatsapp.net' });
  await guard.onJoinRequest({ id: G, action: 'created', participant: '8@lid', participantPn: '2348011111111@s.whatsapp.net' });
  assert.deepEqual(calls.rejects, [['7@lid', 'reject']]);
});

// ------------------------------------------------------------------ who controls the bot

test('only the owner is obeyed by default', async () => {
  const { send, calls } = setup();
  await send('.lock', ADMIN);
  await send('.lock', MEMBER);
  assert.deepEqual(calls.settings, []);
  await send('.lock', OWNER);
  assert.deepEqual(calls.settings, ['announcement']);
  await send('.unlock', BOT, { fromMe: true });
  assert.deepEqual(calls.settings, ['announcement', 'not_announcement']);
});

test('members who try to command it are warned, then removed at the third try', async () => {
  const { send, calls, store, lastText } = setup();
  await send('.kick', MEMBER);
  assert.match(lastText(), /warning 1\/3: only the owner can command me/);
  await send('.menu', MEMBER);
  assert.match(lastText(), /warning 2\/3/);
  await send('.tagall', MEMBER);
  assert.deepEqual(calls.kicks, [MEMBER]);
  assert.match(lastText(), /removed after 3 warnings/);
  assert.equal(store.strikes(G, [MEMBER], 'cmd'), 0, 'counter resets after removal');
});

test('command strikes and rule strikes are counted separately', async () => {
  const { send, store } = setup();
  await send('join chat.whatsapp.com/AbCdEf');
  await send('join chat.whatsapp.com/AbCdEfG');
  await send('.menu');
  assert.equal(store.strikes(G, [MEMBER], 'rule'), 2);
  assert.equal(store.strikes(G, [MEMBER], 'cmd'), 1);
});

test('admins who try to command it are told off but never removed', async () => {
  const { send, calls, lastText } = setup();
  for (let i = 0; i < 4; i++) await send('.kick', ADMIN);
  assert.deepEqual(calls.kicks, []);
  assert.match(lastText(), /only the owner can command me/);
});

test('everyone may read the rules; unknown words are not commands', async () => {
  const { send, store, lastText } = setup();
  store.set(G, 'rules', 'Be kind');
  await send('.rules');
  assert.match(lastText(), /Be kind/);
  await send('.hello there');
  await send('.5 percent');
  assert.equal(store.strikes(G, [MEMBER], 'cmd'), 0);
});

test('with access set to admins, admins command it but not owner settings', async () => {
  const { send, calls, store } = setup({ access: 'admins' });
  await send('.lock', ADMIN);
  assert.deepEqual(calls.settings, ['announcement']);
  await send('.access admins', ADMIN);
  await send('.addowner 2348000000001', ADMIN);
  assert.deepEqual(store.state.owners, []);
  await send('.kick', ADMIN, { key: { participant: ADMIN } });
});

test('owner can add co-owners and change access; strangers cannot', async () => {
  const { send, store, guard } = setup();
  await send('.addowner 2348000000001', MEMBER);
  assert.deepEqual(store.state.owners, []);
  await send('.addowner 2348000000001', OWNER);
  assert.deepEqual(store.state.owners, ['2348000000001']);
  assert.ok(guard.isOwner(['2348000000001@s.whatsapp.net']));
  await send('.access admins', OWNER);
  assert.equal(store.state.access, 'admins');
  await send('.trust 2348111111111', MEMBER, { chat: MEMBER });
  assert.deepEqual(store.state.whitelist, []);
});

test('the owner cannot be kicked or warned through the bot', async () => {
  const { send, calls, store } = setup({ access: 'admins' });
  await send({ extendedTextMessage: { text: '.kick', contextInfo: { mentionedJid: [OWNER] } } }, ADMIN);
  await send({ extendedTextMessage: { text: '.kick', contextInfo: { mentionedJid: [BOT] } } }, ADMIN);
  await send({ extendedTextMessage: { text: '.warn', contextInfo: { participant: ADMIN, stanzaId: 'x' } } }, OWNER);
  assert.deepEqual(calls.kicks, []);
  assert.equal(store.strikes(G, [ADMIN]), 0);
  await send({ extendedTextMessage: { text: '.kick', contextInfo: { mentionedJid: [MEMBER] } } }, OWNER);
  assert.deepEqual(calls.kicks, [MEMBER]);
});

// ------------------------------------------------------------------ other bots

test('another bot answering a command: reply and command deleted, caller warned', async () => {
  const { send, calls, store } = setup();
  await send('.menu', MEMBER, { id: 'CMD1' });
  assert.equal(store.strikes(G, [MEMBER], 'cmd'), 1, 'commanding with our prefix is already a strike');
  await send('!song despacito', '2340000000005@s.whatsapp.net', { id: 'CMD2' });
  await send({ extendedTextMessage: { text: 'Here is your song', contextInfo: { stanzaId: 'CMD2', participant: '2340000000005@s.whatsapp.net' } } }, OTHER_BOT, { id: 'R1' });
  assert.ok(calls.deletes.includes('R1') && calls.deletes.includes('CMD2'));
  assert.equal(store.strikes(G, ['2340000000005@s.whatsapp.net'], 'cmd'), 1);
  assert.ok(store.isKnownBot(G, [OTHER_BOT]));
});

test('a reply to a command already punished does not count twice', async () => {
  const { send, store } = setup();
  await send('.menu', MEMBER, { id: 'CMD1' });
  await send({ extendedTextMessage: { text: 'MENU\n1. song', contextInfo: { stanzaId: 'CMD1' } } }, OTHER_BOT);
  assert.equal(store.strikes(G, [MEMBER], 'cmd'), 1);
});

test('a bot account is removed when caught twice, or at once with strong evidence', async () => {
  const { send, calls, store } = setup();
  await send('!menu', MEMBER, { id: 'C1' });
  await send({ extendedTextMessage: { text: 'menu', contextInfo: { stanzaId: 'C1' } } }, OTHER_BOT);
  assert.deepEqual(calls.kicks, []);
  await send('!ping', MEMBER, { id: 'C2' });
  await send({ extendedTextMessage: { text: 'pong', contextInfo: { stanzaId: 'C2' } } }, OTHER_BOT);
  assert.deepEqual(calls.kicks, [OTHER_BOT]);
  assert.ok(store.isBanned(G, [OTHER_BOT]));
  const strong = setup();
  await strong.send('#play', MEMBER, { id: 'C3' });
  await strong.send({ extendedTextMessage: { text: 'x', contextInfo: { stanzaId: 'C3', externalAdReply: { title: 'Bot' } } } }, OTHER_BOT, { id: '3EB0' + 'A'.repeat(18) });
  assert.deepEqual(strong.calls.kicks, [OTHER_BOT]);
});

test('a member running a bot on their own number is caught', async () => {
  const { send, calls, store } = setup();
  await send('$alive', MEMBER, { id: 'S1' });
  await send({ extendedTextMessage: { text: 'I am alive', contextInfo: { stanzaId: 'S1' } } }, MEMBER, { id: 'S2' });
  assert.ok(calls.deletes.includes('S2'));
  assert.equal(store.strikes(G, [MEMBER], 'cmd'), 1);
  assert.deepEqual(calls.kicks, [], 'warned, not removed on the first offence');
});

test('people quoting each other normally are not mistaken for bots', async () => {
  const { send, calls } = setup();
  await send('Who is coming tonight?', MEMBER, { id: 'Q1' });
  await send({ extendedTextMessage: { text: 'Me!', contextInfo: { stanzaId: 'Q1' } } }, OTHER_BOT);
  await send('!important meeting at 6', MEMBER, { id: 'Q2' });
  await new Promise((r) => setTimeout(r, 5));
  await send('ok see you', OTHER_BOT);
  assert.deepEqual(calls.deletes, []);
});

test('owner and trusted people may use their own bots', async () => {
  const { send, calls, store } = setup();
  store.whitelist([MEMBER]);
  await send('!menu', MEMBER, { id: 'T1' });
  await send({ extendedTextMessage: { text: 'menu', contextInfo: { stanzaId: 'T1' } } }, OTHER_BOT);
  await send('!menu', OWNER, { id: 'T2' });
  await send({ extendedTextMessage: { text: 'menu', contextInfo: { stanzaId: 'T2' } } }, OTHER_BOT);
  assert.deepEqual(calls.deletes, []);
});

// ------------------------------------------------------------------ group tools

test('banned words, mute, and the commands that manage them', async () => {
  const { send, calls, store } = setup();
  await send('.addword scam, idiot', OWNER);
  await send('you are an IDIOT');
  await send('idiotic is fine');
  assert.equal(calls.deletes.length, 1);
  await send({ extendedTextMessage: { text: '.mute 10', contextInfo: { mentionedJid: [MEMBER] } } }, OWNER);
  assert.ok(store.isMuted(G, [MEMBER]));
  await send('hello?');
  assert.equal(calls.deletes.length, 2);
  await send({ extendedTextMessage: { text: '.unmute', contextInfo: { mentionedJid: [MEMBER] } } }, OWNER);
  await send('hello again');
  assert.equal(calls.deletes.length, 2);
});

test('goodbye message and daily schedule', async () => {
  const { guard, calls, store, send } = setup();
  await send('.goodbye on', OWNER);
  await guard.onParticipants({ id: G, action: 'remove', participants: [{ id: MEMBER }] });
  assert.match(calls.texts.at(-1).text, /Goodbye @2340000000003/);
  await send('.autoclose 22:00', OWNER);
  store.setGlobal('timezone', 'UTC');
  await guard.runSchedules(new Date('2026-11-27T21:59:00Z'));
  assert.deepEqual(calls.settings, []);
  await guard.runSchedules(new Date('2026-11-27T22:01:00Z'));
  await guard.runSchedules(new Date('2026-11-27T22:02:00Z'));
  assert.deepEqual(calls.settings, ['announcement'], 'fires once a day');
  assert.equal(localClock('Africa/Lagos', new Date('2026-11-27T22:30:00Z')).minutes, 23 * 60 + 30);
});

test('owner tools: poll, hidetag, activity, join approvals, menu', async () => {
  const { send, calls, lastText } = setup();
  await send('hi');
  await send('hi again');
  await send('.poll Lunch? | Rice | Beans', OWNER);
  assert.deepEqual(calls.polls[0].values, ['Rice', 'Beans']);
  await send('.hidetag meeting now', OWNER);
  assert.equal(calls.texts.at(-1).mentions.length, 5);
  await send('.active', OWNER);
  assert.match(lastText(), /@2340000000003 - 2/);
  await send('.inactive', OWNER);
  assert.match(lastText(), /@2340000000007/);
  await send('.approve all', OWNER);
  assert.deepEqual(calls.rejects.at(-1), ['5@lid', 'approve']);
  await send('.menu', OWNER);
  assert.match(lastText(), /\.antibot on\/off/);
  assert.match(lastText(), /\.addowner/);
});

test('the bot ignores its own messages, status updates and channels', async () => {
  const { send, guard, calls } = setup();
  await guard.send(G, '.lock');
  const own = [...guard.sentIds][0];
  await send('.lock', BOT, { fromMe: true, id: own });
  await send(PAYLOAD, MEMBER, { chat: 'status@broadcast' });
  await send(PAYLOAD, MEMBER, { chat: '123@newsletter' });
  assert.deepEqual([calls.settings, calls.deletes], [[], []]);
});

test('an owner is recognised in groups that hide phone numbers', async () => {
  const { send, calls } = setup({ lid: true });
  calls.texts.length = 0;
  const owner = setup({ lid: true });
  owner.store.setGlobal('owners', ['2340000000003']);
  await owner.send('.lock', '902@lid');
  assert.deepEqual(owner.calls.settings, ['announcement'], 'matched through the member list');
  await send('.lock', '902@lid');
  assert.deepEqual(calls.settings, []);
});
