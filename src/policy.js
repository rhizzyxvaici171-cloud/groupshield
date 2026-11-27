'use strict';

/** Pure group rules: links, floods, repeats, raids. No WhatsApp calls here. */

const { unwrap } = require('./detector');

const INVISIBLE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const INVITE = /(?:chat\.whatsapp\.com\/|wa\.me\/joinchat|whatsapp\.com\/channel\/|t\.me\/(?:\+|joinchat)|discord\.gg\/)/i;
const URL_RE = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63}){0,4}\.(?:com|net|org|info|biz|xyz|top|site|online|shop|store|club|live|link|click|vip|win|bet|io|co|me|ly|app|dev|gg|ru|cn|tk|ml|ga|cf|gq|ng|uk|in|za|ke|gh)(?:\/\S*)?(?![a-z0-9@-])/i;

function content(message) {
  return unwrap(message) || {};
}

/** all text a member can read in the message, invisible characters removed */
function visibleText(message) {
  const m = content(message);
  const parts = [
    m.conversation,
    m.extendedTextMessage && m.extendedTextMessage.text,
    m.imageMessage && m.imageMessage.caption,
    m.videoMessage && m.videoMessage.caption,
    m.documentMessage && m.documentMessage.caption,
    m.documentMessage && m.documentMessage.fileName,
    m.contactMessage && m.contactMessage.displayName,
    m.locationMessage && m.locationMessage.name,
    m.buttonsMessage && m.buttonsMessage.contentText,
    m.listMessage && m.listMessage.description,
    m.interactiveMessage && m.interactiveMessage.body && m.interactiveMessage.body.text
  ];
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3 || m.pollCreationMessageV5;
  if (poll) {
    parts.push(poll.name);
    for (const o of (poll.options || []).slice(0, 20)) parts.push(o && o.optionName);
  }
  return parts.filter((x) => typeof x === 'string').join('\n').slice(0, 20000).normalize('NFKC').replace(INVISIBLE, '');
}

/** text of a possible command: typed text only, never captions of other types */
function commandText(message) {
  const m = content(message);
  return (m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '').trim();
}

function contextInfo(message) {
  for (const v of Object.values(content(message))) {
    if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
  }
  return {};
}

function hasLink(message, mode) {
  if (mode === 'off') return false;
  if (content(message).groupInviteMessage) return true;
  // Posts forwarded from a channel are the usual way to advertise one.
  if (contextInfo(message).forwardedNewsletterMessageInfo) return true;
  const text = visibleText(message);
  return INVITE.test(text) || (mode === 'all' && URL_RE.test(text));
}

/** "this group was mentioned in a status" spam */
function isStatusTag(message) {
  return !!(message.groupStatusMentionMessage || content(message).groupStatusMentionMessage);
}

class FloodTracker {
  constructor() {
    this.users = new Map();
  }

  /**
   * @returns {null | {kind:string, keys:Array, warn:boolean}}
   *   keys: messages to delete (the whole burst the first time)
   */
  hit(groupJid, userId, key, text, s, now = Date.now()) {
    const id = `${groupJid}|${userId}`;
    const rec = this.users.get(id) || { hits: [], texts: [], over: 0 };
    const windowMs = s.floodSeconds * 1000;
    rec.hits = rec.hits.filter((h) => now - h.at < windowMs);
    rec.hits.push({ at: now, key });
    rec.texts = rec.texts.filter((t) => now - t.at < 60000);
    const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (norm.length >= 12) rec.texts.push({ at: now, norm, key });
    rec.seen = now;

    this.users.delete(id);
    this.users.set(id, rec);
    if (this.users.size > 2000) this.users.delete(this.users.keys().next().value);

    const same = rec.texts.filter((t) => t.norm === norm);
    const flood = rec.hits.length >= s.floodCount;
    const repeat = norm.length >= 12 && same.length >= 4;
    if (!flood && !repeat) {
      rec.over = 0;
      return null;
    }
    rec.over++;
    const keys = rec.over === 1 ? (flood ? rec.hits : same).map((h) => h.key) : [key];
    return { kind: flood ? 'flood' : 'repeat', keys, warn: rec.over % 3 === 1 };
  }
}

class RateWindow {
  constructor() {
    this.events = new Map();
  }

  /** record n events and return how many fall inside the window */
  add(id, n, windowMs, now = Date.now()) {
    const list = (this.events.get(id) || []).filter((t) => now - t < windowMs);
    for (let i = 0; i < Math.min(n, 1000); i++) list.push(now);
    this.events.set(id, list.slice(-1000));
    return list.length;
  }

  reset(id) {
    this.events.delete(id);
  }
}

module.exports = { content, visibleText, commandText, contextInfo, hasLink, isStatusTag, FloodTracker, RateWindow };
