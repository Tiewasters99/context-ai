// get_list / update_list_item (lib/mcp-core.mjs), offline. No network, no
// database: a tiny in-memory stand-in for the three tables the tools read.
//
//   node scripts/_verify-list-tools.mjs
//
// Checks:
//   1. a list resolves by UUID and by exact title, never by substring, and a
//      title shared by two lists is refused with both locations;
//   2. a list in a sealed or paused matter (opts.excludeMatterIds), or under
//      one, is invisible — the same gate list_matters applies;
//   3. get_list returns open items first and hides done ones unless asked;
//   4. update_list_item changes ONE entry, writes every other entry back
//      unchanged (unknown fields included), sets and clears the note, and
//      refuses a note over the cap, a locked list, an ambiguous text match;
//   5. the write carries updated_at as its precondition: a row that moved
//      underneath is not overwritten.

import { handleGetList, handleUpdateListItem, TOOLS } from '../lib/mcp-core.mjs';

const problems = [];
const check = (ok, what, extra) => { if (!ok) problems.push(what + (extra ? ` — ${JSON.stringify(extra)}` : '')); };
const rejects = async (fn, re, what) => {
  try { await fn(); problems.push(`${what}: did not throw`); }
  catch (e) { if (!re.test(e.message)) problems.push(`${what}: wrong error — ${e.message}`); }
};

// ── fake supabase ─────────────────────────────────────────────────────────
const M_OPEN = '11111111-1111-4111-8111-111111111111';
const M_SEALED = '22222222-2222-4222-8222-222222222222';
const M_CHILD = '33333333-3333-4333-8333-333333333333'; // under the sealed one
const L1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const L2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const L3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const L4 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function db() {
  return {
    matterspaces: [
      { id: M_OPEN, name: 'Open Matter', short_code: 'open', parent_matterspace_id: null },
      { id: M_SEALED, name: 'Sealed Matter', short_code: 'sealed', parent_matterspace_id: null },
      { id: M_CHILD, name: 'Child of Sealed', short_code: 'child', parent_matterspace_id: M_SEALED },
    ],
    content_items: [
      { id: L1, title: 'Morning', content_type: 'list', space_type: 'matterspace', space_id: M_OPEN, is_locked: false, locked_by: null, updated_at: 't1',
        content: { items: [
          { id: 'i1', text: 'Done thing', done: true, due: null, linked_page_id: null, linked_matter_id: null },
          { id: 'i2', text: 'Open thing', done: false, due: '2026-10-07', linked_page_id: 'p1', linked_matter_id: null, custom: 'kept' },
          { id: 'i3', text: 'Twice', done: false },
          { id: 'i4', text: 'twice', done: false },
          'not an object',
        ], extra: 'untouched' } },
      { id: L2, title: 'Morning', content_type: 'list', space_type: 'serverspace', space_id: 'ss', is_locked: false, locked_by: null, updated_at: 't1', content: { items: [] } },
      { id: L3, title: 'Secret', content_type: 'list', space_type: 'matterspace', space_id: M_CHILD, is_locked: false, locked_by: null, updated_at: 't1', content: { items: [{ id: 'x', text: 'hidden', done: false }] } },
      { id: L4, title: 'Locked', content_type: 'list', space_type: 'matterspace', space_id: M_OPEN, is_locked: true, locked_by: 'u', updated_at: 't1', content: { items: [{ id: 'k', text: 'k', done: false }] } },
      { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', title: 'Morning pages', content_type: 'page', space_type: 'matterspace', space_id: M_OPEN, is_locked: false, locked_by: null, updated_at: 't1', content: {} },
    ],
  };
}

function fake(tables, { bumpOnRead = false } = {}) {
  const q = (table) => {
    const filters = [];
    let mode = 'select';
    let patch = null;
    const run = () => {
      let rows = tables[table].filter((r) => filters.every((f) => f(r)));
      if (mode === 'update') {
        rows.forEach((r) => Object.assign(r, patch, { updated_at: r.updated_at + '+' }));
      }
      return rows.map((r) => ({ ...r }));
    };
    // A read hands back the rows as they were, then — when asked — someone
    // else saves underneath: the next write's precondition must fail.
    const read = () => {
      const rows = run();
      if (bumpOnRead && table === 'content_items' && mode === 'select') tables.content_items.forEach((r) => { r.updated_at = 'moved'; });
      return rows;
    };
    const b = {
      select() { return b; },
      update(p) { mode = 'update'; patch = p; return b; },
      eq(col, v) { filters.push((r) => r[col] === v); return b; },
      ilike(col, pat) {
        const re = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]]/g, '\\$&').replace(/\\\\([%_])/g, '\\$1').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
        filters.push((r) => re.test(String(r[col] ?? ''))); return b;
      },
      maybeSingle() { const r = read(); return Promise.resolve({ data: r[0] ?? null, error: r.length > 1 ? { message: 'multiple' } : null }); },
      then(res, rej) { return Promise.resolve({ data: read(), error: null }).then(res, rej); },
    };
    return b;
  };
  return { from: q };
}

// ── 0. catalogue ──────────────────────────────────────────────────────────
for (const n of ['get_list', 'update_list_item']) check(TOOLS.some((t) => t.name === n), `TOOLS lists ${n}`);

// ── 1. resolution ─────────────────────────────────────────────────────────
{
  const sb = fake(db());
  const byId = await handleGetList(sb, { list: L1 });
  check(byId.list.id === L1 && byId.list.matter?.short_code === 'open', 'resolves by UUID with its matter', byId.list);
  await rejects(() => handleGetList(sb, { list: 'Morning' }), /2 lists are titled "Morning".*matter open.*serverspace/s, 'shared title refused with locations');
  const narrowed = await handleGetList(sb, { list: 'morning', matter: 'open' });
  check(narrowed.list.id === L1, 'title + matter narrows to one (case-insensitive)');
  await rejects(() => handleGetList(sb, { list: 'Morn' }), /No list/, 'a substring is not a title');
  await rejects(() => handleGetList(sb, { list: 'Morning pages' }), /No list/, 'a page with the title is not a list');
}

// ── 2. the seal / pause gate ──────────────────────────────────────────────
{
  const sb = fake(db());
  const seen = await handleGetList(sb, { list: L3 });
  check(seen.list.id === L3, 'without a hidden set, the child list is visible');
  await rejects(() => handleGetList(sb, { list: L3 }, { excludeMatterIds: new Set([M_SEALED]) }), /No list/, 'a list under a sealed matter is invisible');
  await rejects(() => handleGetList(sb, { list: 'Secret' }, { excludeMatterIds: new Set([M_SEALED]) }), /No list/, 'by title too');
  await rejects(() => handleUpdateListItem(sb, { list: L3, item: 'x', done: true }, { excludeMatterIds: new Set([M_CHILD]) }), /No list/, 'and cannot be written');
  const still = await handleGetList(sb, { list: L1 }, { excludeMatterIds: new Set([M_SEALED]) });
  check(still.list.id === L1, 'the open matter\'s list is unaffected');
}

// ── 3. reading ────────────────────────────────────────────────────────────
{
  const sb = fake(db());
  const r = await handleGetList(sb, { list: L1 });
  check(r.open_count === 3 && r.done_count === 1 && r.items.length === 3, 'open items only by default', { open: r.open_count, done: r.done_count, n: r.items.length });
  check(r.items[0].id === 'i2' && r.items[0].has_page === true && r.items[0].due === '2026-10-07' && r.items[0].note === null, 'item shape', r.items[0]);
  check(!('raw_index' in r.items[0]) && !('custom' in r.items[0]), 'internal fields are not returned');
  const all = await handleGetList(sb, { list: L1, include_done: true });
  check(all.items.length === 4 && all.items[3].id === 'i1', 'include_done appends the finished ones');
}

// ── 4. writing ────────────────────────────────────────────────────────────
{
  const t = db();
  const sb = fake(t);
  const r = await handleUpdateListItem(sb, { list: L1, item: 'i2', note: '  Which bullets? The list dots or the page ones?  ' });
  check(r.item.note === 'Which bullets? The list dots or the page ones?' && r.item.done === false, 'note set (trimmed), done untouched', r.item);
  const row = t.content_items.find((x) => x.id === L1);
  check(row.content.extra === 'untouched', 'other content fields kept');
  check(row.content.items[1].custom === 'kept' && row.content.items[1].linked_page_id === 'p1', 'unknown and link fields on the item kept');
  check(row.content.items[0].done === true && row.content.items[4] === 'not an object', 'every other entry written back as it was');
  check(row.content.items.length === 5, 'nothing dropped');

  const d = await handleUpdateListItem(sb, { list: L1, item: 'Open thing', done: true });
  check(d.item.done === true && d.item.note === 'Which bullets? The list dots or the page ones?', 'done by exact text; note survives');
  const c = await handleUpdateListItem(sb, { list: L1, item: 'i2', note: '' });
  check(c.item.note === null && !('note' in row.content.items[1]), 'empty note clears the field');

  await rejects(() => handleUpdateListItem(sb, { list: L1, item: 'TWICE', done: true }), /2 items read/, 'ambiguous text refused');
  await rejects(() => handleUpdateListItem(sb, { list: L1, item: 'nope', done: true }), /No item/, 'unknown item');
  await rejects(() => handleUpdateListItem(sb, { list: L1, item: 'i2' }), /done and\/or note/, 'nothing to change');
  await rejects(() => handleUpdateListItem(sb, { list: L1, item: 'i2', note: 'x'.repeat(501) }), /over 500/, 'note cap');
  await rejects(() => handleUpdateListItem(sb, { list: L4, item: 'k', done: true }), /locked/, 'locked list refused');
  check(t.content_items.find((x) => x.id === L4).content.items[0].done === false, 'locked list not written');
}

// ── 5. the precondition ───────────────────────────────────────────────────
{
  const t = db();
  const sb = fake(t, { bumpOnRead: true });
  await rejects(() => handleUpdateListItem(sb, { list: L1, item: 'i2', done: true }), /changed while you were reading/, 'a row that moved is not overwritten');
  check(t.content_items.find((x) => x.id === L1).content.items[1].done === false, 'and the item is unchanged');
}

if (problems.length) {
  console.error('FAIL _verify-list-tools:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('PASS _verify-list-tools: resolution, seal gate, read shape, single-entry write, precondition');
