// node --test scripts/_test-docx-notes.mjs
//
// Word footnotes and endnotes reach the indexed text (10-02: DCWP v. Diplomat
// Home Remodeling's footnote 1 was in the file and the Reader, not in search).
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { extractDocxNotes, notesSection, wordText } from '../lib/docx-notes.mjs';
import { extractPages } from '../lib/ingest-core.mjs';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (inner) => `<w:p>${inner}</w:p>`;
const r = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const ref = (kind, id) => `<w:r><w:${kind}Reference w:id="${id}"/></w:r>`;

/** A minimal real .docx: [Content_Types].xml, rels, document.xml, and notes parts if given. */
async function docx({ body, footnotes, endnotes }) {
  const z = new JSZip();
  z.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${footnotes ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>' : ''}${endnotes ? '<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>' : ''}</Types>`);
  z.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const rels = [];
  if (footnotes) rels.push('<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>');
  if (endnotes) rels.push('<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>');
  z.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  z.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  const sep = '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>';
  if (footnotes) z.file('word/footnotes.xml', `<?xml version="1.0"?><w:footnotes ${W}>${sep}${footnotes}</w:footnotes>`);
  if (endnotes) z.file('word/endnotes.xml', `<?xml version="1.0"?><w:endnotes ${W}>${endnotes}</w:endnotes>`);
  return z.generateAsync({ type: 'nodebuffer' });
}

test('footnotes come out in the order Word numbers them, separators skipped, entities decoded', async () => {
  // Word numbers by where the marks fall: id 7 is referenced first, so it is note 1.
  const buf = await docx({
    body: p(r('Accordingly, penalties total $525.') + ref('footnote', 7)) + p(r('Second point.') + ref('footnote', 3)),
    footnotes: '<w:footnote w:id="3">' + p(r('Champion &amp; Co. held otherwise.')) + '</w:footnote>'
      + '<w:footnote w:id="7">' + p(r('Finally, Respondents’ written argument merits no modifications.')) + '</w:footnote>',
  });
  const n = await extractDocxNotes(buf);
  assert.deepEqual(n.footnotes, ['Finally, Respondents’ written argument merits no modifications.', 'Champion & Co. held otherwise.']);
  assert.deepEqual(n.endnotes, []);
  assert.equal(notesSection(n), 'Footnotes\n\n1. Finally, Respondents’ written argument merits no modifications.\n\n2. Champion & Co. held otherwise.');
});

test('the indexed text: the body exactly as before, then the notes', async () => {
  const body = p(r('The Department now issues this Final Agency Decision.') + ref('footnote', 1));
  const withNotes = await docx({ body, footnotes: '<w:footnote w:id="1">' + p(r('Respondents cited no authority.')) + '</w:footnote>' });
  const without = await docx({ body: p(r('The Department now issues this Final Agency Decision.')) });
  const [a] = await extractPages(withNotes, '.docx');
  const [b] = await extractPages(without, '.docx');
  assert.ok(a.text.startsWith(b.text.trimEnd()), 'the body text is unchanged');
  assert.ok(a.text.endsWith('Footnotes\n\n1. Respondents cited no authority.'), JSON.stringify(a.text));
  assert.ok(!/Footnotes/.test(b.text), 'a file without notes is indexed exactly as before');
});

test('endnotes too; a note whose mark was deleted is kept, after the numbered ones', async () => {
  const buf = await docx({
    body: p(r('Text.') + ref('endnote', 2)),
    footnotes: '<w:footnote w:id="9">' + p(r('Orphaned note.')) + '</w:footnote>',
    endnotes: '<w:endnote w:id="2">' + p(r('An endnote.')) + p(r('Its second paragraph.')) + '</w:endnote>',
  });
  const n = await extractDocxNotes(buf);
  assert.deepEqual(n.endnotes, ['An endnote.\nIts second paragraph.']);
  assert.deepEqual(n.footnotes, ['Orphaned note.']);
  assert.match(notesSection(n), /^Footnotes\n\n1\. Orphaned note\.\n\nEndnotes\n\n1\. An endnote\./);
});

test('tabs and breaks read as spaces; empty notes are not notes', () => {
  assert.equal(wordText(p(r('A') + '<w:r><w:tab/></w:r>' + r('B') + '<w:r><w:br/></w:r>' + r('C'))), 'A B C');
  assert.equal(wordText(p('<w:r><w:t></w:t></w:r>')), '');
});

test('a file that is not a zip leaves the notes empty-handed but never throws past the extractor', async () => {
  await assert.rejects(() => extractDocxNotes(Buffer.from('not a zip')));
});
