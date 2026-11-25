'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createWeb } = require('../src/web');
const { Store } = require('../src/store');

const G = '1@g.us';

async function setup(t) {
  const mem = new Map();
  const store = new Store({ get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) });
  const app = { status: 'scan', qr: 'abc', me: null, lastError: '', store, groups: [{ id: G, name: '<b>x</b>', members: 3, botAdmin: true }] };
  const server = createWeb({
    app, config: { botName: 'GroupShield', prefix: '.', adminPassword: 'pw', sessionSecret: 's', dryRun: false },
    requestPairingCode: async () => 'ABCD1234', refreshGroups: async () => {}, logger: { warn() {} }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const login = async () => (await post('/api/login', { password: 'pw' })).headers.get('set-cookie').split(';')[0];
  return { base, post, login, store };
}

test('nothing sensitive is readable without signing in', async (t) => {
  const { base, post } = await setup(t);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await post('/api/pair', { phone: '2348012345678' })).status, 401);
  assert.equal((await post('/api/group', { id: G, name: 'antibug', value: false })).status, 401);
  const forged = `gs=${Date.now() + 1e6}.AAAA`;
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: forged } })).status, 401);
  for (const p of ['/../src/config.js', '/%2e%2e/package.json', '/.env']) assert.equal((await fetch(base + p)).status, 404);
});

test('signing in works, cookie is hardened, guessing is limited', async (t) => {
  const { base, post } = await setup(t);
  const ok = await post('/api/login', { password: 'pw' });
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const s = await (await fetch(`${base}/api/state`, { headers: { cookie: ok.headers.get('set-cookie').split(';')[0] } })).json();
  assert.match(s.qr, /^data:image\/png/);
  for (let i = 0; i < 10; i++) assert.equal((await post('/api/login', { password: 'no' })).status, 401);
  assert.equal((await post('/api/login', { password: 'pw' })).status, 429);
});

test('settings are validated and form posts are refused', async (t) => {
  const { base, post, login, store } = await setup(t);
  const cookie = await login();
  assert.equal((await post('/api/group', { id: G, name: 'antilink', value: 'all' }, { cookie })).status, 200);
  assert.equal(store.settings(G).antilink, 'all');
  assert.equal((await post('/api/group', { id: G, name: 'warnLimit', value: 999 }, { cookie })).status, 400);
  assert.equal((await post('/api/group', { id: '2@g.us', name: 'antibug', value: false }, { cookie })).status, 400);
  assert.equal((await post('/api/group', { id: G, name: '__proto__', value: {} }, { cookie })).status, 400);
  const form = await fetch(`${base}/api/group`, { method: 'POST', headers: { cookie, 'Content-Type': 'text/plain' }, body: JSON.stringify({ id: G, name: 'antibug', value: false }) });
  assert.equal(form.status, 400);
  assert.equal(store.settings(G).antibug, true);
});
