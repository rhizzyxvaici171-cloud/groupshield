'use strict';

/**
 * Key/value storage with an in-memory copy and batched writes.
 *
 *  - file backend:     one file per key, for running on your own machine
 *  - postgres backend: for free hosts whose disk is wiped on every restart
 *
 * The WhatsApp session is as good as the account itself, so with a
 * SESSION_SECRET every value is encrypted (AES-256-GCM) before it is written.
 */

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const SALT = 'groupshield.session.v1';

function createCipher(secret) {
  if (!secret) return { seal: (_k, v) => v, open: (_k, v) => v };
  const key = crypto.scryptSync(secret, SALT, 32);
  return {
    seal(name, text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(name));
      const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return `enc1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
    },
    open(name, stored) {
      if (!stored.startsWith('enc1:')) return stored;
      const raw = Buffer.from(stored.slice(5), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), { authTagLength: 16 });
      d.setAAD(Buffer.from(name));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    }
  };
}

function fileBackend(dir) {
  const fileFor = (key) => path.join(dir, `${Buffer.from(key).toString('hex')}.kv`);
  return {
    kind: 'file',
    async init() {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    },
    async loadAll() {
      const out = [];
      for (const name of await fsp.readdir(dir)) {
        if (!name.endsWith('.kv')) continue;
        out.push([Buffer.from(name.slice(0, -3), 'hex').toString(), await fsp.readFile(path.join(dir, name), 'utf8')]);
      }
      return out;
    },
    async write(entries) {
      for (const [key, value] of entries) {
        const f = fileFor(key);
        if (value === null) {
          await fsp.rm(f, { force: true });
        } else {
          await fsp.writeFile(`${f}.tmp`, value, { mode: 0o600 });
          await fsp.rename(`${f}.tmp`, f);
        }
      }
    },
    async close() {}
  };
}

/** TLS with certificate checks for every remote database, unless the URL says otherwise */
function sslFor(url) {
  const u = new URL(url);
  if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return undefined;
  return u.searchParams.has('sslmode') ? undefined : { rejectUnauthorized: true };
}

function postgresBackend(url, PoolClass) {
  const Pool = PoolClass || require('pg').Pool;
  const pool = new Pool({ connectionString: url, ssl: sslFor(url), max: 2, connectionTimeoutMillis: 15000, idleTimeoutMillis: 20000 });
  pool.on('error', () => { /* an idle connection dropping is normal; the next query reconnects */ });
  return {
    kind: 'postgres',
    async init() {
      await pool.query('CREATE TABLE IF NOT EXISTS groupshield_kv (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
      // Hosted Postgres may expose the public schema over HTTP; with row
      // security on and no policies, only the database owner can read it.
      await pool.query('ALTER TABLE groupshield_kv ENABLE ROW LEVEL SECURITY');
    },
    async loadAll() {
      const r = await pool.query('SELECT key, value FROM groupshield_kv');
      return r.rows.map((x) => [x.key, x.value]);
    },
    async write(entries) {
      const sets = entries.filter(([, v]) => v !== null);
      const dels = entries.filter(([, v]) => v === null).map(([k]) => k);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (dels.length) await client.query('DELETE FROM groupshield_kv WHERE key = ANY($1::text[])', [dels]);
        if (sets.length) {
          await client.query(
            `INSERT INTO groupshield_kv (key, value) SELECT * FROM unnest($1::text[], $2::text[])
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
            [sets.map(([k]) => k), sets.map(([, v]) => v)]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    }
  };
}

class Storage {
  constructor(backend, { secret = '', logger, flushMs = 5000 } = {}) {
    this.backend = backend;
    this.cipher = createCipher(secret);
    this.logger = logger;
    this.flushMs = flushMs;
    this.mem = new Map();
    this.dirty = new Set();
    this.timer = null;
    this.chain = Promise.resolve();
    this.readOnly = false;
  }

  async init() {
    await this.backend.init();
    for (const [key, stored] of await this.backend.loadAll()) {
      let value;
      try {
        value = this.cipher.open(key, stored);
      } catch {
        // Never silently replace a session we cannot read.
        throw new Error('Stored data cannot be decrypted. SESSION_SECRET differs from the one it was saved with.');
      }
      if (value.startsWith('enc1:')) throw new Error('Stored data is encrypted. Set SESSION_SECRET.');
      this.mem.set(key, value);
    }
  }

  get(key) {
    return this.mem.has(key) ? this.mem.get(key) : null;
  }

  keys(prefix) {
    return [...this.mem.keys()].filter((k) => k.startsWith(prefix));
  }

  /** for changes that must not wait for the next batch; groups quick edits together */
  flushSoon() {
    if (this.soon || this.readOnly) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      this.flush().catch(() => {});
    }, 2000);
    if (this.soon.unref) this.soon.unref();
  }

  set(key, value) {
    if (this.readOnly) return;
    if (value === null || value === undefined) this.mem.delete(key);
    else this.mem.set(key, value);
    this.dirty.add(key);
    this._schedule(this.flushMs);
  }

  _schedule(ms) {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush().catch(() => {}), ms);
    if (this.timer.unref) this.timer.unref();
  }

  /** writes run one after another so an older batch can never land last */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    this.chain = this.chain.catch(() => {}).then(() => this._flush());
    return this.chain;
  }

  async _flush() {
    if (!this.dirty.size || this.readOnly) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    const entries = keys.map((k) => [k, this.mem.has(k) ? this.cipher.seal(k, this.mem.get(k)) : null]);
    try {
      await this.backend.write(entries);
    } catch (e) {
      for (const k of keys) this.dirty.add(k);
      if (this.logger) this.logger.error({ error: e.message }, 'saving failed, will retry');
      this._schedule(15000);
      throw e;
    }
  }

  async close() {
    clearTimeout(this.soon);
    await this.flush().catch(() => {});
    clearTimeout(this.timer);
    await this.backend.close();
  }
}

function createStorage(config, logger) {
  if (config.databaseUrl) {
    if (!config.sessionSecret) throw new Error('SESSION_SECRET is required when DATABASE_URL is set.');
    return new Storage(postgresBackend(config.databaseUrl), { secret: config.sessionSecret, logger, flushMs: config.flushSeconds * 1000 });
  }
  return new Storage(fileBackend(config.dataDir), { secret: config.sessionSecret, logger, flushMs: config.flushSeconds * 1000 });
}

module.exports = { Storage, createStorage, fileBackend, postgresBackend, createCipher, sslFor };
