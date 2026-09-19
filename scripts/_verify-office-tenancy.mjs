// Offline proof that The Office serves ONE owner's room and nothing else.
//
// /api/office runs on the service role, which sees every tenant, so the
// only thing standing between one firm's published shelf and another's is
// the filtering in api/office.mjs. That filtering is pure and exported —
// resolveRoomOwner / selectRoom / selectBook — so it can be driven here
// with stubbed rows for two owners, no network, no Supabase, no prod.
//
// What this asserts:
//   1. the room's owner comes from OFFICE_DEFAULT_OWNER_ID and nowhere else;
//      unset or malformed = CLOSED (no room at all), never open
//   2. the listing shows owner A's published items on owner A's sections —
//      B's rows and A's unpublished rows never appear, even when they are
//      handed to the shaper (a widened query cannot widen the room)
//   3. a section that ends up empty is not published as an empty shelf
//   4. ?book= applies the SAME rule: A's published item reads; A's
//      unpublished, B's published, and a non-uuid all fall off the shelves
//
// Run:  node scripts/_verify-office-tenancy.mjs     (exit 0 = all pass)

import { isUuid, resolveRoomOwner, selectRoom, selectBook } from '../api/office.mjs';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, detail) => {
  failures += 1;
  console.log(`  FAIL  ${m}`);
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
};
const check = (cond, m, detail) => (cond ? pass(m) : fail(m, detail));
const eq = (actual, expected, m) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), m, { actual, expected });

// ── the two tenants ───────────────────────────────────────────────────
const A = '4ac2bcd9-1111-4111-8111-aaaaaaaaaaaa'; // the firm whose office is public
const B = '7de10c22-2222-4222-8222-bbbbbbbbbbbb'; // a second customer, later

const sections = [
  { id: 's-a1', owner_id: A, kind: 'library', title: 'CLE Presentations', blurb: 'A', sort_order: 0 },
  { id: 's-a2', owner_id: A, kind: 'practice', title: 'Defamation', blurb: 'A', sort_order: 1 },
  { id: 's-a3', owner_id: A, kind: 'library', title: 'Nothing published yet', blurb: 'A', sort_order: 2 },
  { id: 's-b1', owner_id: B, kind: 'library', title: "B's shelf", blurb: 'B', sort_order: 0 },
];

const item = (id, owner_id, section_id, published, extra = {}) => ({
  id, owner_id, section_id, published,
  title: `${id} title`, author: 'Author', excerpt: 'excerpt', spine: '#39505f',
  document_id: 'doc-' + id, sort_order: 0, ...extra,
});

const items = [
  item('a-pub', A, 's-a1', true),
  item('a-pub-2', A, 's-a2', true),
  item('a-unpub', A, 's-a1', false),
  item('a-no-doc', A, 's-a1', true, { document_id: null }),
  item('b-pub', B, 's-b1', true),
  // the nastiest shape: B's published item filed into A's section
  item('b-in-a-section', B, 's-a1', true),
  item('b-unpub', B, 's-b1', false),
];

const jackets = new Map([['a-pub', 'https://cdn/jacket.jpg'], ['b-pub', 'https://cdn/b.jpg']]);
const pageMap = new Map([['a-pub', ['p1.jpg', 'p2.jpg']]]);

// ── 1. whose room is it ───────────────────────────────────────────────
console.log('\n1. the room owner comes from the server, not the caller');
eq(resolveRoomOwner({}), { ok: false, reason: 'unset' }, 'no OFFICE_DEFAULT_OWNER_ID -> closed');
eq(resolveRoomOwner({ OFFICE_DEFAULT_OWNER_ID: '' }), { ok: false, reason: 'unset' }, 'empty -> closed');
eq(resolveRoomOwner({ OFFICE_DEFAULT_OWNER_ID: '   ' }), { ok: false, reason: 'unset' }, 'blank -> closed');
eq(resolveRoomOwner({ OFFICE_DEFAULT_OWNER_ID: 'everyone' }), { ok: false, reason: 'invalid' }, 'garbage -> closed');
eq(resolveRoomOwner({ OFFICE_DEFAULT_OWNER_ID: '*' }), { ok: false, reason: 'invalid' }, 'wildcard -> closed');
eq(
  resolveRoomOwner({ OFFICE_DEFAULT_OWNER_ID: `  ${A.toUpperCase()}  ` }),
  { ok: true, ownerId: A },
  'a uuid (trimmed, lowercased) -> that owner',
);
check(isUuid(A) && !isUuid('a-pub') && !isUuid('') && !isUuid(null), 'isUuid accepts only a uuid');

// ── 2 + 3. the listing ────────────────────────────────────────────────
console.log("\n2. the listing is one owner's published items on that owner's shelves");
const roomA = selectRoom({ ownerId: A, sections, items, jackets, pages: pageMap });
eq(roomA.map((s) => s.id), ['s-a1', 's-a2'], "A's sections only; the empty shelf is dropped");
eq(
  roomA.flatMap((s) => s.items.map((i) => i.id)),
  ['a-pub', 'a-no-doc', 'a-pub-2'],
  "only A's published items, in order",
);
const allIds = JSON.stringify(roomA);
check(!allIds.includes('b-pub') && !allIds.includes('b-in-a-section') && !allIds.includes('b-unpub'),
  "no row of B's reaches A's room — not even one filed into A's own section");
check(!allIds.includes('a-unpub'), 'an unpublished item of A stays off the shelf');
check(!allIds.includes('owner_id') && !allIds.includes('doc-a-pub') && !allIds.includes('section_id'),
  'owner ids, document ids and section ids stay behind the glass');
const first = roomA[0].items[0];
eq(
  [first.cover, first.pages, first.readable],
  ['https://cdn/jacket.jpg', 2, true],
  'jacket, page count and readable survive the scoping',
);
eq(roomA[0].items[1].readable, false, 'an item with no document is not readable');

const roomB = selectRoom({ ownerId: B, sections, items, jackets, pages: pageMap });
eq(roomB.map((s) => s.id), ['s-b1'], "B's own room would show only B's shelf");
check(!JSON.stringify(roomB).includes('a-pub'), "A's items never appear in B's room either");

console.log('\n3. no owner, no room');
eq(selectRoom({ ownerId: '', sections, items }), [], 'empty owner -> nothing');
eq(selectRoom({ ownerId: null, sections, items }), [], 'null owner -> nothing');
eq(selectRoom({ ownerId: 'everyone', sections, items }), [], 'non-uuid owner -> nothing');
eq(selectRoom({ ownerId: A, sections: [], items: [] }), [], 'no rows -> nothing');

// ── 4. the reading room applies the same rule ─────────────────────────
console.log('\n4. ?book= is gated exactly like the listing');
const byId = Object.fromEntries(items.map((i) => [i.id, i]));
check(selectBook({ ownerId: A, item: byId['a-pub'] })?.id === 'a-pub', "A's published book reads");
check(selectBook({ ownerId: A, item: byId['a-unpub'] }) === null, "A's unpublished book does not read");
check(selectBook({ ownerId: A, item: byId['b-pub'] }) === null, "B's published book does not read in A's room");
check(selectBook({ ownerId: A, item: byId['b-in-a-section'] }) === null,
  "B's book on A's shelf still does not read");
check(selectBook({ ownerId: A, item: byId['a-no-doc'] }) === null, 'an item with no document does not read');
check(selectBook({ ownerId: A, item: null }) === null, 'a missing row does not read');
check(selectBook({ ownerId: A, item: undefined }) === null, 'an undefined row does not read');
check(selectBook({ ownerId: '', item: byId['a-pub'] }) === null, 'with no configured owner, nothing reads');
check(selectBook({ ownerId: 'everyone', item: byId['a-pub'] }) === null, 'a non-uuid owner reads nothing');
check(
  selectBook({ ownerId: A, item: { ...byId['a-pub'], published: 'true' } }) === null,
  'published must be the boolean true, not a truthy string',
);
check(
  selectBook({ ownerId: A.toUpperCase(), item: { ...byId['a-pub'], owner_id: A.toUpperCase() } })?.id === 'a-pub',
  'owner comparison is case-insensitive on both sides',
);

// ── done ──────────────────────────────────────────────────────────────
console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
