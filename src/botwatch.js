'use strict';

/**
 * Spotting other bots and people commanding bots.
 *
 * A bot reply cannot be recognised from its id alone (bot libraries copy
 * WhatsApp Web's format), so the evidence is behavioural and adds up:
 *   - it quotes a command someone sent seconds ago        (strong)
 *   - it arrived within a few seconds of that command
 *   - its id has a shape only bot libraries produce
 *   - it looks like bot output (ad cards, channel forwards, buttons, menus)
 *   - the same account was caught answering commands before
 */

const policy = require('./policy');

const COMMAND = /^[.!#/$,?+\-][ ]?[a-z][a-z0-9_]{0,19}(?:\s|$)/i;
const WINDOW_MS = 20000;
const THRESHOLD = 3;

/** text that looks like a command for some bot */
function looksLikeCommand(text) {
  return typeof text === 'string' && text.length <= 300 && COMMAND.test(text.trim());
}

/** id formats produced by bot libraries rather than WhatsApp apps */
function botLikeId(id) {
  if (typeof id !== 'string') return false;
  return /^BAE5[0-9A-F]{12}$/.test(id) || /^3EB0[0-9A-F]{36}$/.test(id) || /^3EB0[0-9A-F]{18}$/.test(id);
}

function botLikeContent(message) {
  const m = policy.content(message);
  const ctx = policy.contextInfo(message);
  if (ctx.externalAdReply || ctx.forwardedNewsletterMessageInfo) return true;
  if (m.buttonsMessage || m.listMessage || m.templateMessage || m.interactiveMessage) return true;
  if ((ctx.forwardingScore || 0) >= 100) return true;
  const text = policy.visibleText(message);
  return text.length > 400 && text.split('\n').length > 10;
}

class BotWatch {
  constructor() {
    this.commands = new Map(); // group -> [{ id, sender, at, punished }]
  }

  /** remember a command so a reply to it can be matched later */
  noteCommand(group, msg, sender, punished = false, now = Date.now()) {
    const list = (this.commands.get(group) || []).filter((c) => now - c.at < WINDOW_MS);
    const entry = { id: msg.key.id, key: msg.key, sender, at: now, punished };
    list.push(entry);
    this.commands.set(group, list.slice(-30));
    if (this.commands.size > 500) this.commands.delete(this.commands.keys().next().value);
    return entry;
  }

  /**
   * Is this message a bot answering a command?
   * @returns {null | { command, score, selfBot }}
   */
  check(group, msg, sender, knownBot, now = Date.now()) {
    const list = (this.commands.get(group) || []).filter((c) => now - c.at < WINDOW_MS);
    if (!list.length) return null;
    const quoted = policy.contextInfo(msg.message).stanzaId;
    const target = (quoted && list.find((c) => c.id === quoted)) || null;
    // Without a quote, only the latest command from someone else can be the trigger.
    const command = target || [...list].reverse().find((c) => c.id !== msg.key.id && !c.sender.some((i) => sender.includes(i)));
    if (!command || command.id === msg.key.id) return null;

    let score = 0;
    if (target) score += 3;
    if (now - command.at < 5000) score += 1;
    if (botLikeId(msg.key.id)) score += 1;
    if (botLikeContent(msg.message)) score += 1;
    if (knownBot) score += 2;
    if (score < THRESHOLD) return null;
    return { command, score, selfBot: command.sender.some((i) => sender.includes(i)) };
  }

  forget(group, commandId) {
    const list = this.commands.get(group);
    if (list) this.commands.set(group, list.filter((c) => c.id !== commandId));
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** the first banned word found in the text, matched as a whole word */
function findWord(text, words) {
  if (!words || !words.length || !text) return null;
  const hay = text.toLowerCase();
  for (const w of words) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(w)}($|[^\\p{L}\\p{N}])`, 'u');
    if (re.test(hay)) return w;
  }
  return null;
}

module.exports = { BotWatch, looksLikeCommand, botLikeId, botLikeContent, findWord, WINDOW_MS };
