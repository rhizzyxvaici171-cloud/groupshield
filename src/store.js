'use strict';

const { uniq } = require('./ids');

const GROUP_DEFAULTS = {
  enabled: true,
  antibug: true,
  antilink: 'invites', // off | invites | all
  antispam: true,
  antiraid: true,
  antitag: true,
  antibot: true,
  antiword: false,
  antifake: false,
  welcome: false,
  goodbye: false,
  rules: '',
  words: [],
  allowedCodes: '',
  autoClose: '',
  autoOpen: '',
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

const STRIKE_KINDS = ['rule', 'cmd'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return typeof tz === 'string' && tz.length > 0;
  } catch {
    return false;
  }
}

function cleanWords(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : null;
  if (!list) return undefined;
  return [...new Set(list.map((w) => String(w).trim().toLowerCase().normalize('NFKC')).filter((w) => w.length >= 2 && w.length <= 40))].slice(0, 200);
}

function cleanCodes(value) {
  if (typeof value !== 'string') return undefined;
  const codes = [...new Set(value.split(/[\s,]+/).map((c) => c.replace(/[^0-9]/g, '')).filter((c) => c.length >= 1 && c.length <= 4))];
  return codes.slice(0, 30).join(',');
}

/** a cleaned value, or undefined when the setting or value is not allowed */
function cleanSetting(name, value) {
  if (name === 'antilink') return ['off', 'invites', 'all'].includes(value) ? value : undefined;
  if (name === 'rules') return typeof value === 'string' ? value.slice(0, 2000) : undefined;
  if (name === 'words') return cleanWords(value);
  if (name === 'allowedCodes') return cleanCodes(value);
  if (name === 'autoClose' || name === 'autoOpen') return value === '' || TIME.test(value) ? value : undefined;
  if (Object.hasOwn(BOUNDS, name)) {
    const n = Number(value);
    const [lo, hi] = BOUNDS[name];
    return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
  }
  if (Object.hasOwn(GROUP_DEFAULTS, name)) return typeof value === 'boolean' ? value : undefined;
  return undefined;
}

/** settings that apply to the whole bot */
function cleanGlobal(name, value) {
  if (name === 'access') return ['owner', 'admins'].includes(value) ? value : undefined;
  if (name === 'timezone') return validTimezone(value) ? value : undefined;
  if (name === 'owners') {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : null;
    if (!list) return undefined;
    return [...new Set(list.map((n) => String(n).replace(/[^0-9]/g, '')).filter((n) => n.length >= 7 && n.length <= 15))].slice(0, 20);
  }
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
    this.state.owners ||= [];
    this.state.access ||= 'owner';
    this.state.timezone ||= 'UTC';
    this.state.groups ||= {};
    this.state.incidents ||= [];
    this.state.stats ||= { scanned: 0, bugs: 0, deleted: 0, warned: 0, kicked: 0, raids: 0, bots: 0, since: new Date().toISOString() };
  }

  save(urgent = false) {
    this.storage.set('app:state', JSON.stringify(this.state));
    if (urgent && this.storage.flushSoon) this.storage.flushSoon();
  }

  _group(jid) {
    const g = (this.state.groups[jid] ||= {});
    g.settings ||= {};
    g.strikes ||= {};
    for (const k of STRIKE_KINDS) g.strikes[k] ||= {};
    g.banned ||= [];
    g.muted ||= {};
    g.activity ||= {};
    g.bots ||= [];
    g.since ||= new Date().toISOString();
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

  setGlobal(name, value) {
    const v = cleanGlobal(name, value);
    if (v === undefined) return false;
    this.state[name] = v;
    this.save(true);
    return true;
  }

  // ---- strikes: separate counters per kind, matched on any id ----
  strike(jid, who, kind = 'rule') {
    const list = this._group(jid).strikes[kind];
    const n = Math.max(0, ...who.map((i) => list[i] || 0)) + 1;
    for (const i of who) list[i] = n;
    this.state.stats.warned++;
    this.save(true);
    return n;
  }

  strikes(jid, who, kind = 'rule') {
    const list = this._group(jid).strikes[kind];
    return Math.max(0, ...who.map((i) => list[i] || 0));
  }

  clearStrikes(jid, who, kinds = STRIKE_KINDS) {
    const g = this._group(jid);
    for (const k of kinds) for (const i of who) delete g.strikes[k][i];
    this.save(true);
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

  // ---- mute: every message deleted until the time passes ----
  mute(jid, who, minutes) {
    const g = this._group(jid);
    const until = Date.now() + minutes * 60000;
    for (const i of who) g.muted[i] = until;
    this.save(true);
  }

  unmute(jid, who) {
    const g = this._group(jid);
    const was = who.some((i) => g.muted[i]);
    for (const i of who) delete g.muted[i];
    this.save(true);
    return was;
  }

  isMuted(jid, who, now = Date.now()) {
    const g = this.state.groups[jid];
    if (!g || !g.muted) return false;
    return who.some((i) => g.muted[i] && g.muted[i] > now);
  }

  // ---- other bots seen in a group ----
  markBot(jid, who) {
    const g = this._group(jid);
    const seen = g.bots.some((i) => who.includes(i));
    g.bots = uniq([...g.bots, ...who]).slice(-200);
    this.save(true);
    return seen;
  }

  isKnownBot(jid, who) {
    const g = this.state.groups[jid];
    return !!g && (g.bots || []).some((i) => who.includes(i));
  }

  // ---- activity ----
  count(jid, id) {
    const g = this._group(jid);
    const a = (g.activity[id] ||= { n: 0, last: 0 });
    a.n++;
    a.last = Date.now();
    const keys = Object.keys(g.activity);
    if (keys.length > 3000) {
      keys.sort((x, y) => g.activity[x].last - g.activity[y].last);
      for (const k of keys.slice(0, 500)) delete g.activity[k];
    }
    this.save();
  }

  activity(jid) {
    const g = this._group(jid);
    return { since: g.since, counts: g.activity };
  }

  // ---- owners and trusted people (all groups) ----
  ownerNumbers(extra = []) {
    return [...new Set([...extra, ...this.state.owners])];
  }

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

  // ---- lock and schedule ----
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

  /** true once per day per group and event, so a schedule fires only once */
  claimSchedule(jid, what, day) {
    const g = this._group(jid);
    g.fired ||= {};
    if (g.fired[what] === day) return false;
    g.fired[what] = day;
    this.save(true);
    return true;
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

module.exports = { Store, GROUP_DEFAULTS, BOUNDS, cleanSetting, cleanGlobal, validTimezone };
