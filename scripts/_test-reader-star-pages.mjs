// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-reader-star-pages.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { boldStarPages } from '../src/lib/reader-star-pages.ts';

const strip = (h) => h.replace(/<[^>]*>/g, '');

test('star pages go bold; the words are unchanged', () => {
  const html = '<p>between the data and the opinion proffered. *147 Respondent points to</p><p>**523 The Court held *146</p><p>(*12) and [*13].</p>';
  const out = boldStarPages(html);
  for (const m of ['*147', '**523', '*146', '*12', '*13']) assert.ok(out.includes(`<strong class="star-page">${m}</strong>`), m);
  assert.equal(strip(out), strip(html), 'find, notes and the relied-on highlight read the same text');
});

test('tags, attributes and footnote marks are never touched; a document with no star paging is left alone', () => {
  const html = '<p><a href="#fn*12" id="x *14">see</a> *15 one *16 two *17</p>';
  const out = boldStarPages(html);
  assert.ok(out.includes('<a href="#fn*12" id="x *14">'));
  assert.equal((out.match(/star-page/g) ?? []).length, 3);
  assert.equal(boldStarPages('<p>Rated 5*, see note *2.</p>'), '<p>Rated 5*, see note *2.</p>');
  assert.equal(boldStarPages('<p>a*146 b 3*4 c *146x</p><p>*1 *2</p>'), '<p>a*146 b 3*4 c *146x</p><p>*1 *2</p>');
});
