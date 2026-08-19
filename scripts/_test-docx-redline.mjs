// Unit test for the .docx redline export (src/lib/editor/export-docx.ts):
// builds a fixture document and inspects the actual OOXML for real
// w:ins / w:del revision marks, clean application of ruled edits, comment
// anchoring, and author attribution.
// Run: node scripts/_test-docx-redline.mjs
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { Packer } from 'docx';
import { buildRedlineDocument } from '../src/lib/editor/export-docx.ts';

const MANUSCRIPT = `It is important to note that the motion is complex.
The record shows the export was complete on March 4, 2024.
In conclusion, the implications resonate broadly.`;

const changes = [
  { // open edit → tracked change with a comment
    pos: 0,
    before: 'It is important to note that the motion is complex.',
    after: 'The motion turns on one undisputed fact.',
    status: 'open', author: 'The Contextspaces Editor',
    note: 'obscure — throat-clearing asserts nothing (authority: principle 1)',
  },
  { // resolved (accepted) edit → clean text, no revision marks
    pos: MANUSCRIPT.indexOf('In conclusion, the implications resonate broadly.'),
    before: 'In conclusion, the implications resonate broadly.',
    after: 'The export was complete, and no party disputes it.',
    status: 'resolved', author: 'The Contextspaces Editor',
  },
  { // the lawyer's own insertion → tracked insertion under their name
    pos: MANUSCRIPT.indexOf('The record shows'),
    before: '',
    after: 'Second, the timeline is undisputed. ',
    status: 'open', author: 'Counsel',
  },
];

const doc = buildRedlineDocument({ manuscript: MANUSCRIPT, changes });
const buffer = await Packer.toBuffer(doc);
const zip = await JSZip.loadAsync(buffer);
const body = await zip.file('word/document.xml').async('string');
const commentsXml = await zip.file('word/comments.xml')?.async('string');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

test('open edit exports as w:del + w:ins revision pair', () => {
  assert.ok(body.includes('<w:del '), 'no w:del');
  assert.ok(body.includes('<w:ins '), 'no w:ins');
  assert.ok(body.includes('It is important to note'), 'deleted text missing');
  assert.ok(body.includes('The motion turns on one undisputed fact.'), 'inserted text missing');
});

test('deleted text uses w:delText', () => {
  assert.ok(/<w:delText[^>]*>It is important to note/.test(body));
});

test('resolved edit applies clean — no revision marks in its paragraph', () => {
  const idx = body.indexOf('The export was complete, and no party disputes it.');
  assert.ok(idx > -1, 'resolved text missing');
  const paraStart = body.lastIndexOf('<w:p>', idx) !== -1 ? body.lastIndexOf('<w:p>', idx) : body.lastIndexOf('<w:p ', idx);
  const withinPara = body.slice(paraStart, idx);
  assert.ok(!withinPara.includes('<w:ins '), 'accepted text still marked as insertion');
  assert.ok(!body.includes('implications resonate broadly'), 'replaced text leaked into the document');
});

test('the lawyer\'s insertion is a tracked insertion under their name', () => {
  const idx = body.indexOf('Second, the timeline is undisputed.');
  assert.ok(idx > -1, 'insertion text missing');
  const around = body.slice(Math.max(0, idx - 300), idx);
  assert.ok(around.includes('<w:ins '), 'insertion not tracked');
  assert.ok(around.includes('w:author="Counsel"'), 'wrong author on insertion');
});

test('editor revisions carry the Editor\'s name', () => {
  assert.ok(body.includes('w:author="The Contextspaces Editor"'));
});

test('the margin work-product rides as a Word comment', () => {
  assert.ok(commentsXml, 'no comments part');
  assert.ok(commentsXml.includes('throat-clearing asserts nothing'), 'comment text missing');
  assert.ok(body.includes('<w:commentRangeStart'), 'comment not anchored in body');
  assert.ok(body.includes('<w:commentReference'), 'comment reference missing');
});

test('untouched manuscript text survives verbatim', () => {
  assert.ok(body.includes('The record shows the export was complete on March 4, 2024.'));
});

console.log(`\n${passed} passed${process.exitCode ? ' — FAILURES ABOVE' : ', all green'}`);
