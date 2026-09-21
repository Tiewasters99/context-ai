// The Vault list's two halves, offline: how rows that arrived in the server's
// order are cut into groups, and what the paged read actually ASKS the server
// for — including what it does when the database has not got migration 081.
//
// Neither half mounts React. `src/lib/vault-grouping.ts` is a pure module, and
// `src/lib/vault-documents.ts` takes the PostgREST client as an argument, so a
// recorder can stand in for it and the REAL query builder can be driven and
// read back. Both are .ts files imported through the '@/' alias, so this needs
// the same loader the reader and Record harnesses use:
//
//   node --import ./scripts/_node-src-loader.mjs --test scripts/_test-vault-grouping.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVaultGroups,
  shareRenderBudget,
  groupLetter,
  CATEGORY_ORDER,
  CATEGORY_LABEL,
  UNCATEGORISED_LABEL,
  isDocumentCategory,
} from '../src/lib/vault-grouping.ts';
import {
  fetchMatterDocumentRows,
  VAULT_DOCUMENT_COLUMNS,
  VAULT_DOCUMENT_COLUMNS_ORGANIZED,
  VaultColumnsMissingError,
} from '../src/lib/vault-documents.ts';

// ---------------------------------------------------------------------------
// A PostgREST stand-in that records what it was asked for.
// ---------------------------------------------------------------------------
function recorder({ rows = [], failOn = null } = {}) {
  const calls = { selects: [], orders: [], ranges: [], ins: [] };
  const db = {
    from() {
      const q = {
        select(columns, options) {
          calls.selects.push({ columns, count: options?.count });
          return q;
        },
        in(col, values) { calls.ins.push({ col, values }); return q; },
        order(col, options) {
          // One chain per request; a new select starts a new chain.
          const chain = calls.orders[calls.selects.length - 1] ?? (calls.orders[calls.selects.length - 1] = []);
          chain.push({ col, ascending: options?.ascending !== false });
          return q;
        },
        range(from, to) {
          calls.ranges.push([from, to]);
          const columns = calls.selects[calls.selects.length - 1].columns;
          if (failOn && columns.includes(failOn)) {
            return Promise.resolve({
              data: null,
              error: { message: `column documents.${failOn} does not exist` },
              count: null,
            });
          }
          return Promise.resolve({
            data: rows.slice(from, to + 1),
            error: null,
            count: from === 0 ? rows.length : null,
          });
        },
      };
      return q;
    },
  };
  return { db, calls };
}

const doc = (i, over = {}) => ({
  id: `d${String(i).padStart(4, '0')}`,
  title: `Doc ${i}`,
  source_filename: `doc-${i}.pdf`,
  file_size_bytes: 1000,
  processing_status: 'ready',
  processing_error: null,
  matterspace_id: 'm1',
  ...over,
});

// ---------------------------------------------------------------------------
test('date mode groups by matter, and only when there is more than one', () => {
  const oneMatter = [doc(1), doc(2), doc(3)];
  assert.equal(buildVaultGroups(oneMatter, 'date'), null,
    'a single-matter list stays flat, exactly as it did before grouping existed');

  const two = [
    { ...doc(1), matterspace_id: 'm1', matterspace_name: 'Fleming' },
    { ...doc(2), matterspace_id: 'm2', matterspace_name: 'Teman' },
    { ...doc(3), matterspace_id: 'm1', matterspace_name: 'Fleming' },
  ];
  const groups = buildVaultGroups(two, 'date');
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.name), ['Fleming', 'Teman'],
    'group order is first-seen order — the order the server returned');
  assert.equal(groups[0].files.length, 2, 'and the two Fleming rows are in ONE group, not two');
});

test('A–Z groups on the sort key, not the raw name', () => {
  // These are the names a filing night produces. The server's sort_key has
  // already removed the date and the index; the grouping must agree with it,
  // or the headings say # and the rows underneath start with W.
  const rows = [
    { ...doc(1), source_filename: '2026-09-08 04 - Watson v Long Island RCo.pdf', sortKey: 'watson v long island rco' },
    { ...doc(2), source_filename: 'The Watsonville Report.pdf', sortKey: 'watsonville report' },
    { ...doc(3), source_filename: 'Zylstra v Barrowman.pdf', sortKey: 'zylstra v barrowman' },
    { ...doc(4), source_filename: '2291 IMG.jpg', sortKey: '2291 img' },
  ];
  const groups = buildVaultGroups(rows, 'name');
  assert.deepEqual(groups.map((g) => g.name), ['W', 'Z', '#']);
  assert.equal(groups[0].files.length, 2);
  assert.equal(groupLetter({ sortKey: '', name: 'Watson.pdf' }), 'W',
    'with no sort key it falls back to the displayed name');
  assert.equal(groupLetter({ sortKey: '2291 img', name: '2291 IMG.jpg' }), '#',
    'anything that does not start with a letter files under #');
});

test('category mode uses Table-of-Authorities labels and keeps the unfiled together', () => {
  const rows = [
    { ...doc(1), category: 'case' },
    { ...doc(2), category: 'case' },
    { ...doc(3), category: 'pleading' },
    { ...doc(4), category: null },
    { ...doc(5), category: undefined },
  ];
  const groups = buildVaultGroups(rows, 'category');
  assert.deepEqual(groups.map((g) => g.name), [
    CATEGORY_LABEL.case, CATEGORY_LABEL.pleading, UNCATEGORISED_LABEL,
  ]);
  assert.equal(groups[2].files.length, 2, 'null and undefined are both "nobody has filed it"');
  for (const c of CATEGORY_ORDER) assert.ok(isDocumentCategory(c), `${c} is a category`);
  assert.equal(isDocumentCategory('misc'), false);
});

test('grouping never sorts — a row out of order joins its group, it does not open a second', () => {
  // A file uploaded a moment ago is PREPENDED to the list by the panel, so it
  // arrives ahead of its alphabetical place. The header must not appear twice.
  const rows = [
    { ...doc(9), sortKey: 'watson late arrival' },
    { ...doc(1), sortKey: 'alpha' },
    { ...doc(2), sortKey: 'watson v long island' },
  ];
  const groups = buildVaultGroups(rows, 'name');
  assert.deepEqual(groups.map((g) => g.name), ['W', 'A'], 'first-seen order, not re-sorted');
  assert.equal(groups[0].files.length, 2, 'both W rows are under the one W heading');
  // And the input array itself is untouched.
  assert.equal(rows[0].id, 'd0009');
});

test('the render budget is shared in group order, and a collapsed group costs nothing', () => {
  const groups = [
    { id: 'a', name: 'A', files: new Array(300).fill(0) },
    { id: 'b', name: 'B', files: new Array(300).fill(0) },
    { id: 'c', name: 'C', files: new Array(300).fill(0) },
  ];
  const take = shareRenderBudget(groups, 500, new Set());
  assert.equal(take.get('a'), 300);
  assert.equal(take.get('b'), 200);
  assert.equal(take.get('c'), 0, 'the budget ran out — but the group still exists, with its true count');

  const collapsed = shareRenderBudget(groups, 500, new Set(['a']));
  assert.equal(collapsed.get('a'), 0);
  assert.equal(collapsed.get('b'), 300, 'a collapsed group hands its share to the next one');
  assert.equal(collapsed.get('c'), 200);
});

// ---------------------------------------------------------------------------
test('the date read is byte-for-byte the request the Vault has always sent', async () => {
  const { db, calls } = recorder({ rows: [doc(1), doc(2)] });
  await fetchMatterDocumentRows(db, ['m1']);
  assert.equal(calls.selects[0].columns, VAULT_DOCUMENT_COLUMNS,
    'no column added by 081 is asked for — which is what makes merging before the paste safe');
  assert.equal(calls.selects[0].count, 'exact');
  assert.deepEqual(calls.orders[0], [
    { col: 'created_at', ascending: false },
    { col: 'id', ascending: false },
  ]);
});

test('A–Z and category ask the SERVER for the order, and every chain ends with id', async () => {
  for (const [order, expected] of [
    ['name', [
      { col: 'sort_key', ascending: true },
      { col: 'id', ascending: true },
    ]],
    ['category', [
      { col: 'category_rank', ascending: true },
      { col: 'sort_key', ascending: true },
      { col: 'id', ascending: true },
    ]],
  ]) {
    const { db, calls } = recorder({ rows: [doc(1)] });
    await fetchMatterDocumentRows(db, ['m1'], { order });
    assert.equal(calls.selects[0].columns, VAULT_DOCUMENT_COLUMNS_ORGANIZED);
    assert.deepEqual(calls.orders[0], expected, `${order} order`);
    assert.equal(calls.orders[0].at(-1).col, 'id',
      'the unique tiebreaker paged.ts requires — two copies of one case export share a sort key exactly');
  }
});

test('a paged A–Z read keeps the order across every page and drops nothing', async () => {
  // 2,500 rows, all sharing a sort key, which is the A–Z version of the
  // dropped-folder trap: without `id` the pages would swap rows.
  const rows = Array.from({ length: 2500 }, (_, i) =>
    doc(i, { sort_key: 'production copy', category: 'other' }));
  const { db, calls } = recorder({ rows });
  const res = await fetchMatterDocumentRows(db, ['m1'], { order: 'name' });
  assert.equal(res.rows.length, 2500);
  assert.equal(new Set(res.rows.map((r) => r.id)).size, 2500, 'every row exactly once');
  assert.deepEqual(res.rows.map((r) => r.id), rows.map((r) => r.id), 'in the server order, unchanged');
  assert.equal(res.total, 2500);
  assert.equal(res.truncated, false);
  assert.equal(calls.ranges.length, 3, 'three pages, 1,000 apart');
  assert.equal(calls.selects.filter((s) => s.count === 'exact').length, 1,
    'the exact count is asked for once, not once per page');
});

test('without migration 081 the list falls back to date and SAYS so — it never errors', async () => {
  const { db, calls } = recorder({ rows: [doc(1), doc(2)], failOn: 'sort_key' });
  const res = await fetchMatterDocumentRows(db, ['m1'], { order: 'category' });
  assert.equal(res.orderFellBack, true, 'the caller is told, so it can show one sentence');
  assert.equal(res.rows.length, 2, 'and the documents are still there');
  assert.equal(calls.selects.at(-1).columns, VAULT_DOCUMENT_COLUMNS,
    'the retry asks only for columns that exist');
  assert.deepEqual(calls.orders.at(-1), [
    { col: 'created_at', ascending: false },
    { col: 'id', ascending: false },
  ]);
  // The missing column must NOT be treated as a transient failure: retrying it
  // three times with sleeps would make every list load a second slower.
  assert.equal(calls.ranges.length, 2, 'one failed attempt, then the fallback — no retry storm');
});

test('a missing column is its own error type, distinguishable from a real failure', async () => {
  const err = new VaultColumnsMissingError('column documents.sort_key does not exist');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'VaultColumnsMissingError');

  // A genuine failure still throws, and still names the list that broke.
  const { db } = recorder({ rows: [] });
  const broken = {
    from() {
      const q = {
        select() { return q; }, in() { return q; }, order() { return q; },
        range: () => Promise.resolve({ data: null, error: { message: 'network down' }, count: null }),
      };
      return q;
    },
  };
  void db;
  await assert.rejects(
    () => fetchMatterDocumentRows(broken, ['m1'], { order: 'name', attempts: 2, delay: async () => {} }),
    /list documents: network down/,
  );
});
