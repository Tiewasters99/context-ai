// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-note-pin.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { noteNumberOf } from '../src/lib/brief/note-pin.ts';

test('the note a cite pins to', () => {
  assert.equal(noteNumberOf('DCWP v. Diplomat Home Remodeling, LLC, OATH Index No. 1467/24, at n.1 (Dec. 24, 2024)'), 1);
  assert.equal(noteNumberOf('DCWP v. Diplomat Home Remodeling, LLC, OATH Index No. 1467/24, at 2 n.1 (Dec. 24, 2024)'), 1);
  assert.equal(noteNumberOf('353 U.S. 372, 373 & n.3'), 3);
  assert.equal(noteNumberOf('353 U.S. 372, 373 n. 3'), 3);
  assert.equal(noteNumberOf('353 U.S. 372, 373 nn.3–4'), 3, 'the first of a span');
  assert.equal(noteNumberOf('Champion Auto Sales, OATH Index No. 2430/19, at n.4 (July 30, 2025)'), 4);
  assert.equal(noteNumberOf('Id. at 5 n.12'), 12);
});

test('no pin, or something that only looks like one', () => {
  assert.equal(noteNumberOf('Matter of Trump v. Engoron, 222 A.D.3d 505, 506 (1st Dep’t 2023)'), null);
  assert.equal(noteNumberOf('Admin. Code § 20-703(i)(2)'), null);
  assert.equal(noteNumberOf('Dunn.1 v. Smith'), null, 'a word ending in "n." is not a pin');
  assert.equal(noteNumberOf('see Brown v. Board, at n.0'), null);
  assert.equal(noteNumberOf(''), null);
  assert.equal(noteNumberOf(null), null);
});

test('a Word file’s notes get a heading in the Reader; a file without notes is untouched', async () => {
  const { labelWordNotes } = await import('../src/lib/reader-notes.ts');
  const body = '<p>…count 2.<sup><a href="#footnote-21" id="footnote-ref-21">[1]</a></sup></p>';
  const notes = '<ol><li id="footnote-21"><p> Finally, Respondents’ written argument merits no modifications. <a href="#footnote-ref-21">↑</a></p></li></ol>';
  assert.equal(labelWordNotes(body + notes), body + '<h3 class="reader-notes-heading">Footnotes</h3>' + notes);
  assert.equal(labelWordNotes(body + '<ol><li>an ordinary list</li></ol>'), body + '<ol><li>an ordinary list</li></ol>');
  assert.match(labelWordNotes('<ol><li id="endnote-3"><p>E</p></li></ol>'), /^<h3 class="reader-notes-heading">Endnotes<\/h3>/);
});
