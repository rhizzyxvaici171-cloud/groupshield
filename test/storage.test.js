'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage, fileBackend, createStorage } = require('../src/storage');
const { createAuthState, clearAuth } = require('../src/auth-state');
const { cleanSetting } = require('../src/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gs-'));

test('values survive a restart and are unreadable on disk', async () => {
  const dir = tmp();
  const a = new Storage(fileBackend(dir), { secret: 'one' });
  await a.init();
  a.set('auth:session:1:2/3', 'top-secret-value');
  a.set('auth:session:1:2_3', 'different');
  await a.close();
  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('top-secret'));
  const b = new Storage(fileBackend(dir), { secret: 'one' });
  await b.init();
  assert.equal(b.get('auth:session:1:2/3'), 'top-secret-value');
  assert.equal(b.get('auth:session:1:2_3'), 'different');
});

test('a wrong or missing secret stops instead of overwriting the session', async () => {
  const dir = tmp();
  const a = new Storage(fileBackend(dir), { secret: 'one' });
  await a.init();
  a.set('k', 'v');
  await a.close();
  await assert.rejects(new Storage(fileBackend(dir), { secret: 'two' }).init(), /SESSION_SECRET/);
  await assert.rejects(new Storage(fileBackend(dir), {}).init(), /SESSION_SECRET/);
});

test('a failed write is kept and retried', async () => {
  let fail = true;
  const saved = new Map();
  const s = new Storage({
    init: async () => {}, loadAll: async () => [], close: async () => {},
    write: async (e) => { if (fail) throw new Error('down'); for (const [k, v] of e) saved.set(k, v); }
  });
  await s.init();
  s.set('a', '1');
  await assert.rejects(s.flush(), /down/);
  fail = false;
  await s.flush();
  assert.equal(saved.get('a'), '1');
  s.readOnly = true;
  s.set('a', '2');
  await s.close();
  assert.equal(saved.get('a'), '1', 'a replaced instance must not write');
});

test('a database needs a secret', () => {
  assert.throws(() => createStorage({ databaseUrl: 'postgres://x', sessionSecret: '' }), /SESSION_SECRET/);
});

test('WhatsApp login round-trips through storage', async () => {
  const baileys = await import('@whiskeysockets/baileys');
  const dir = tmp();
  const a = new Storage(fileBackend(dir), { secret: 's' });
  await a.init();
  const auth = createAuthState(a, baileys);
  await auth.saveCreds();
  await auth.state.keys.set({ session: { 'x.0': new Uint8Array([1, 2, 3]) }, 'app-state-sync-key': { K: { keyData: new Uint8Array([9]) } } });
  await a.close();

  const b = new Storage(fileBackend(dir), { secret: 's' });
  await b.init();
  const again = createAuthState(b, baileys);
  assert.deepEqual(Buffer.from(again.state.creds.noiseKey.public), Buffer.from(auth.state.creds.noiseKey.public));
  const got = await again.state.keys.get('session', ['x.0', 'nope']);
  assert.deepEqual([...got['x.0']], [1, 2, 3]);
  assert.equal(got.nope, null);
  await clearAuth(b);
  assert.equal(b.keys('auth:').length, 0);
  await b.close();
});

test('settings are validated', () => {
  assert.equal(cleanSetting('antilink', 'all'), 'all');
  assert.equal(cleanSetting('antilink', 'x'), undefined);
  assert.equal(cleanSetting('warnLimit', 0), undefined);
  assert.equal(cleanSetting('antibug', 'yes'), undefined);
  assert.equal(cleanSetting('__proto__', true), undefined);
  assert.equal(cleanSetting('constructor', true), undefined);
});
