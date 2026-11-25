'use strict';

// Every sample is synthesised from ordinary characters. No real payloads.
const test = require('node:test');
const assert = require('node:assert');
const { analyzeMessage, unwrap } = require('../src/detector');

const severity = (m) => analyzeMessage(m).severity;
const bad = (m) => assert.ok(['high', 'critical'].includes(severity(m)), `expected high/critical, got ${severity(m)}`);
const flagged = (m) => assert.ok(analyzeMessage(m).flagged, 'expected flagged');
const ZW = '​';

test('ordinary writing in many scripts is never flagged', () => {
  const samples = {
    english: 'Good morning everyone, the meeting starts at noon. '.repeat(60),
    hindi: 'नमस्ते दुनिया, हम सब मिलकर काम करेंगे। '.repeat(60),
    persian: 'می‌خواهم این کتاب‌ها را بخوانم '.repeat(60),
    arabic: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ '.repeat(60),
    yoruba: 'Ẹ káàárọ̀ ọ̀rẹ́ mi '.repeat(100).normalize('NFD'),
    thai: 'สวัสดีครับ ที่นี่ '.repeat(80),
    sinhala: 'ආයුබෝවන්! මේක සාමාන්‍ය මැසේජ් එකක්. '.repeat(40),
    emoji: '👨‍👩‍👧‍👦❤️‍🔥👍🏽 '.repeat(60)
  };
  for (const [name, text] of Object.entries(samples)) {
    const r = analyzeMessage({ conversation: text });
    assert.equal(r.severity, 'none', `${name}: ${r.reasons.map((x) => x.code)}`);
  }
});

test('ordinary rich messages are never flagged', () => {
  const samples = [
    { extendedTextMessage: { text: 'ok', contextInfo: { quotedMessage: { conversation: 'previous' } } } },
    { contactMessage: { displayName: 'Ada', vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Ada\nTEL:+1\nEND:VCARD' } },
    { locationMessage: { degreesLatitude: 6.9, degreesLongitude: 79.8 } },
    { pollCreationMessageV3: { name: 'Lunch?', options: [{ optionName: 'A' }, { optionName: 'B' }] } },
    { imageMessage: { caption: 'look', jpegThumbnail: new Uint8Array(4000), fileLength: '123456' } },
    { viewOnceMessage: { message: { imageMessage: { caption: 'once' } } } }
  ];
  for (const m of samples) assert.equal(severity(m), 'none', JSON.stringify(m).slice(0, 60));
});

test('invisible, bidi and zalgo floods are caught', () => {
  bad({ conversation: ZW.repeat(3000) });
  bad({ conversation: '‮'.repeat(2000) });
  bad({ conversation: 'ㅤ'.repeat(2000) });
  bad({ conversation: 'a' + '́'.repeat(2000) });
  flagged({ conversation: 'hi\u0000there' });
});

test('joiner floods are not excused as natural text', () => {
  bad({ conversation: 'a‍'.repeat(4000) });
});

test('oversized and malformed structures are caught', () => {
  bad({ conversation: 'A'.repeat(70000) });
  flagged({ conversation: 'x\n'.repeat(900) });
  bad({ extendedTextMessage: { text: 'x', contextInfo: { mentionedJid: Array(500).fill('1@s.whatsapp.net') } } });
  bad({ contactsArrayMessage: { contacts: Array(100).fill({ displayName: 'c', vcard: 'BEGIN:VCARD\nEND:VCARD' }) } });
  flagged({ listMessage: { sections: [{ rows: Array(200).fill({ title: 'r' }) }] } });
  flagged({ carouselMessage: { cards: Array(50).fill({}) } });
  bad({ locationMessage: { degreesLatitude: 9999, degreesLongitude: 0 } });
  bad({ pollCreationMessage: { options: Array(80).fill({ optionName: 'x' }) } });
  let deep = { conversation: 'x' };
  for (let i = 0; i < 30; i++) deep = { viewOnceMessage: { message: deep } };
  flagged(deep);
});

test('wrapping a payload does not hide it', () => {
  const vcard = { contactMessage: { displayName: 'x', vcard: 'BEGIN:VCARD\nFN:' + 'ab'.repeat(5000) } };
  for (const w of ['ephemeralMessage', 'viewOnceMessageV2', 'groupMentionedMessage', 'documentWithCaptionMessage']) {
    bad({ [w]: { message: vcard } });
  }
  bad({ ephemeralMessage: { message: { locationMessage: { degreesLatitude: 999, degreesLongitude: 0 } } } });
  bad({ protocolMessage: { editedMessage: { conversation: ZW.repeat(3000) } } });
  bad({ imageMessage: { caption: 'x', contextInfo: { groupMentions: Array(200).fill({}) } } });
});

test('reasons never contain payload characters', () => {
  const r = analyzeMessage({ contactMessage: { vcard: 'BEGIN:VCARD\nF‮\u0000​' + 'A'.repeat(1000) } });
  assert.ok(r.reasons.length);
  for (const x of r.reasons) assert.match(x.detail, /^[\x20-\x7E]*$/);
});

test('hostile input cannot hang or crash the scanner', () => {
  for (const m of [null, undefined, {}, { contactsArrayMessage: { contacts: [null] } }]) analyzeMessage(m);
  const loop = { conversation: 'x' };
  loop.ephemeralMessage = { message: loop };
  analyzeMessage(loop);
  unwrap(loop);
  const t = Date.now();
  analyzeMessage({ conversation: 'á‍'.repeat(300000) });
  assert.ok(Date.now() - t < 3000);
});
