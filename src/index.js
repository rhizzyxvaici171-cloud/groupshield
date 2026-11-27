#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const pino = require('pino');
const { loadConfig, loadDotEnv, digits } = require('./config');
const { createStorage } = require('./storage');
const { createAuthState, clearAuth } = require('./auth-state');
const { Store } = require('./store');
const { Guard, ActionQueue, withTimeout } = require('./guard');
const commands = require('./commands');
const { createWeb } = require('./web');
const ids = require('./ids');

loadDotEnv();
const config = loadConfig();
const logger = pino({ level: config.logLevel, base: undefined });

const app = {
  status: 'starting', // starting | scan | connecting | connected | replaced | banned
  qr: null,
  me: null,
  guard: null,
  sock: null,
  store: null,
  groups: [],
  lastError: '',
  startedAt: Date.now()
};

let baileys;
let storage;
let retries = 0;
let reconnectTimer = null;
let stopping = false;

function reconnectSoon(ms) {
  clearTimeout(reconnectTimer);
  if (!stopping) reconnectTimer = setTimeout(() => connect().catch(onConnectError), ms);
}

function onConnectError(e) {
  app.lastError = e.message;
  logger.error({ error: e.message }, 'connect failed');
  reconnectSoon(Math.min(60000, 2000 * 2 ** Math.min(retries++, 5)));
}

async function refreshGroups() {
  if (!app.sock || app.status !== 'connected') return;
  try {
    const all = await withTimeout(app.sock.groupFetchAllParticipating(), 20000);
    app.groups = Object.values(all).map((g) => ({
      id: g.id,
      name: g.subject || g.id,
      members: g.participants.length,
      botAdmin: ids.isBotAdmin(app.sock, g)
    })).sort((a, b) => Number(b.botAdmin) - Number(a.botAdmin) || a.name.localeCompare(b.name));
  } catch (e) {
    logger.warn({ error: e.message }, 'could not list groups');
  }
}

async function connect() {
  if (stopping) return;
  const { makeWASocket, makeCacheableSignalKeyStore, DisconnectReason, Browsers, fetchLatestBaileysVersion } = baileys;
  const auth = createAuthState(storage, baileys);
  const silent = pino({ level: 'silent' });

  let version;
  try {
    ({ version } = await withTimeout(fetchLatestBaileysVersion(), 8000));
  } catch {
    /* the version built into Baileys is used */
  }

  app.status = auth.state.creds.registered || auth.state.creds.me ? 'connecting' : 'scan';
  const sock = makeWASocket({
    ...(version ? { version } : {}),
    logger: silent,
    auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, silent) },
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    getMessage: async () => undefined
  });
  app.sock = sock;
  const guard = new Guard({ sock, config, store: app.store, logger, commands, queue: new ActionQueue(logger) });

  sock.ev.on('creds.update', (update) => {
    Object.assign(auth.state.creds, update);
    auth.saveCreds();
  });
  sock.ev.on('messages.upsert', (m) => guard.onMessages(m));
  sock.ev.on('group-participants.update', (u) => guard.onParticipants(u));
  sock.ev.on('groups.update', (u) => guard.onGroups(u));
  sock.ev.on('group.join-request', (r) => guard.onJoinRequest(r));

  sock.ev.on('connection.update', async (u) => {
    if (app.sock !== sock) return;
    if (u.qr) {
      app.status = 'scan';
      app.qr = u.qr;
    }
    if (u.connection === 'open') {
      retries = 0;
      app.status = 'connected';
      app.qr = null;
      app.lastError = '';
      app.guard = guard;
      app.me = ids.phoneOf(ids.selfIds(sock));
      logger.info('connected to WhatsApp');
      await refreshGroups();
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode || 0;
      app.guard = null;
      app.qr = null;
      logger.warn({ code }, 'connection closed');
      if (stopping) return;
      if (code === DisconnectReason.loggedOut) {
        app.lastError = 'The device was unlinked from WhatsApp. Link it again.';
        app.me = null;
        app.groups = [];
        await clearAuth(storage);
        return reconnectSoon(1500);
      }
      if (code === DisconnectReason.forbidden) {
        app.status = 'banned';
        app.lastError = 'WhatsApp refused this account (403). Check the account on the phone.';
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        // Another copy is running, for example during a redeploy. Fighting it
        // would corrupt the shared login, so this copy stops and stays quiet.
        app.status = 'replaced';
        app.lastError = 'Another copy of the bot took over this login.';
        storage.readOnly = true;
        return;
      }
      app.status = 'connecting';
      if (code === DisconnectReason.restartRequired) return reconnectSoon(500);
      reconnectSoon(Math.min(60000, 2000 * 2 ** Math.min(retries++, 5)));
    }
  });
}

async function requestPairingCode(phone) {
  const n = digits(phone);
  if (n.length < 8 || n.length > 15) throw new Error('Enter the number with its country code.');
  if (!app.sock || app.status !== 'scan') throw new Error('The bot is not waiting to be linked.');
  return withTimeout(app.sock.requestPairingCode(n), 20000);
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'stopping');
  clearTimeout(reconnectTimer);
  try {
    app.sock?.end(undefined);
  } catch {
    /* already closed */
  }
  await withTimeout(storage.close(), 10000).catch(() => {});
  process.exit(0);
}

async function main() {
  if (!config.adminPassword) {
    if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
      throw new Error('ADMIN_PASSWORD is required when the dashboard is reachable from other machines.');
    }
    config.adminPassword = crypto.randomBytes(9).toString('base64url');
    console.log(`\n  Dashboard password for this run: ${config.adminPassword}\n`);
  }
  storage = createStorage(config, logger);
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  const web = createWeb({ app, config, requestPairingCode, refreshGroups, logger });
  web.listen(config.port, config.host, () => logger.info(`dashboard on http://${config.host}:${config.port}`));

  baileys = await import('@whiskeysockets/baileys');
  if (config.startDelaySeconds) {
    logger.info({ seconds: config.startDelaySeconds }, 'waiting for any previous copy to stop');
    await new Promise((r) => setTimeout(r, config.startDelaySeconds * 1000));
  }
  if (stopping) return;
  await storage.init();
  app.store = new Store(storage);
  process.on('unhandledRejection', (e) => logger.error({ error: String(e?.message || e) }, 'unhandled rejection'));
  setInterval(() => {
    app.guard?.releaseExpiredLocks().catch((e) => logger.error({ error: e.message }, 'unlock failed'));
    app.guard?.runSchedules().catch((e) => logger.error({ error: e.message }, 'schedule failed'));
  }, 30000).unref();
  connect().catch(onConnectError);
}

main().catch((e) => {
  console.error(`Could not start: ${e.message}`);
  process.exit(1);
});
