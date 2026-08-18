// Unit tests for the desk-text gate (src/lib/editor/desk-text.ts).
// Run: node scripts/_test-desk-text.mjs   (Node ≥ 23.6 strips types natively)
import assert from 'node:assert/strict';
import { prepareDeskText } from '../src/lib/editor/desk-text.ts';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

const PROSE =
  'The motion should be denied. Plaintiff has not carried its burden under Rule 56, ' +
  'and the record shows a genuine dispute of material fact on each element. ' +
  'The deposition testimony of Ms. Nievera, taken on March 4, establishes the timeline in detail.';

test('clean prose passes through untouched', () => {
  const r = prepareDeskText(PROSE);
  assert.equal(r.kind, 'clean');
  assert.equal(r.text, PROSE);
});

test('short legitimate plain text is not refused', () => {
  const r = prepareDeskText('A short cover note for the record, under a hundred characters.');
  assert.equal(r.kind, 'clean');
});

test('transcript tokens like <unintelligible> are not treated as markup', () => {
  const input = `Q. And what did you see?\nA. It was <unintelligible> near the <REDACTED> entrance.\n${PROSE}`;
  const r = prepareDeskText(input);
  assert.equal(r.kind, 'clean');
  assert.ok(r.text.includes('<unintelligible>'));
  assert.ok(r.text.includes('<REDACTED>'));
});

test('tag-littered prose is converted: tags stripped, entities decoded', () => {
  const input =
    `The court&rsquo;s ruling was clear.<br><br><span style="font-family:Times">${PROSE}</span>` +
    `<div>Judgment&nbsp;affirmed &mdash; costs to appellant.</div>`;
  const r = prepareDeskText(input);
  assert.equal(r.kind, 'converted');
  assert.ok(!/<span|<div|<br/i.test(r.text), 'tags remain');
  assert.ok(r.text.includes('The court’s ruling'));
  assert.ok(r.text.includes('affirmed — costs'));
  assert.ok(r.note.includes('markup removed'));
});

test('a full HTML page with real prose converts to that prose', () => {
  const input =
    `<!DOCTYPE html><html><head><title>Essay</title><style>p{margin:0}</style></head>` +
    `<body><h1>The Ghazal</h1><p>${PROSE}</p><p>${PROSE}</p></body></html>`;
  const r = prepareDeskText(input);
  assert.equal(r.kind, 'converted');
  assert.ok(r.text.startsWith('The Ghazal'));
  assert.ok(!/<[a-z]/i.test(r.text));
  assert.ok(!r.text.includes('margin:0'), 'style block leaked');
});

test('a captured search screen (forms, thin prose) is refused', () => {
  const input =
    `<!DOCTYPE html><html><head><title>Case Search</title></head><body>` +
    `<form action="/search"><input name="party"><input name="court"><select name="year"><option>2026</option></select>` +
    `<button>Search</button></form><a href="/login">Log in</a> Party Name Court Year</body></html>`;
  const r = prepareDeskText(input);
  assert.equal(r.kind, 'refused');
  assert.ok(r.reason.includes('captured web page'));
});

test('raw PDF internals are refused with a re-ingest pointer', () => {
  const input =
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Page >>\nstream\nxyz\nendstream\nendobj`;
  const r = prepareDeskText(input);
  assert.equal(r.kind, 'refused');
  assert.ok(r.reason.includes('Re-ingest'));
});

test('quoted-printable email decodes and sheds its header block', () => {
  const input =
    `Received: from mail.example.com\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\nSubject: The draft\r\n\r\n` +
    `Dear counsel,\r\nThe court=E2=80=99s order issued yesterday. We should con=\r\nfer before Friday. ${PROSE}`;
  const r = prepareDeskText(input);
  assert.equal(r.kind, 'converted');
  assert.ok(r.text.includes('court’s order'), 'QP bytes not decoded');
  assert.ok(r.text.includes('confer before Friday'), 'soft break not joined');
  assert.ok(!r.text.includes('Received:'), 'headers remain');
  assert.ok(r.note.includes('email'));
});

test('entity-only clutter (no tags) still converts', () => {
  const input = `Smith &amp; Jones filed the brief&#8217;s annex &#x2014; see &sect; 12(b)(6). ${PROSE} &ldquo;Quoted.&rdquo;`;
  const r = prepareDeskText(input);
  assert.equal(r.kind, 'converted');
  assert.ok(r.text.includes('Smith & Jones'));
  assert.ok(r.text.includes('brief’s annex — see § 12(b)(6)'));
  assert.ok(r.text.includes('“Quoted.”'));
});

test('blank-line runs collapse to paragraph breaks in converted text', () => {
  const input = `<p>First paragraph.</p>\n\n\n\n<p>Second paragraph, with enough surrounding prose to convert. ${PROSE}</p>`;
  const r = prepareDeskText(input);
  assert.equal(r.kind, 'converted');
  assert.ok(!/\n{3,}/.test(r.text));
});

test('empty input is refused', () => {
  assert.equal(prepareDeskText('   \n  ').kind, 'refused');
});

test('markup that strips to nothing is refused', () => {
  const r = prepareDeskText('<div><span></span><br><br><table><tr><td></td></tr></table></div>');
  assert.equal(r.kind, 'refused');
});

console.log(`\n${passed} passed${process.exitCode ? ' — FAILURES ABOVE' : ', all green'}`);
