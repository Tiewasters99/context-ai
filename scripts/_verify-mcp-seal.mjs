// Live verification of the SecureSpace seal on the MCP tool layer
// (lib/mcp-core.mjs), run in-process against the REAL database as the REAL
// user (magiclink JWT → user-scoped client, exactly what api/mcp.mjs builds).
//
//   1. pick a matter WITH documents; remember its tier; seal it to B
//      (service role) — restored in `finally`
//   2. connector path (sealConnector: true):
//        list_matters            → sealed matter absent
//        list_matter_contents    → refused (sealed_matter)
//        get_outline / get_passage on a doc/passage inside → refused
//        search (all matters)    → no result from the sealed matter
//   3. in-app path (no flag): list_matter_contents works — the seal closes
//      connectors, not the room
//   4. inheritance: if the matter has a child, the child is sealed too
//   5. unsealed: after restore, the connector path sees the matter again
//
// Usage: node scripts/_verify-mcp-seal.mjs
import fs from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { callTool } from '../lib/mcp-core.mjs';
import { sealedMatterIds, matterTierWithClient } from '../lib/ai-tier-policy.mjs';

const txt = await fs.readFile(new URL('../.env', import.meta.url), 'utf8');
const env = {};
for (const line of txt.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = env.VITE_SUPABASE_URL, SRK = env.SUPABASE_SERVICE_ROLE_KEY, ANON = env.VITE_SUPABASE_ANON_KEY;
const OPENAI = env.OPENAI_API_KEY;

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => { console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d).slice(0, 300)}` : ''}`); failures++; };
const j = async (res) => { const t = await res.text(); try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: t }; } };
const H = { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' };

// ── sign in as the real user ──────────────────────────────────────────
let r = await j(await fetch(`${SB}/auth/v1/admin/generate_link`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ type: 'magiclink', email: 'equainton@gmail.com' }),
}));
const th = r.body?.hashed_token ?? r.body?.properties?.hashed_token;
r = await j(await fetch(`${SB}/auth/v1/verify`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', token_hash: th }),
}));
const jwt = r.body?.access_token;
if (!jwt) { console.log('sign-in failed', r); process.exit(1); }
console.log(`signed in as ${r.body.user.email}`);
const sb = createClient(SB, ANON, {
  global: { headers: { Authorization: `Bearer ${jwt}` } },
  auth: { persistSession: false, autoRefreshToken: false },
});
const admin = createClient(SB, SRK, { auth: { persistSession: false, autoRefreshToken: false } });

// ── pick a matter with at least one ready document (and a passage) ───
const { data: cand } = await admin
  .from('passages').select('matterspace_id, document_id, id').eq('summary_level', 0).limit(1);
const passage = cand?.[0];
if (!passage) { console.log('no passages found'); process.exit(1); }
const { data: matter } = await admin
  .from('matterspaces').select('id, name, ai_tier, parent_matterspace_id').eq('id', passage.matterspace_id).single();
const { data: kids } = await admin
  .from('matterspaces').select('id, name, ai_tier').eq('parent_matterspace_id', matter.id).limit(1);
const child = kids?.[0] ?? null;
const originalTier = matter.ai_tier;
console.log(`test matter: "${matter.name}" (tier ${originalTier})${child ? ` · child "${child.name}"` : ' · no child'} — sealing to B temporarily\n`);

const CONNECTOR = { openaiApiKey: OPENAI, sealConnector: true };
const INAPP = { openaiApiKey: OPENAI };
const expectSealed = async (label, fn) => {
  try { await fn(); fail(`${label}: expected refusal, got a result`); }
  catch (e) { if (e.code === 'sealed_matter') pass(`${label}: refused (sealed_matter)`); else fail(`${label}: wrong error`, e.message); }
};

// ── baseline: before sealing, nothing is sealed and the matter is listed ─
const before = await sealedMatterIds(sb);
console.log(`(currently sealed matters visible to user: ${before.size})`);

await admin.from('matterspaces').update({ ai_tier: 'B' }).eq('id', matter.id);
try {
  const eff = await matterTierWithClient(sb, matter.id);
  if (eff === 'B') pass('effective tier of the sealed matter reads B through the user client'); else fail('effective tier', eff);
  if (child) {
    const ceff = await matterTierWithClient(sb, child.id);
    if (ceff === 'B') pass('child inherits the seal (effective tier B)'); else fail('child effective tier', ceff);
  }

  // list_matters
  const listed = await callTool(sb, 'list_matters', {}, CONNECTOR);
  if (!listed.some((m) => m.id === matter.id)) pass('connector list_matters omits the sealed matter'); else fail('sealed matter listed to connector');
  if (child) {
    if (!listed.some((m) => m.id === child.id)) pass('connector list_matters omits the sealed child too'); else fail('sealed child listed to connector');
  }
  const listedInApp = await callTool(sb, 'list_matters', {}, INAPP);
  if (listedInApp.some((m) => m.id === matter.id)) pass('in-app list_matters still shows it (seal closes connectors, not the room)'); else fail('in-app list lost the matter');

  // keyed tools
  await expectSealed('connector list_matter_contents', () => callTool(sb, 'list_matter_contents', { matter: matter.id }, CONNECTOR));
  await expectSealed('connector get_outline on a doc inside', () => callTool(sb, 'get_outline', { doc: passage.document_id }, CONNECTOR));
  await expectSealed('connector get_passage on a passage inside', () => callTool(sb, 'get_passage', { id: passage.id }, CONNECTOR));
  await expectSealed('connector get_matter_state', () => callTool(sb, 'get_matter_state', { matter: matter.id }, CONNECTOR));
  await expectSealed('connector search scoped to the matter', () => callTool(sb, 'search', { matter: matter.id, q: 'the' }, CONNECTOR));
  if (child) await expectSealed('connector list_matter_contents on the child', () => callTool(sb, 'list_matter_contents', { matter: child.id }, CONNECTOR));

  // in-app still works
  const contents = await callTool(sb, 'list_matter_contents', { matter: matter.id }, INAPP);
  if (contents?.matter?.id === matter.id) pass('in-app list_matter_contents still works'); else fail('in-app contents broke', contents);

  // global search excludes the sealed matter (search a word from its own passage)
  const word = (passage && (await admin.from('passages').select('text').eq('id', passage.id).single()).data?.text || 'the')
    .split(/\s+/).find((w) => w.length > 5) || 'the';
  const hits = await callTool(sb, 'search', { q: word, limit: 10 }, CONNECTOR);
  const leaked = (hits.results || []).filter((h) => h.matter?.id === matter.id || (child && h.matter?.id === child.id));
  if (leaked.length === 0) pass(`connector global search returns nothing from the sealed matter (${hits.result_count} hits elsewhere)`);
  else fail('global search leaked sealed passages', leaked.slice(0, 2));
} finally {
  await admin.from('matterspaces').update({ ai_tier: originalTier }).eq('id', matter.id);
  const { data: chk } = await admin.from('matterspaces').select('ai_tier').eq('id', matter.id).single();
  console.log(`\nmatter restored to tier ${chk?.ai_tier}`);
}

// ── unsealed again: connector sees it ─────────────────────────────────
const after = await callTool(sb, 'list_matters', {}, CONNECTOR);
if (after.some((m) => m.id === matter.id)) pass('after restore, connector list_matters shows the matter again'); else fail('matter still hidden after restore');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);
