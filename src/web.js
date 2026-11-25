'use strict';

/** Password-protected dashboard: link the bot, see incidents, change settings. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { GROUP_DEFAULTS, BOUNDS } = require('./store');

const PUBLIC = path.join(__dirname, '..', 'public');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex'
};
const SESSION_MS = 12 * 3600 * 1000;

function createWeb({ app, config, requestPairingCode, refreshGroups, logger }) {
  // Changing the password signs everyone out.
  const key = crypto.createHash('sha256').update(`cookie|${config.sessionSecret}|${config.adminPassword}`).digest();
  const sign = (s) => crypto.createHmac('sha256', key).update(s).digest('base64url');
  const same = (a, b) => {
    const h = (x) => crypto.createHash('sha256').update(String(x)).digest();
    return crypto.timingSafeEqual(h(a), h(b));
  };
  let failures = [];
  let lastPair = 0;

  function authed(req) {
    const m = /(?:^|;\s*)gs=(\d+)\.([\w-]+)/.exec(req.headers.cookie || '');
    return !!m && Number(m[1]) > Date.now() && same(sign(m[1]), m[2]);
  }

  function send(res, code, body, headers = {}) {
    const json = typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(code, { ...HEADERS, 'Content-Type': json ? 'application/json' : 'text/plain; charset=utf-8', ...headers });
    res.end(json ? JSON.stringify(body) : body);
  }

  function cookie(req, value, maxAge) {
    const https = req.headers['x-forwarded-proto'] === 'https';
    return `gs=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      // A JSON content type cannot be sent cross-site without a preflight.
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(new Error('JSON only'));
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 16384) {
          reject(new Error('Too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!v || typeof v !== 'object') throw new Error();
          resolve(v);
        } catch {
          reject(new Error('Bad JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  async function state() {
    if (!app.store) {
      return { name: config.botName, status: 'starting', dryRun: config.dryRun, error: app.lastError, qr: null, stats: {}, incidents: [], groups: [], bounds: BOUNDS };
    }
    return {
      name: config.botName,
      status: app.status,
      dryRun: config.dryRun,
      prefix: config.prefix,
      me: app.me,
      error: app.lastError,
      qr: app.qr ? await QRCode.toDataURL(app.qr, { margin: 1, width: 280 }) : null,
      stats: app.store.state.stats,
      incidents: app.store.state.incidents.slice(0, 50),
      groups: app.groups.map((g) => ({ ...g, settings: app.store.settings(g.id) })),
      bounds: BOUNDS
    };
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x').pathname;
    if (url === '/healthz') return send(res, 200, 'ok');
    if (req.method === 'GET' && Object.hasOwn(FILES, url)) {
      const [file, type] = FILES[url];
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, file)), { 'Content-Type': type });
    }
    if (url === '/api/login' && req.method === 'POST') {
      const now = Date.now();
      failures = failures.filter((t) => now - t < 15 * 60000);
      if (failures.length >= 10) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const { password } = await readJson(req);
      if (typeof password !== 'string' || !same(password, config.adminPassword)) {
        failures.push(now);
        return send(res, 401, { error: 'Wrong password.' });
      }
      failures = [];
      const exp = String(now + SESSION_MS);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, `${exp}.${sign(exp)}`, SESSION_MS / 1000) });
    }
    if (!url.startsWith('/api/')) return send(res, 404, 'Not found');
    if (!authed(req)) return send(res, 401, { error: 'Sign in first.' });

    if (url === '/api/state' && req.method === 'GET') return send(res, 200, await state());
    if (req.method !== 'POST') return send(res, 405, { error: 'Not allowed' });
    const body = await readJson(req);
    if (url === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    if (url === '/api/refresh') {
      await refreshGroups();
      return send(res, 200, { ok: true });
    }
    if (url === '/api/pair') {
      if (Date.now() - lastPair < 30000) return send(res, 429, { error: 'Wait 30 seconds before asking for another code.' });
      lastPair = Date.now();
      try {
        return send(res, 200, { code: await requestPairingCode(body.phone) });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (url === '/api/group' && app.store) {
      const { id, name, value } = body;
      if (!app.groups.some((g) => g.id === id) || !Object.hasOwn(GROUP_DEFAULTS, String(name))) return send(res, 400, { error: 'Unknown group or setting.' });
      if (!app.store.set(id, name, value)) return send(res, 400, { error: 'That value is not allowed.' });
      return send(res, 200, { settings: app.store.settings(id) });
    }
    return send(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      logger.warn({ error: e.message }, 'dashboard request failed');
      if (!res.headersSent) send(res, 400, { error: 'Bad request' });
      else res.end();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return server;
}

module.exports = { createWeb };
