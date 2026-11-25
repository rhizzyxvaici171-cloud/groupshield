'use strict';

const { uniq } = require('./ids');

const GROUP_DEFAULTS = {
  enabled: true,
  antibug: true,
  antilink: 'invites', // off | invites | all
  antispam: true,
  antiraid: true,
  antitag: true,
  welcome: false,
  rules: '',
  warnLimit: 3,
  floodCount: 8,
  floodSeconds: 10,
  raidJoins: 10,
  raidSeconds: 60,
  lockMinutes: 10
};

const BOUNDS = {
  warnLimit: [1, 10], floodCount: [4, 50], floodSeconds: [3, 60],
  raidJoins: [3, 100], raidSeconds: [10, 600], lockMinutes: [1, 1440]
};

/** a cleaned value, or undefined when the setting or value is not allowed */
function cleanSetting(name, value) {
  if (name === 'antilink') return ['off', 'invites', 'all'].includes(value) ? value : undefined;
  if (name === 'rules') return typeof value === 'string' ? value.slice(0, 2000) : undefined;
  if (Object.hasOwn(BOUNDS, name)) {
    const n = Number(value);
    const [lo, hi] = BOUNDS[name];
    return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
  }
  if (Object.hasOwn(GROUP_DEFAULTS, name)) return typeof value === 'boolean' ? value : undefined;
  return undefined;
}

class Store {
  constructor(storage) {
    this.storage = storage;
    let saved = {};
    try {
      saved = JSON.parse(storage.get('app:state')) || {};
    } catch {
      /* first run */
    }
    this.state = saved;
    this.state.whitelist ||= [];
    this.state.groups ||= {};
    this.state.incidents ||= [];
    this.state.stats ||= { scanned: 0, bugs: 0, deleted: 0, warned: 0, kicked: 0, raids: 0, since: new Date().toISOString() };
  }

  save(urgent = false) {
    this.storage.set('app:state', JSON.stringify(this.state));
    if (urgent && this.storage.flushSoon) this.storage.flushSoon();
  }

  _group(jid) {
    const g = (this.state.groups[jid] ||= {});
    g.settings ||= {};
    g.warnings ||= {};
    g.banned ||= [];
    return g;
  }

  settings(jid) {
    const g = this.state.groups[jid];
    return { ...GROUP_DEFAULTS, ...((g && g.settings) || {}) };
  }

  set(jid, name, value) {
    const v = cleanSetting(name, value);
    if (v === undefined) return false;
    this._group(jid).settings[name] = v;
    this.save(true);
    return true;
  }

  // ---- warnings: matched on any id the member is known by ----
  warn(jid, who) {
    const g = this._group(jid);
    const n = Math.max(0, ...who.map((i) => g.warnings[i] || 0)) + 1;
    for (const i of who) g.warnings[i] = n;
    this.state.stats.warned++;
    this.save();
    return n;
  }

  warnings(jid, who) {
    const g = this._group(jid);
    return Math.max(0, ...who.map((i) => g.warnings[i] || 0));
  }

  clearWarnings(jid, who) {
    const g = this._group(jid);
    for (const i of who) delete g.warnings[i];
    this.save();
  }

  // ---- bans ----
  ban(jid, who) {
    const g = this._group(jid);
    g.banned = uniq([...g.banned, ...who]).slice(-1000);
    this.save(true);
  }

  unban(jid, who) {
    const g = this._group(jid);
    const before = g.banned.length;
    g.banned = g.banned.filter((i) => !who.includes(i));
    this.save(true);
    return g.banned.length !== before;
  }

  isBanned(jid, who) {
    const g = this.state.groups[jid];
    return !!g && (g.banned || []).some((i) => who.includes(i));
  }

  // ---- trusted people (owner only, all groups) ----
  isWhitelisted(who) {
    return this.state.whitelist.some((i) => who.includes(i));
  }

  whitelist(who) {
    this.state.whitelist = uniq([...this.state.whitelist, ...who]);
    this.save(true);
  }

  unwhitelist(who) {
    this.state.whitelist = this.state.whitelist.filter((i) => !who.includes(i));
    this.save(true);
  }

  // ---- raid lock ----
  lockUntil(jid, ts) {
    const g = this._group(jid);
    if (ts) g.lockedUntil = ts;
    else delete g.lockedUntil;
    this.save(true);
  }

  expiredLocks(now = Date.now()) {
    return Object.entries(this.state.groups).filter(([, g]) => g.lockedUntil && g.lockedUntil <= now).map(([j]) => j);
  }

  isLocked(jid) {
    const g = this.state.groups[jid];
    return !!(g && g.lockedUntil);
  }

  // ---- counters and history ----
  bump(name, n = 1) {
    this.state.stats[name] = (this.state.stats[name] || 0) + n;
    this.save();
  }

  incident(entry) {
    this.state.incidents.unshift({ at: new Date().toISOString(), ...entry });
    this.state.incidents.length = Math.min(this.state.incidents.length, 100);
    this.save();
  }
}

module.exports = { Store, GROUP_DEFAULTS, BOUNDS, cleanSetting };
