'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** minimal .env reader; real environment variables always win */
function loadDotEnv(file = path.join(ROOT, '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
}

function digits(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}

function parseThresholds(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    console.warn('THRESHOLDS is not valid JSON - using the defaults');
    return {};
  }
}

function loadConfig(env = process.env) {
  const yes = (v) => /^(1|true|yes)$/i.test(v || '');
  return {
    botName: env.BOT_NAME || 'GroupShield',
    prefix: env.PREFIX || '.',
    owners: String(env.OWNER_NUMBERS || '').split(',').map(digits).filter(Boolean),
    adminPassword: env.ADMIN_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
    databaseUrl: env.DATABASE_URL || '',
    dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
    port: Number(env.PORT) || 3000,
    host: env.HOST || (env.RENDER ? '0.0.0.0' : '127.0.0.1'),
    logLevel: env.LOG_LEVEL || 'info',
    dryRun: yes(env.DRY_RUN),
    blockAttackers: yes(env.BLOCK_ATTACKERS),
    // Free databases bill awake time, so a remote one is written in batches.
    flushSeconds: Number(env.FLUSH_SECONDS) || (env.DATABASE_URL ? 900 : 5),
    // On Render the old copy runs on for about a minute after a deploy.
    startDelaySeconds: Number(env.START_DELAY_SECONDS ?? (env.RENDER ? 90 : 0)) || 0,
    thresholds: parseThresholds(env.THRESHOLDS)
  };
}

module.exports = { loadConfig, loadDotEnv, digits, ROOT };
