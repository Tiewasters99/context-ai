// A sealed matter's name is never printed on a credit-pack receipt.
//
// Why this exists
// ---------------------------------------------------------------------------
// A credit-pack purchase may be tagged to a matter, and the matter's NAME then
// goes on the Stripe line item and invoice — a document that leaves the
// system. Eden decided on 2026-09-25 that a sealed matter (tier B or C,
// lib/ai-tier-policy.mjs) may never be named there. The server gate is
// lib/billing.mjs matterNameForBuyer: it answers null for a sealed matter,
// and api/billing-credits-checkout.mjs refuses a null in the same words it
// uses for a matter the buyer cannot read.
//
// This drives the REAL matterNameForBuyer against a stubbed PostgREST fetch
// that serves a handful of matter rows by id, the way RLS would show them to
// one buyer. It proves:
//
//   1. an unsealed matter resolves to its name;
//   2. an explicitly sealed matter (B, and C) resolves to null;
//   3. a sub-matter of a sealed parent resolves to null although its own
//      ai_tier is 'A' — the seal is inherited;
//   4. a matter the buyer cannot read resolves to null;
//   5. a sub-matter whose parent the buyer cannot read resolves to null — the
//      walk fails closed, because RLS (migration 022) lets a direct member of
//      a sub-matter read it without its parent, and that parent may be sealed;
//   6. the read asks for ai_tier and parent_matterspace_id, so a regression
//      back to `select=id,name` (which would see every matter as tier A) fails.
//
// The PGlite half — that the widened select still runs against the real
// schema and RLS — is scripts/_verify-billing.mjs section G.
//
//   node scripts/_verify-credit-pack-sealed.mjs
//
// No .env, no network, no Supabase, no Stripe.

process.env.VITE_SUPABASE_URL = 'https://stub.supabase.test';
process.env.VITE_SUPABASE_ANON_KEY = 'anon-key-stub';

const { matterNameForBuyer } = await import('../lib/billing.mjs');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OPEN = id(1);
const SEALED_B = id(2);
const SEALED_C = id(3);
const CHILD_OF_SEALED = id(4);
const GRANDCHILD_OF_SEALED = id(5);
const UNREADABLE = id(6);
const HIDDEN_PARENT = id(7);
const CHILD_OF_HIDDEN = id(8);
const CHILD_OF_OPEN = id(9);

// What this buyer can see. HIDDEN_PARENT and UNREADABLE exist in the world but
// not in this map — to this buyer's token they come back as [] (RLS).
const ROWS = {
  [OPEN]: { id: OPEN, name: 'Peloso v. Curtis', ai_tier: 'A', parent_matterspace_id: null },
  [CHILD_OF_OPEN]: { id: CHILD_OF_OPEN, name: 'Peloso — Discovery', ai_tier: 'A', parent_matterspace_id: OPEN },
  [SEALED_B]: { id: SEALED_B, name: 'Calder v. Atlas', ai_tier: 'B', parent_matterspace_id: null },
  [SEALED_C]: { id: SEALED_C, name: 'In re Silo', ai_tier: 'C', parent_matterspace_id: null },
  [CHILD_OF_SEALED]: { id: CHILD_OF_SEALED, name: 'Calder — Experts', ai_tier: 'A', parent_matterspace_id: SEALED_B },
  [GRANDCHILD_OF_SEALED]: { id: GRANDCHILD_OF_SEALED, name: 'Calder — Experts — Damages', ai_tier: 'A', parent_matterspace_id: CHILD_OF_SEALED },
  [CHILD_OF_HIDDEN]: { id: CHILD_OF_HIDDEN, name: 'Shared sub-matter', ai_tier: 'A', parent_matterspace_id: HIDDEN_PARENT },
};

const requests = [];
async function postgrest(url, init = {}) {
  const u = new URL(url);
  requests.push({ url: u, auth: (init.headers || {}).authorization });
  const body = (() => {
    if (u.pathname !== '/rest/v1/matterspaces') return null;
    const m = /^eq\.(.+)$/.exec(u.searchParams.get('id') || '');
    const row = m ? ROWS[m[1]] : null;
    return row ? [row] : [];
  })();
  const text = JSON.stringify(body);
  return { ok: body !== null, status: body !== null ? 200 : 404, text: async () => text };
}

const name = (matterId) => matterNameForBuyer(matterId, 'usertoken:buyer', { fetchImpl: postgrest });

console.log('\nCredit-pack matter tag — sealed matters are never named');

check(await name(OPEN) === 'Peloso v. Curtis', 'unsealed matter → its name');
check(await name(CHILD_OF_OPEN) === 'Peloso — Discovery', 'unsealed sub-matter of an unsealed parent → its name');
check(await name(SEALED_B) === null, 'explicitly sealed matter (B) → null');
check(await name(SEALED_C) === null, 'explicitly sealed matter (C) → null');
check(await name(CHILD_OF_SEALED) === null, 'sub-matter (tier A) of a sealed parent → null');
check(await name(GRANDCHILD_OF_SEALED) === null, 'grandchild of a sealed matter → null');
check(await name(UNREADABLE) === null, 'matter the buyer cannot read → null');
check(await name(CHILD_OF_HIDDEN) === null, 'sub-matter whose parent the buyer cannot read → null (fails closed)');
check(await name('not-a-uuid') === null, 'malformed id → null, and no request made',
  requests.some((r) => r.url.href.includes('not-a-uuid')) ? 'a request was made' : '');

const reads = requests.filter((r) => r.url.pathname === '/rest/v1/matterspaces');
const select = reads[0]?.url.searchParams.get('select') || '';
check(reads.length > 0 && reads.every((r) => {
  const cols = (r.url.searchParams.get('select') || '').split(',');
  return cols.includes('ai_tier') && cols.includes('parent_matterspace_id');
}), 'every matter read asks for ai_tier and parent_matterspace_id', `select=${select}`);
check(reads.every((r) => r.auth === 'Bearer usertoken:buyer'),
  "every read (ancestors included) is made with the BUYER's token, not the service key");

console.log(`\n${failures === 0 ? 'credit-pack sealed rule verified.' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
