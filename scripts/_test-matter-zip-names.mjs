// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-matter-zip-names.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipEntryNames, safeZipName } from '../src/lib/matter-zip-core.ts';

test('archive names: the uploaded name, else title + stored extension; repeats numbered; bad characters replaced', () => {
  const names = zipEntryNames([
    { id: 'a', title: 'Joint Appendix Vol. I (A-1 to A-77) - FINAL', source_filename: 'JA Vol I (A-1 to A-77) FINAL.pdf', storage_path: 'm/a/JA Vol I (A-1 to A-77) FINAL.pdf' },
    { id: 'b', title: 'Jones v Administrators of Tulane Educational Fund', source_filename: null, storage_path: 'm/b/x.doc' },
    { id: 'c', title: 'Jones v Administrators of Tulane Educational Fund', source_filename: null, storage_path: 'm/c/y.doc' },
    { id: 'd', title: 'Notes: what/where?', source_filename: null, storage_path: 'm/d/n.md' },
    { id: 'e', title: 'Brief', source_filename: 'brief.md', storage_path: 'm/e/brief-abc.md' },
  ]);
  assert.equal(names.get('a'), 'JA Vol I (A-1 to A-77) FINAL.pdf');
  assert.equal(names.get('b'), 'Jones v Administrators of Tulane Educational Fund.doc');
  assert.equal(names.get('c'), 'Jones v Administrators of Tulane Educational Fund (2).doc');
  assert.equal(names.get('d'), 'Notes- what-where-.md');
  assert.equal(names.get('e'), 'brief.md');
  assert.equal(safeZipName('  Appeal – Joint Appendix (FINAL, frozen 2026-09-26)  '), 'Appeal – Joint Appendix (FINAL, frozen 2026-09-26)');
  assert.equal(safeZipName('...'), 'document');
});
