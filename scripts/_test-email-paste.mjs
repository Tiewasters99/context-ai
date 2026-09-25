// "Paste an email" (migration 091's Thread tab): the parser that turns text
// copied out of a mail client into From / To / Cc / Date / Subject, a body,
// and the quoted history kept apart. Pure module, no DOM, no network.
//
//   node --test scripts/_test-email-paste.mjs
//
// Every fixture is synthetic. The mojibake fixtures are MADE the way the bug
// happens — real UTF-8 bytes read back as Windows-1252 — not typed by hand.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePastedEmail, parseEmailDate, repairMojibake } from '../lib/email-paste.mjs';
import { conversationCitation, senderName, citeDate } from '../lib/conversation-cite.mjs';

const mangle = (s) => new TextDecoder('windows-1252').decode(new TextEncoder().encode(s));

test('Gmail forward: the note, the forwarded headers, the body, and the quote kept apart', () => {
  const pasted = [
    'FYI — see below. This came in last night.',
    '',
    '---------- Forwarded message ---------',
    'From: Opposing Counsel <oc@radiant.test>',
    'Date: Thu, Sep 24, 2026 at 3:12 PM',
    'Subject: Re: Settlement — Bushell v. Radiant',
    'To: James Bushell <james@client.test>',
    'Cc: Paralegal <pl@radiant.test>, Another <a@radiant.test>',
    '',
    '',
    'James,',
    '',
    'Our client will not go above $250,000.',
    '',
    'Regards,',
    'OC',
    '',
    'On Wed, Sep 23, 2026 at 10:01 AM James Bushell <james@client.test> wrote:',
    '> What is your best number?',
    '>',
  ].join('\n');
  const e = parsePastedEmail(pasted);
  assert.equal(e.format, 'forward');
  assert.equal(e.from, 'Opposing Counsel <oc@radiant.test>');
  assert.equal(e.to, 'James Bushell <james@client.test>');
  assert.equal(e.cc, 'Paralegal <pl@radiant.test>, Another <a@radiant.test>');
  assert.equal(e.subject, 'Re: Settlement — Bushell v. Radiant');
  assert.equal(e.dateText, 'Thu, Sep 24, 2026 at 3:12 PM');
  assert.match(e.date, /^2026-09-2[45]T/);
  assert.ok(e.body.startsWith('FYI — see below.'), e.body);
  assert.match(e.body, /\$250,000/);
  assert.doesNotMatch(e.body, /best number/);
  assert.match(e.quoted, /^On Wed, Sep 23, 2026/);
  assert.match(e.quoted, /best number/);
});

test('Outlook copy: headers at the top (Sent: is the date), reply above the underscore line', () => {
  const pasted = [
    'From: Eden Quainton <eden@firm.test>',
    'Sent: Thursday, September 24, 2026 3:12 PM',
    'To: James Bushell <james@client.test>; Yfat <yfat@cocounsel.test>',
    'Cc: Paralegal <pl@firm.test>',
    'Subject: RE: OATH hearing',
    '',
    'James — the hearing is Tuesday.',
    '',
    'Eden',
    '',
    '________________________________',
    'From: James Bushell <james@client.test>',
    'Sent: Wednesday, September 23, 2026 9:00 AM',
    'To: Eden Quainton <eden@firm.test>',
    'Subject: OATH hearing',
    '',
    'When is the hearing?',
  ].join('\r\n');
  const e = parsePastedEmail(pasted);
  assert.equal(e.format, 'header-block');
  assert.equal(e.from, 'Eden Quainton <eden@firm.test>');
  assert.equal(e.to, 'James Bushell <james@client.test>; Yfat <yfat@cocounsel.test>');
  assert.equal(e.cc, 'Paralegal <pl@firm.test>');
  assert.equal(e.subject, 'RE: OATH hearing');
  assert.match(e.date, /^2026-09-2[45]T/);
  assert.equal(e.body, 'James — the hearing is Tuesday.\n\nEden');
  assert.match(e.quoted, /^_{10,}\nFrom: James Bushell/);
  assert.match(e.quoted, /When is the hearing\?/);
});

test('an Outlook reply with no headers of its own: the quoted block is NOT taken as this email\'s header', () => {
  const pasted = [
    'Thanks, will do.',
    '',
    '-----Original Message-----',
    'From: Eden Quainton <eden@firm.test>',
    'Sent: Tuesday, September 22, 2026 11:00 AM',
    'To: James Bushell',
    'Subject: Documents',
    '',
    'Please send the lease.',
  ].join('\n');
  const e = parsePastedEmail(pasted);
  assert.equal(e.format, 'none');
  assert.equal(e.from, null);
  assert.equal(e.subject, null);
  assert.equal(e.body, 'Thanks, will do.');
  assert.match(e.quoted, /^-----Original Message-----/);
});

test('a bare header block: wrapped recipients, RFC 2822 date to the minute', () => {
  const e = parsePastedEmail([
    'From: A <a@x.test>',
    'To: B <b@x.test>, C <c@x.test>,',
    '    D <d@x.test>',
    'Date: Thu, 24 Sep 2026 15:12:00 -0400',
    'Subject: Wrapped',
    '',
    'Body.',
  ].join('\n'));
  assert.equal(e.to, 'B <b@x.test>, C <c@x.test>, D <d@x.test>');
  assert.equal(e.date, '2026-09-24T19:12:00.000Z');
  assert.equal(e.body, 'Body.');
  assert.equal(e.quoted, null);
});

test('Gmail plain-text copy writes the keys in bold: *From:*', () => {
  const e = parsePastedEmail([
    '---------- Forwarded message ---------',
    '*From:* Opposing Counsel <oc@radiant.test>',
    '*Date:* Thu, Sep 24, 2026 at 3:12 PM',
    '*Subject:* Offer',
    '*To:* <james@client.test>',
    '',
    'The offer stands.',
  ].join('\n'));
  assert.equal(e.format, 'forward');
  assert.equal(e.from, 'Opposing Counsel <oc@radiant.test>');
  assert.equal(e.subject, 'Offer');
  assert.equal(e.to, '<james@client.test>');
  assert.equal(e.body, 'The offer stands.');
});

test('Gmail web view copied as text: sender, date line, "to me, James"', () => {
  const e = parsePastedEmail([
    'Opposing Counsel <oc@radiant.test>',
    'Thu, Sep 24, 2026, 3:12 PM (1 day ago)',
    'to me, James',
    '',
    'Body line.',
  ].join('\n'));
  assert.equal(e.format, 'gmail-web');
  assert.equal(e.from, 'Opposing Counsel <oc@radiant.test>');
  assert.equal(e.to, 'me, James');
  assert.match(e.date, /^2026-09-2[45]T/);
  assert.equal(e.body, 'Body line.');
});

test('mojibake: UTF-8 read as Windows-1252 is repaired in headers and body; real accents are untouched', () => {
  const clean = [
    'From: Zoë Müller <zoe@firm.test>',
    'Date: Thu, 24 Sep 2026 15:12:00 -0400',
    'Subject: Re: Settlement — Bushell',
    '',
    'Don’t miss the “final” deadline; the fee is €500 … naïve café.',
  ].join('\n');
  const e = parsePastedEmail(mangle(clean));
  assert.equal(e.repaired, true);
  assert.equal(e.from, 'Zoë Müller <zoe@firm.test>');
  assert.equal(e.subject, 'Re: Settlement — Bushell');
  assert.equal(e.body, 'Don’t miss the “final” deadline; the fee is €500 … naïve café.');

  const honest = 'Ångström, café, naïve, São Paulo, Ærø, Øre, résumé, «guillemets»';
  assert.equal(repairMojibake(honest), honest, 'legitimate Latin-1 text is left alone');
  assert.equal(repairMojibake(mangle(mangle('déjà vu — ok'))), 'déjà vu — ok', 'double encoding is undone');
  assert.equal(parsePastedEmail(clean).repaired, false);
});

test('non-breaking and zero-width spaces, CRLF', () => {
  const e = parsePastedEmail('From:\u00A0A <a@x.test>\r\nSubject:\u200B Hi\r\n\r\nLine\u00A0one\r\n');
  assert.equal(e.from, 'A <a@x.test>');
  assert.equal(e.subject, 'Hi');
  assert.equal(e.body, 'Line one');
});

test('keep the quoted history in the body when asked', () => {
  const pasted = 'Short reply.\n\nOn Wed, Sep 23, 2026 at 10:01 AM X <x@y.test> wrote:\n> earlier';
  const kept = parsePastedEmail(pasted, { separateQuoted: false });
  assert.match(kept.body, /earlier/);
  assert.equal(kept.quoted, null);
  const split = parsePastedEmail(pasted);
  assert.equal(split.body, 'Short reply.');
  assert.match(split.quoted, /^On Wed/);
});

test('"On … wrote:" wrapped over two lines is still the boundary', () => {
  const e = parsePastedEmail('Yes.\n\nOn Thu, Sep 24, 2026 at 3:12 PM Eden Quainton <\neden@firm.test> wrote:\n> Can you?');
  assert.equal(e.body, 'Yes.');
  assert.match(e.quoted, /^On Thu/);
});

test('plain text with no headers: all fields empty, nothing invented', () => {
  const e = parsePastedEmail('Just a note from the client.\nSecond line.');
  assert.deepEqual(
    { from: e.from, to: e.to, cc: e.cc, date: e.date, subject: e.subject, format: e.format },
    { from: null, to: null, cc: null, date: null, subject: null, format: 'none' });
  assert.equal(e.body, 'Just a note from the client.\nSecond line.');
});

test('nothing above the quote: the quote is the message', () => {
  const e = parsePastedEmail('> only quoted\n> text');
  assert.equal(e.body, '> only quoted\n> text');
  assert.equal(e.quoted, null);
});

test('dates: read with confidence or not at all', () => {
  assert.match(parseEmailDate('Thursday, September 24, 2026 3:12 PM'), /^2026-09-2[45]T/);
  assert.match(parseEmailDate('Thu, Sept. 24, 2026 at 3:12 p.m.'), /^2026-09-2[45]T/);
  assert.equal(parseEmailDate('Thu, 24 Sep 2026 15:12:00 +0000'), '2026-09-24T15:12:00.000Z');
  assert.equal(parseEmailDate('Sep 24, 3:12 PM'), null, 'no year: not guessed');
  assert.equal(parseEmailDate('next Tuesday'), null);
  assert.equal(parseEmailDate(''), null);
});

test('the audience line and the AI switch defaults, as the Thread tab words them', async () => {
  const c = await import('../src/lib/conversations.ts');
  const people = new Map([
    ['eden', { display_name: 'Eden Quainton', email: 'eden@firm.test' }],
    ['james', { display_name: 'James Bushell', email: 'james@client.test' }],
    ['yfat', { display_name: '', email: 'yfat@cocounsel.test' }],
  ]);
  assert.equal(c.audienceLine({ audience: 'members', created_by: 'eden', member_ids: ['eden', 'james'] }, people, 'eden'),
    'Only you, James Bushell');
  assert.equal(c.audienceLine({ audience: 'members', created_by: 'eden', member_ids: ['eden', 'james'] }, people, 'james'),
    'Only you, Eden Quainton');
  assert.equal(c.audienceLine({ audience: 'members', created_by: 'eden', member_ids: ['eden', 'yfat'] }, people, 'james'),
    'Only Eden Quainton, yfat@cocounsel.test');
  assert.equal(c.audienceLine({ audience: 'matter', created_by: 'eden', member_ids: [] }, people, 'eden'),
    'Everyone on this matter');
  assert.equal(c.defaultAiReadable('matter'), true, 'AI on by default when the conversation is for everyone');
  assert.equal(c.defaultAiReadable('members'), false, 'AI off by default when it is private');
  assert.match(c.aiSwitchHelp('members'), /Off by default/);
  assert.match(c.aiSwitchHelp('matter'), /On by default/);
  assert.equal(c.AUDIENCE_LABEL.members, 'Only these people');
});

test('the Thread cite: "Thread › <title>, <author>, <date>"', () => {
  assert.equal(senderName('Opposing Counsel <oc@radiant.test>'), 'Opposing Counsel');
  assert.equal(senderName('"Quainton, Eden" <eden@firm.test>'), 'Quainton, Eden');
  assert.equal(senderName('<oc@radiant.test>'), 'oc@radiant.test');
  assert.equal(citeDate('2026-09-24T23:30:00Z'), 'Sep 24, 2026', 'fixed to UTC');
  assert.equal(conversationCitation({
    conversation_title: 'Strategy', kind: 'message', author_name: 'Eden Quainton', created_at: '2026-09-24T12:00:00Z',
  }), 'Thread › Strategy, Eden Quainton, Sep 24, 2026');
  assert.equal(conversationCitation({
    conversation_title: 'Correspondence', kind: 'email', author_name: 'James Bushell',
    email_from: 'Opposing Counsel <oc@radiant.test>', email_date: '2026-09-23T15:00:00Z', created_at: '2026-09-25T12:00:00Z',
  }), 'Thread › Correspondence, Opposing Counsel, Sep 23, 2026', 'a pasted email is cited by its sender and its sent date');
});
