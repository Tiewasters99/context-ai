// Which OCR route each tier would use from THIS environment, and — with
// --live — proof that a ready route reads a scan (Phase 4 of the ingestion
// plan, 2026-09-04). Run after provisioning per docs/SEALED_OCR_SETUP.md,
// and before trusting a sealed matter's scans to the worker.
//
//   node scripts/_verify-ocr-routes.mjs                 # plan only: routes per tier, what is missing
//   node scripts/_verify-ocr-routes.mjs --live A        # OCR the fixture's two scanned pages through Tier A's routes
//   node scripts/_verify-ocr-routes.mjs --live B        # ... through the sealed route (Textract) — the provisioning proof
//   node scripts/_verify-ocr-routes.mjs --live A --each # every ready route of the tier, not just the first that works
//
// Reads .env from the repo root. --live costs a few cents on the Anthropic
// route and a fraction of a cent on the others; the fixture is fictional.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES, resolveOcrRoutes, makeOcrProvider, describeOcrRoute } from '../lib/ocr-routes.mjs';
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
