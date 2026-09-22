// An email's headers and its body must be read through the SAME charset.
// No network, no database. Run: node scripts/_test-eml-headers.mjs
//
// 2026-09-21: a connector search returned an email whose body showed
// "Subject: RE: Approval â validation approach change" while the same em dash
// read correctly three lines lower, inside the quoted original. The file was
// read latin1 so that base64 and quoted-printable bodies survive the string
// round-trip, and each body part was re-read through its declared charset —
// but a header was only ever run through the RFC 2047 encoded-word pass, so
// raw 8-bit bytes (RFC 6532, and every mail client that ever sent an em dash
// in a Subject:) stayed latin1. The headers now take the same path as the body.
//
// Every message below is invented for this file.
import assert from 'node:assert';
import { extractEmlPages, decodeHeaderValue } from '../lib/eml-extract.mjs';

let n = 0;
const ok = (msg) => { n++; console.log(`  ok  ${msg}`); };

// An .eml is CRLF-delimited bytes. `parts` are joined with the encoding each
// one asks for, so a fixture can hold raw 8-bit or windows-1252 bytes.
const eml = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p.replace(/\n/g, '\r\n'), 'utf8'))));
const cp1252 = (s) => Buffer.from([...s].map((c) => ({ '—': 0x97, '’': 0x92, 'é': 0xe9, '…': 0x85 }[c] ?? c.charCodeAt(0))));
const headerBlock = (text) => text.split('\n\n')[0];

// --- 1. the recorded defect: a UTF-8 em dash in an 8-bit header ---------------
{
  const msg = eml(
    'From: Alistair Ferro <aferro@example.test>\n',
    'To: Natalie Brooks <nbrooks@example.test>\n',
    'Subject: RE: Approval — validation approach change\n',
    'Date: Wed, 14 Feb 2024 08:05:00 +0800\n',
    'MIME-Version: 1.0\n',
    'Content-Type: text/plain; charset=utf-8\n',
    'Content-Transfer-Encoding: 8bit\n',
    '\n',
    'Approved — no changes to the schedule.\n',
  );
  const [{ text }] = extractEmlPages(msg);
  assert.match(headerBlock(text), /^Subject: RE: Approval — validation approach change$/m,
    `the header reads as it was sent (${JSON.stringify(headerBlock(text).split('\n').pop())})`);
  assert(!/[\u0080-\u009f]|â€|Ã/.test(text), 'no mojibake signature anywhere in the page');
  assert.match(text, /Approved — no changes/, 'and the body is unchanged');
  ok('a raw UTF-8 em dash in an 8-bit Subject: survives, like the same em dash in the body');
}

// --- 2. RFC 2047 encoded words ------------------------------------------------
{
  const b64 = Buffer.from('Réunion — dossier', 'utf8').toString('base64');
  const msg = eml(
    'From: =?utf-8?Q?Th=C3=A9r=C3=A8se_Oyelaran?= <therese@example.test>\n',
    'To: counsel@example.test\n',
    `Subject: =?utf-8?B?${b64}?=\n`,
    'Content-Type: text/plain; charset=utf-8\n',
    '\n',
    'Body.\n',
  );
  const [{ text }] = extractEmlPages(msg);
  assert.match(text, /^Subject: Réunion — dossier$/m, 'a base64 encoded word decodes from its own charset');
  assert.match(text, /^From: Thérèse Oyelaran <therese@example\.test>$/m, 'and a Q-encoded one, underscore for space');
  ok('RFC 2047 encoded words decode, B and Q, from the charset they name');
}

{
  // Two adjacent encoded words: the whitespace between them exists so the
  // header can fold and is not part of the text (RFC 2047 §6.2). Whitespace
  // between an encoded word and ordinary text IS part of the text.
  const one = Buffer.from('première', 'utf8').toString('base64');
  const two = Buffer.from('partie', 'utf8').toString('base64');
  assert.strictEqual(decodeHeaderValue(`=?utf-8?B?${one}?= =?utf-8?B?${two}?=`, 'utf-8'), 'premièrepartie');
  assert.strictEqual(decodeHeaderValue(`Re: =?utf-8?B?${one}?= of two`, 'utf-8'), 'Re: première of two');
  ok('whitespace between adjacent encoded words is folding, not content');
}

{
  // An encoded word names its own charset, which need not be the message's.
  // Decoding it a second time through the message charset is what produces
  // "Ã©" — it must be decoded once, from its own bytes.
  assert.strictEqual(decodeHeaderValue('=?iso-8859-1?Q?caf=E9_ferm=E9?=', 'utf-8'), 'café fermé');
  assert.strictEqual(decodeHeaderValue('=?utf-8?Q?caf=C3=A9?=', 'utf-8'), 'café');
  ok('an encoded word is decoded once, from the charset it names — never again through the message\'s');
}

// --- 3. windows-1252 ----------------------------------------------------------
{
  const msg = eml(
    'From: Reception <reception@example.test>\n',
    'To: counsel@example.test\n',
    cp1252('Subject: Réunion — l’ordre du jour…\n'.replace(/\n/g, '\r\n')),
    'Content-Type: text/plain; charset=windows-1252\n',
    '\n',
    cp1252('Merci — à demain.\n'.replace(/\n/g, '\r\n')),
  );
  const [{ text }] = extractEmlPages(msg);
  assert.match(text, /^Subject: Réunion — l’ordre du jour…$/m,
    `windows-1252 header bytes read through the declared charset (${JSON.stringify(headerBlock(text).split('\n').pop())})`);
  assert.match(text, /Merci — à demain/, 'the body reads the same way it always did');
  ok('a windows-1252 header decodes through the charset the message declares');
}

// --- 4. no-op: everything that was already right --------------------------------
{
  const msg = eml(
    'From: Plain Sender <plain@example.test>\n',
    'To: counsel@example.test\n',
    'CC: second@example.test\n',
    'Date: Mon, 3 Mar 2025 09:00:00 -0500\n',
    'Subject: Scheduling for the March 14 conference\n',
    'Content-Type: text/plain; charset=utf-8\n',
    'Content-Transfer-Encoding: quoted-printable\n',
    '\n',
    'The deadline is the 14th =E2=80=94 not the 4th.\n',
  );
  const [{ text }] = extractEmlPages(msg);
  assert.strictEqual(headerBlock(text), [
    'From: Plain Sender <plain@example.test>',
    'To: counsel@example.test',
    'CC: second@example.test',
    'Date: Mon, 3 Mar 2025 09:00:00 -0500',
    'Subject: Scheduling for the March 14 conference',
  ].join('\n'), 'an ASCII header block is byte-for-byte what it was');
  assert.match(text, /the 14th — not the 4th/, 'a quoted-printable body still decodes');
  ok('ASCII headers are untouched; body decoding is unchanged');
}

{
  // Multipart: the top-level Content-Type declares no charset, so the charset
  // for an 8-bit header is the one the first text part declares.
  const msg = eml(
    'From: Sender <s@example.test>\n',
    'Subject: Exhibits — parts 1 and 2\n',
    'MIME-Version: 1.0\n',
    'Content-Type: multipart/mixed; boundary="b1"\n',
    '\n',
    '--b1\n',
    'Content-Type: text/plain; charset=utf-8\n',
    '\n',
    'See attached.\n',
    '--b1\n',
    'Content-Type: application/pdf; name="=?utf-8?Q?Exhibit_=E2=80=94_A.pdf?="\n',
    'Content-Disposition: attachment; filename="=?utf-8?Q?Exhibit_=E2=80=94_A.pdf?="\n',
    'Content-Transfer-Encoding: base64\n',
    '\n',
    'JVBERi0xLjQK\n',
    '--b1--\n',
  );
  const [{ text }] = extractEmlPages(msg);
  assert.match(text, /^Subject: Exhibits — parts 1 and 2$/m, 'the first text part\'s charset reads the top headers');
  assert.match(text, /^Attachments: Exhibit — A\.pdf$/m, 'and an attachment is named the way it was sent');
  ok('multipart: the message charset reaches the headers, and attachment names decode too');
}

{
  // Bytes that are neither valid UTF-8 nor anything the message declares still
  // have to produce readable text rather than throw or drop a character.
  assert.strictEqual(decodeHeaderValue(Buffer.from([0x53, 0x3a, 0x20, 0x97, 0x20, 0xe9]).toString('latin1')),
    'S: — é', 'an undeclared 8-bit header falls back to windows-1252');
  assert.strictEqual(decodeHeaderValue(''), '');
  assert.strictEqual(decodeHeaderValue(undefined), '');
  assert.strictEqual(decodeHeaderValue('=?x-unknown-charset?B?aGVsbG8=?=', 'utf-8'), 'hello',
    'an unknown charset does not throw');
  ok('an undeclared or unknown charset degrades to readable text, never to an exception');
}

console.log(`\nPASS (${n} checks)`);
