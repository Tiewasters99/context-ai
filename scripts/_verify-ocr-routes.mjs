// Which OCR route each tier would use from THIS environment, and — with
// --live — proof that a ready route reads a scan (Phase 4 of the ingestion
// plan, 2026-09-04). Run after provisioning per docs/SEALED_OCR_SETUP.md,
// and before trusting a sealed matter's scans to the worker.
//
//   node scripts/_verify-ocr-routes.mjs                 # ASSERTIONS (offline) + routes per tier here
//   node scripts/_verify-ocr-routes.mjs --live A        # OCR the fixture's two scanned pages through Tier A's routes
//   node scripts/_verify-ocr-routes.mjs --live B        # ... through the sealed route (Textract) — the provisioning proof
//   node scripts/_verify-ocr-routes.mjs --live A --each # every ready route of the tier, not just the first that works
//
// Reads .env from the repo root. --live costs a few cents on the Anthropic
// route and a fraction of a cent on the others; the fixture is fictional.
//
// 2026-09-20: without --live this script used to PRINT a table and exit 0
// whatever it printed — a "verify" that could not fail, and therefore proved
// nothing and could not be put in CI. The offline section below now asserts
// the policy it was only describing, over every combination of keys rather
// than over whatever happens to be in one .env: the one rule that must never
// bend is that a SEALED tier resolves only zero-retention routes, and that no
// environment variable, override or missing key can make it borrow an
// unsealed provider. That section runs first, always, and its exit code is
// the script's.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROUTES, TIER_ROUTES, OCR_TIER_A_DEFAULT, resolveOcrRoutes, tierRouteIds, tierIsSealed,
  ocrRouteReady, makeOcrProvider, describeOcrRoute,
} from '../lib/ocr-routes.mjs';
import { subsetPdf } from '../lib/ingest-core.mjs';
import { mixedPdf } from './_fixtures-ingest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(__dirname, '..', '.env');
const env = { ...process.env };
if (fs.existsSync(envFile)) {
  for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    if (!/^[A-Z_]+=/.test(l)) continue;
    const i = l.indexOf('=');
    const k = l.slice(0, i);
    if (env[k] == null) env[k] = l.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
}

const args = process.argv.slice(2);
const live = args.includes('--live');
const each = args.includes('--each');
const tierArg = (args[args.indexOf('--live') + 1] || 'A').toUpperCase();

// =============================================================================
// Offline assertions. Every one passes an EXPLICIT env object: CI has no .env,
// and an assertion that reads ambient keys proves something different on every
// machine it runs on.
// =============================================================================
let checks = 0;
const ok = (msg) => { checks++; console.log(`  ok  ${msg}`); };

const KEYS = ['GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'TEXTRACT_AWS_ACCESS_KEY_ID', 'TEXTRACT_AWS_SECRET_ACCESS_KEY', 'TEXTRACT_AI_OPT_OUT_CONFIRMED'];
// Every subset of the five keys that decide a route's readiness: 32 worlds,
// from "nothing is configured" to "everything is".
const WORLDS = [];
for (let mask = 0; mask < (1 << KEYS.length); mask++) {
  const env = {};
  KEYS.forEach((k, i) => { if (mask & (1 << i)) env[k] = k.startsWith('TEXTRACT_AI') ? '2026-09-05' : `value-for-${k}`; });
  WORLDS.push(env);
}
// Things someone might put in the one env var that CAN reorder routes,
// including attempts to name an unsealed route.
const OVERRIDES = [
  undefined, '', 'PASTE', 'gemini-flash', 'anthropic-vision',
  'anthropic-vision,gemini-flash', 'aws-textract', 'aws-textract,gemini-flash',
  'bogus', 'bogus,gemini-flash', '  anthropic-vision  ,bogus',
];

console.log('OCR route policy (offline assertions):');
{
  // 1. Route selection per tier, in one readable table of cases.
  const gemini = { GOOGLE_API_KEY: 'g' };
  const anthropic = { ANTHROPIC_API_KEY: 'a' };
  const textract = { TEXTRACT_AWS_ACCESS_KEY_ID: 'k', TEXTRACT_AWS_SECRET_ACCESS_KEY: 's', TEXTRACT_AI_OPT_OUT_CONFIRMED: '2026-09-05' };
  const ids = (tier, env) => resolveOcrRoutes(tier, env).routes.map((r) => r.id);
  assert.deepStrictEqual(TIER_ROUTES.A, OCR_TIER_A_DEFAULT);
  assert.deepStrictEqual(ids('A', { ...gemini, ...anthropic }), ['gemini-flash', 'anthropic-vision']);
  assert.deepStrictEqual(ids('A', gemini), ['gemini-flash']);
  assert.deepStrictEqual(ids('A', anthropic), ['anthropic-vision']);
  assert.deepStrictEqual(ids('A', { GOOGLE_API_KEY: 'PASTE', ...anthropic }), ['anthropic-vision']);
  assert.deepStrictEqual(ids('A', {}), []);
  assert.deepStrictEqual(ids('B', textract), ['aws-textract']);
  assert.deepStrictEqual(ids('B', { ...textract, TEXTRACT_AI_OPT_OUT_CONFIRMED: '' }), []);
  assert.deepStrictEqual(ids('C', { ...gemini, ...anthropic, ...textract }), []);
  ok('route selection per tier: A = Gemini then Anthropic (a missing or PASTE key drops that route alone); B = Textract, and only with the opt-out attestation; C = nothing, whatever is configured');

  // 2. THE rule. A sealed tier's resolved routes are all zero-retention, in
  //    every one of the 32 key worlds and under every override anyone could
  //    write — including one that names Gemini outright.
  let sealedCases = 0;
  for (const env of WORLDS) {
    for (const ov of OVERRIDES) {
      const e = ov === undefined ? env : { ...env, OCR_TIER_A_ROUTES: ov };
      for (const tier of ['B', 'C']) {
        assert(tierIsSealed(tier), `tier ${tier} must be sealed`);
        const plan = resolveOcrRoutes(tier, e);
        for (const r of plan.routes) {
          assert.strictEqual(r.zdr, true, `sealed tier ${tier} resolved non-sealed route ${r.id} (override ${JSON.stringify(ov)})`);
          assert(ocrRouteReady(r, e), `sealed tier ${tier} resolved a route whose keys are absent: ${r.id}`);
        }
        assert(!plan.routes.some((r) => r.provider === 'google' || r.provider === 'anthropic'),
          `sealed tier ${tier} resolved an unsealed provider (override ${JSON.stringify(ov)})`);
        assert.deepStrictEqual(tierRouteIds(tier, e), TIER_ROUTES[tier], `sealed tier ${tier} took an override`);
        if (!plan.routes.length) assert(typeof plan.reason === 'string' && plan.reason.length > 20, `tier ${tier} with no route gave no reason`);
        sealedCases++;
      }
    }
  }
  ok(`the sealed rule holds in ${sealedCases} environments (${WORLDS.length} key combinations × ${OVERRIDES.length} OCR_TIER_A_ROUTES values): every route a sealed tier resolves is zero-retention, ready, and named by policy — never by an override`);

  // 3. And at RUN time, not just at plan time: the sealed tier must not call
  //    an unsealed provider even when both are fully configured and the
  //    sealed one fails.
  const allKeys = { GOOGLE_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', ...textract, OCR_TIER_A_ROUTES: 'gemini-flash' };
  const called = [];
  const stub = (id, impl) => ({ ...ROUTES[id], run: async (...a) => { called.push(id); return impl(...a); } });
  const pages = [{ pageNumber: 1, text: 'one' }];
  const provider = makeOcrProvider(allKeys, { routes: {
    'gemini-flash': stub('gemini-flash', async () => ({ pages, model: 'gemini-2.5-flash' })),
    'anthropic-vision': stub('anthropic-vision', async () => ({ pages, model: 'claude-opus-5' })),
    'aws-textract': stub('aws-textract', async () => ({ pages, model: 'textract-detect-document-text', usage: { pages: 1 }, estimated_usd: 0.0015 })),
  } });
  const outB = await provider.run(Buffer.from('%PDF'), { tier: 'B' });
  assert.deepStrictEqual(called, ['aws-textract']);
  assert.strictEqual(outB.route.sealed, true);
  called.length = 0;
  const dead = makeOcrProvider(allKeys, { routes: {
    'gemini-flash': stub('gemini-flash', async () => ({ pages })),
    'anthropic-vision': stub('anthropic-vision', async () => ({ pages })),
    'aws-textract': stub('aws-textract', async () => { throw new Error('textract 500'); }),
  } });
  await assert.rejects(() => dead.run(Buffer.from('%PDF'), { tier: 'B' }), /every configured route/);
  assert.deepStrictEqual(called, ['aws-textract'], 'a failing sealed route must not fall back to an unsealed one');
  called.length = 0;
  await assert.rejects(() => provider.run(Buffer.from('%PDF'), { tier: 'C' }), /Silo/);
  assert.deepStrictEqual(called, [], 'Tier C must call nothing at all');
  ok('at run time: Tier B calls Textract and nothing else; when Textract fails it does NOT fall back to Gemini or Anthropic; Tier C calls no provider at all');

  // 4. The catalogue's own invariants — a route added later cannot quietly
  //    claim to be sealed without saying what it needs.
  for (const [id, r] of Object.entries(ROUTES)) {
    assert.strictEqual(r.id, id);
    assert(Array.isArray(r.requiredEnv) && r.requiredEnv.length, `${id} declares no requiredEnv`);
    assert(typeof r.run === 'function' && typeof r.label === 'string');
    assert.strictEqual(typeof r.zdr, 'boolean', `${id} does not say whether it is zero-retention`);
  }
  for (const tier of ['B', 'C']) {
    for (const id of TIER_ROUTES[tier]) assert.strictEqual(ROUTES[id].zdr, true, `policy lists non-sealed ${id} for sealed tier ${tier}`);
  }
  ok('catalogue: every route declares its id, env, label and zdr flag, and no sealed tier is mapped to a route that is not zero-retention');
}
console.log(`PASS — ${checks} offline checks\n`);

console.log('OCR routes by tier (from this environment):');
for (const tier of ['A', 'B', 'C']) {
  const plan = resolveOcrRoutes(tier, env);
  const ready = plan.routes.map((r) => `${r.id} (${r.label}${r.model ? `, ${r.model(env)}` : ''})`).join(' → ');
  console.log(`  Tier ${tier}: ${ready || 'no route'}${plan.notReady.length ? `   [not ready: ${plan.notReady.map((n) => `${n.id} needs ${n.missing.join(', ')}`).join('; ')}]` : ''}`);
  if (!plan.routes.length) console.log(`          ${plan.reason}`);
}
if (env.OCR_TIER_A_ROUTES) console.log(`  (Tier A order set by OCR_TIER_A_ROUTES=${env.OCR_TIER_A_ROUTES})`);

if (!live) {
  console.log('\nAdd --live A|B to OCR the two-page fixture through a tier\'s routes.');
  process.exit(0);
}

const plan = resolveOcrRoutes(tierArg, env);
if (!plan.routes.length) {
  console.log(`\nTier ${tierArg} has no ready route here — nothing to run. ${plan.reason}`);
  process.exit(2);
}
const pdf = await subsetPdf(await mixedPdf({ marker4: 'marmalade', marker5: 'quixotic' }), [4, 5]);
console.log(`\nFixture: 2 scanned pages (expect "marmalade" on the first, "quixotic" on the second), ${(pdf.length / 1024).toFixed(0)} KB`);

let failures = 0;
async function runRoute(route) {
  const t0 = Date.now();
  process.stdout.write(`\n[${route.id}] `);
  try {
    const out = await route.run(pdf, { env, onProgress: (m) => process.stdout.write(`\n   ${m.message}`) });
    const p1 = (out.pages[0]?.text || '');
    const p2 = (out.pages[1]?.text || '');
    const okWords = /marmalade/i.test(p1) && /quixotic/i.test(p2);
    console.log(`\n   ${(Date.now() - t0) / 1000}s · ${out.pages.length} page(s) · est. $${(out.estimated_usd ?? 0).toFixed(4)}${out.usage ? ` · usage ${JSON.stringify(out.usage)}` : ''}`);
    console.log(`   p1: ${p1.replace(/\s+/g, ' ').slice(0, 110)}`);
    console.log(`   p2: ${p2.replace(/\s+/g, ' ').slice(0, 110)}`);
    console.log(okWords ? '   ok   both marker words read on the right pages' : '   FAIL marker words not found where expected');
    if (!okWords) failures++;
  } catch (err) {
    failures++;
    console.log(`\n   FAIL ${err.message.split('\n')[0].slice(0, 300)}`);
  }
}

if (each) {
  for (const route of plan.routes) await runRoute(route);
} else {
  const provider = makeOcrProvider(env);
  const t0 = Date.now();
  try {
    const out = await provider.run(pdf, { tier: tierArg, onProgress: (m) => console.log(`   ${m.message}`) });
    console.log(`\n${describeOcrRoute(out.route)}  (${(Date.now() - t0) / 1000}s)`);
    const okWords = /marmalade/i.test(out.pages[0]?.text || '') && /quixotic/i.test(out.pages[1]?.text || '');
    console.log(`   p1: ${(out.pages[0]?.text || '').replace(/\s+/g, ' ').slice(0, 110)}`);
    console.log(`   p2: ${(out.pages[1]?.text || '').replace(/\s+/g, ' ').slice(0, 110)}`);
    console.log(okWords ? '   ok   both marker words read on the right pages' : '   FAIL marker words not found where expected');
    if (!okWords) failures++;
  } catch (err) {
    failures++;
    console.log(`\nFAIL ${err.message.split('\n')[0].slice(0, 300)}`);
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nPASS');
process.exit(failures ? 1 : 0);
