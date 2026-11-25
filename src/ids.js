'use strict';

/**
 * WhatsApp now addresses people by phone number (@s.whatsapp.net) or by a
 * private id (@lid), depending on the group. Comparing only one form makes a
 * bot fail to recognise its own admins, so everything here compares sets.
 */

function normalize(jid) {
  if (typeof jid !== 'string' || !jid.includes('@')) return '';
  const [user, server] = jid.split('@');
  return `${user.split(':')[0].split('_')[0]}@${server === 'c.us' ? 's.whatsapp.net' : server}`;
}

function uniq(list) {
  return [...new Set(list.map(normalize).filter(Boolean))];
}

const isGroup = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');
const isDirect = (jid) => typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));

/** every known id of whoever sent this message */
function senderIds(key) {
  if (isGroup(key.remoteJid)) return uniq([key.participant, key.participantAlt]);
  return uniq([key.remoteJid, key.remoteJidAlt]);
}

function participantIds(p) {
  if (typeof p === 'string') return uniq([p]);
  return uniq([p && p.id, p && p.lid, p && p.phoneNumber]);
}

function selfIds(sock) {
  const u = (sock && sock.user) || {};
  return uniq([u.id, u.lid, u.phoneNumber]);
}

function overlaps(a, b) {
  return a.some((x) => b.includes(x));
}

function findParticipant(meta, ids) {
  if (!meta || !Array.isArray(meta.participants)) return null;
  return meta.participants.find((p) => overlaps(participantIds(p), ids)) || null;
}

function isAdmin(meta, ids) {
  const p = findParticipant(meta, ids);
  return !!p && (p.admin === 'admin' || p.admin === 'superadmin');
}

function isBotAdmin(sock, meta) {
  return isAdmin(meta, selfIds(sock));
}

function phoneOf(ids) {
  const pn = ids.find((i) => i.endsWith('@s.whatsapp.net'));
  return pn ? pn.split('@')[0] : '';
}

/** short label for logs and alerts */
function label(ids) {
  const pn = phoneOf(ids);
  return pn ? `+${pn}` : ids[0] || 'unknown';
}

module.exports = {
  normalize, uniq, isGroup, isDirect, senderIds, participantIds, selfIds,
  overlaps, findParticipant, isAdmin, isBotAdmin, phoneOf, label
};
