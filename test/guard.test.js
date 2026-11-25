'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Guard, ActionQueue } = require('../src/guard');
const { Store } = require('../src/store');
const commands = require('../src/commands');

const G = '120363000000000000@g.us';
const BOT = '2340000000001@s.whatsapp.net';
const ADMIN = '2340000000002@s.whatsapp.net';
const MEMBER = '2340000000003@s.whatsapp.net';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const PAYLOAD = '​'.repeat(4000);
let seq = 0;

function setup({ botAdmin = true, owners = [], config = {}, lid = false } = {}) {
  const calls = { deletes: [], texts: [], kicks: [], chatModify: [], settings: [], parts: [], blocks: [] };
  const mem = new Map();
  const store = new Store({ get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) });
  const people = [
    lid ? { id: '900@lid', phoneNumber: BOT, admin: botAdmin ? 'admin' : null } : { id: BOT, admin: botAdmin ? 'admin' : null },
    lid ? { id: '901@lid', phoneNumber: ADMIN, admin: 'superadmin' } : { id: ADMIN, admin: 'superadmin' },
    lid ? { id: '902@lid', phoneNumber: MEMBER, admin: null } : { id: MEMBER, admin: null }
  ];
  const sock = {
    user: { id: '2340000000001:12@s.whatsapp.net', lid: '900:12@lid' },
    sendMessage: async (jid, c) => {
      if (c.delete) calls.deletes.push(c.delete.id);
      else calls.texts.push({ jid, ...c });
      return { key: { id: `OUT${++seq}` } };
    },
    chatModify: async (mod, jid) => calls.chatModify.push({ mod, jid }),
    groupParticipantsUpdate: async (jid, who, action) => {
      (action === 'remove' ? calls.kicks : calls.parts).push(who[0]);
      return [{ status: '200' }];
    },
    groupSettingUpdate: async (jid, s) => calls.settings.push(s),
    updateBlockStatus: async (jid) => calls.blocks.push(jid),
    groupMetadata: async () => ({ id: G, subject: 'Test', announce: false, participants: people })
  };
  const guard = new Guard({
    sock, store, logger: quiet, commands,
    queue: new ActionQueue(quiet, { gapMs: 0 }),
    config: { botName: 'GroupShield', prefix: '.', owners, dryRun: false, blockAttackers: false, thresholds: {}, ...config }
  });
  const send = (message, from = MEMBER, opts = {}) => guard.inspect({
    key: { remoteJid: opts.chat || G, participant: from, id: opts.id || `M${++seq}`, fromMe: !!opts.fromMe, ...opts.key },
    messageTimestamp: opts.ts ?? Math.floor(Date.now() / 1000),
    message: typeof message === 'string' ? { conversation: message } : message
  }, opts.type || 'notify');
  return { guard, store, sock, calls, send, people };
}

test('normal conversation is left alone', async () => {
  const { send, calls } = setup();
  for (const t of ['hello all', 'How are you?', 'see you at 5.30', 'Price is 2.000']) await send(t);
  assert.deepEqual([calls.deletes, calls.kicks, calls.texts], [[], [], []]);
});

test('bug message: deleted for everyone, sender removed and banned', async () => {
  const { send, calls, store } = setup();
  await send(PAYLOAD, MEMBER, { id: 'BUG1' });
  assert.deepEqual(calls.deletes, ['BUG1']);
  assert.deepEqual(calls.kicks, [MEMBER]);
  assert.ok(store.isBanned(G, [MEMBER]));
  assert.equal(store.state.incidents[0].type, 'bug');
});

test('delete-for-me removes one message and never clears the chat', async () => {
  const { send, calls } = setup();
  await send(PAYLOAD, MEMBER, { id: 'BUG1' });
  assert.equal(calls.chatModify.length, 1);
  assert.equal(calls.chatModify[0].mod.deleteForMe.key.id, 'BUG1');
  assert.ok(!('clear' in calls.chatModify[0].mod));
});

test('a payload that starts with the command prefix is still caught', async () => {
  const { send, calls } = setup();
  await send(`.help ${PAYLOAD}`);
  assert.equal(calls.deletes.length, 1);
});

test('editing a clean message into a payload is caught', async () => {
  const { send, calls } = setup();
  await send({ protocolMessage: { key: { id: 'ORIG' }, editedMessage: { conversation: PAYLOAD } } });
  assert.deepEqual(calls.deletes, ['ORIG']);
});

test('works when the group uses private @lid ids', async () => {
  const { send, calls, store } = setup({ lid: true });
  await send(PAYLOAD, '902@lid', { id: 'L1', key: { participantAlt: MEMBER } });
  assert.deepEqual(calls.deletes, ['L1']);
  assert.deepEqual(calls.kicks, ['902@lid']);
  assert.ok(store.isBanned(G, [MEMBER]), 'ban also covers the phone number');
  await send('.lock', '901@lid', { key: { participantAlt: ADMIN } });
  assert.deepEqual(calls.settings, ['announcement']);
});

test('without admin rights it alerts the owner and takes no group action', async () => {
  const { send, calls } = setup({ botAdmin: false, owners: ['2349999999999'] });
  await send(PAYLOAD);
  assert.deepEqual([calls.deletes, calls.kicks], [[], []]);
  assert.equal(calls.texts[0].jid, '2349999999999@s.whatsapp.net');
  assert.ok(!calls.texts[0].text.includes('​'), 'alert must not carry the payload');
});

test('an admin account that is compromised has its payload deleted but is not removed', async () => {
  const { send, calls } = setup();
  await send(PAYLOAD, ADMIN);
  assert.equal(calls.deletes.length, 1);
  assert.equal(calls.kicks.length, 0);
});

test('dry run never touches the group', async () => {
  const { send, calls, store } = setup({ config: { dryRun: true } });
  await send(PAYLOAD);
  await send('join https://chat.whatsapp.com/AAAABBBB');
  assert.deepEqual([calls.deletes, calls.kicks, calls.chatModify], [[], [], []]);
  assert.ok(!store.isBanned(G, [MEMBER]));
  assert.equal(store.warnings(G, [MEMBER]), 0);
});

test('links: invites blocked by default, hidden characters do not help, admins exempt', async () => {
  const { send, calls, store } = setup();
  await send('join chat.whatsapp.com/AbCdEf');
  await send('join chat.wh​atsapp.com/AbCdEf');
  await send({ ephemeralMessage: { message: { imageMessage: { caption: 'https://chat.whatsapp.com/x' } } } });
  assert.equal(calls.deletes.length, 3);
  assert.deepEqual(calls.kicks, [MEMBER], 'removed at the third warning');
  await send('join chat.whatsapp.com/AbCdEf', ADMIN);
  assert.equal(calls.deletes.length, 3);
  await send('see https://example.com');
  assert.equal(calls.deletes.length, 3);
  store.set(G, 'antilink', 'all');
  await send('see https://example.com');
  assert.equal(calls.deletes.length, 4);
});

test('flood: the whole burst is deleted and the sender is warned once', async () => {
  const { send, calls, store } = setup();
  for (let i = 0; i < 8; i++) await send(`msg ${i}`);
  assert.equal(calls.deletes.length, 8);
  assert.equal(store.warnings(G, [MEMBER]), 1);
});

test('the same long text four times is spam; short replies are not', async () => {
  const { send, calls } = setup();
  for (let i = 0; i < 4; i++) await send('ok');
  assert.equal(calls.deletes.length, 0);
  const other = '2340000000009@s.whatsapp.net';
  for (let i = 0; i < 4; i++) await send('Buy followers cheap today', other);
  assert.equal(calls.deletes.length, 4);
});

test('a replayed message is only handled once, and old backlog is not a flood', async () => {
  const { send, calls } = setup();
  await send('join chat.whatsapp.com/AbCdEf', MEMBER, { id: 'SAME' });
  await send('join chat.whatsapp.com/AbCdEf', MEMBER, { id: 'SAME' });
  assert.equal(calls.deletes.length, 1);
  for (let i = 0; i < 20; i++) await send(`old ${i}`, MEMBER, { ts: 1000, type: 'append' });
  assert.equal(calls.deletes.length, 1);
});

test('several attackers at once lock the group, and it reopens by itself', async () => {
  const { send, calls, store, guard } = setup();
  for (let i = 0; i < 3; i++) await send(PAYLOAD, `23480000000${i}@s.whatsapp.net`);
  assert.deepEqual(calls.settings, ['announcement']);
  assert.ok(store.isLocked(G));
  store.lockUntil(G, Date.now() - 1);
  await guard.releaseExpiredLocks();
  assert.deepEqual(calls.settings, ['announcement', 'not_announcement']);
});

test('mass joins lock the group; a banned member is removed again on join', async () => {
  const { guard, calls, store } = setup();
  store.ban(G, ['2348000000000@s.whatsapp.net']);
  await guard.onParticipants({ id: G, action: 'add', participants: [{ id: '2348000000000@s.whatsapp.net' }] });
  assert.deepEqual(calls.kicks, ['2348000000000@s.whatsapp.net']);
  await guard.onParticipants({ id: G, action: 'add', participants: Array.from({ length: 10 }, (_, i) => ({ id: `1${i}@s.whatsapp.net` })) });
  assert.deepEqual(calls.settings, ['announcement']);
});

test('commands: members refused, admins allowed, admins and bot protected', async () => {
  const { send, calls } = setup();
  await send('.lock');
  assert.deepEqual(calls.settings, []);
  await send('.antilink all', ADMIN);
  assert.match(calls.texts.at(-1).text, /antilink: all/);
  await send({ extendedTextMessage: { text: '.kick', contextInfo: { mentionedJid: [MEMBER] } } }, ADMIN);
  assert.deepEqual(calls.kicks, [MEMBER]);
  await send({ extendedTextMessage: { text: '.kick', contextInfo: { mentionedJid: [BOT] } } }, ADMIN);
  await send({ extendedTextMessage: { text: '.ban', contextInfo: { participant: ADMIN, stanzaId: 'x' } } }, ADMIN);
  assert.deepEqual(calls.kicks, [MEMBER]);
});

test('with no owner configured, strangers do not become the owner', async () => {
  const { send, store, guard } = setup();
  await send('.trust 2348111111111', MEMBER);
  await send('.trust 2348111111111', MEMBER, { chat: MEMBER });
  assert.deepEqual(store.state.whitelist, []);
  assert.equal(guard.isOwner([MEMBER]), false);
  await send('.trust 2348111111111', BOT, { fromMe: true });
  assert.deepEqual(store.state.whitelist, ['2348111111111@s.whatsapp.net']);
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
