// The headless check of stage 4's choice (2026-10-21): "Search Equazia's copy
// of the register (as of <date>)" or "I'll run them on tmsearch", at a phone
// (390×844) and a desktop (1440×900), with screenshots.
//
// Local and stubbed, as scripts/_tm-ui-preview.mjs: PGlite with the REAL
// migrations 121, 122 and 123; the REAL /api/trademark handler; a LOCAL
// register copy (PGlite in a temp directory) loaded from the committed
// SYNTHETIC fixture; vite serving the REAL components (scripts/tm-preview/).
//
//   npm i --no-save @electric-sql/pglite@0.5.8
//   node scripts/_tm-register-ui-preview.mjs [out-dir]
//
// The flow: a clearance with its queries generated → the choice (the copy
// preliminary, tmsearch the default) → "Run N queries on the copy" → the runs
// labelled preliminary, stage 4's sign-off blocked → the copy switched off on
// the server → the first option reads "not available".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'docs', 'screenshots', 'trademark-register-copy'));
fs.mkdirSync(OUT, { recursive: true });
const REG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-register-ui-'));
process.env.TM_REGISTER_DB_URL = `pglite:${REG_DIR}`;

const { harness, makeDb, installFetch, stubModel, su, SB_URL, ADA, OPEN } = await import('./_tm-connector-fixture.mjs');
const { openRegisterDb } = await import('../lib/trademark/register/db.mjs');
const { applySchema, loadFile, stampAsOf } = await import('../lib/trademark/register/load.mjs');
const { check, section, done } = harness();

const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const reg = await openRegisterDb(process.env.TM_REGISTER_DB_URL);
await applySchema(reg);
await loadFile(reg, path.join(ROOT, 'scripts', 'fixtures', 'tm-register', 'apc-synthetic-backfile-20261018.xml'), { kind: 'fixture', asOf: yesterday });
await stampAsOf(reg, yesterday);

const db = await makeDb();
await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '123_trademark_register_copy.sql'), 'utf8'));
process.env.OPENAI_API_KEY = 'preview-stub-openai-key';
const net = installFetch(db, { anthropic: stubModel, openaiDown: true });

const USER = { id: ADA, aud: 'authenticated', role: 'authenticated', email: 'reviewer@example.com', user_metadata: { display_name: 'Eden Quainton' }, app_metadata: {} };
const stubbed = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (href.startsWith(`${SB_URL}/auth/v1/user`)) return new Response(JSON.stringify(USER), { status: 200, headers: { 'content-type': 'application/json' } });
  return stubbed(input, init);
};
const trademark = (await import('../api/trademark.mjs')).default;
const sandbox = (await import('../api/sandbox.mjs')).default;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: ADA, role: 'authenticated', aud: 'authenticated', aal: 'aal2', exp: 4102444800, email: USER.email })}.c2lnbmF0dXJl`;

const server = http.createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range, content-type' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  if (req.url.startsWith('/api/trademark') || req.url.startsWith('/api/sandbox')) {
    try { req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { req.body = {}; }
    const h = req.url.startsWith('/api/trademark') ? trademark : sandbox;
    try { await h(req, res); } catch (err) { res.statusCode = 500; res.end(String(err?.message || err)); }
    return;
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!['host', 'connection', 'content-length', 'origin', 'referer'].includes(k)) headers[k] = v;
  const r = await globalThis.fetch(`${SB_URL}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw });
  const out = Buffer.from(await r.arrayBuffer());
  const rh = { ...cors };
  r.headers.forEach((v, k) => { rh[k] = v; });
  res.writeHead(r.status, rh);
  res.end(out);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${server.address().port}`;

// One clearance, its queries generated, through the connector tools (the same data layer).
const { callTool } = await import('../lib/mcp-core.mjs');
const { userScopedClient, callToolOptsFor } = await import('../lib/oauth-bearer.mjs');
const { trademarkToolOptsFor } = await import('../lib/trademark/connector-opts.mjs');
const sb = userScopedClient(ADA);
const identity = { userId: ADA, kind: 'user', tokenId: null, name: 'preview harness' };
const base = callToolOptsFor(identity, {});
const opts = { ...base, ...trademarkToolOptsFor(identity, sb, base, { supabaseUrl: SB_URL, serviceKey: 'unused' }) };
const s = await callTool(sb, 'tm_start_clearance', { matter: OPEN, mark: 'EQUAZIA', goods_and_services: 'Software for legal research', known_marks: [{ name: 'EQUALL', owner: 'Equall Inc' }] }, opts);
const CL = s.clearance_id;
await callTool(sb, 'tm_confirm', { clearance_id: CL, step: 'classes', value: { search: [{ code: '009', reason: 'software' }, { code: '042', reason: 'SaaS' }, { code: '045', reason: 'legal' }], filing: [{ code: '042', reason: 'plan' }] } }, opts);
await callTool(sb, 'tm_confirm', { clearance_id: CL, step: 'decompose', value: { opening: 'equa', hinge: 'z', ending: 'ia', foreign_equivalents: ['equazione'] } }, opts);
const gen = await callTool(sb, 'tm_generate_queries', { clearance_id: CL }, opts);
for (const st of [1, 2, 3]) await su(db, `update public.tm_stages set status = 'done', initials = 'EQ', done_by = $2 where clearance_id = $1 and stage = $3`, [CL, ADA, st]);

process.env.VITE_SUPABASE_URL = API;
process.env.VITE_SUPABASE_ANON_KEY = 'stub-anon-key';
const { createServer } = await import('vite');
const vite = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0, host: '127.0.0.1', proxy: { '/api': API } } });
await vite.listen();
const PAGE = `${vite.resolvedUrls.local[0].replace(/\/$/, '')}/scripts/tm-preview/index.html?t=${encodeURIComponent(TOKEN)}&m=${OPEN}`;

const puppeteer = (await import('puppeteer')).default;
const browser = await puppeteer.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [page error]', e.message));
const shots = [];
const shoot = async (name) => {
  for (const [w, h, tag] of [[390, 844, 'phone'], [1440, 900, 'desktop']]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => document.querySelector('[aria-label="Where the queries run"]')?.scrollIntoView({ block: 'start' }));
    const file = path.join(OUT, `${name}-${tag}.png`);
    await page.screenshot({ path: file, fullPage: false });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(!overflow, `${name} at ${w}×${h}: no horizontal page scroll`);
    shots.push(file);
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
};
const waitText = (t, timeout = 30000) => page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, t);
const text = () => page.evaluate(() => document.body.innerText);

section('the choice, before any run');
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
await page.goto(PAGE, { waitUntil: 'networkidle0' });
await waitText('Where to run the queries');
let t = await text();
check(t.includes(`Search Equazia's copy of the register (as of ${yesterday})`), 'option 1 names the copy and its as-of date');
check(t.includes("I'll run them on tmsearch"), 'option 2: tmsearch');
check(/preliminary: confirm on tmsearch/.test(t), 'the copy is labelled preliminary (its recall test has not passed)');
const checked = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Where the queries run"] input[type=radio]')].slice(0, 2).map((x) => x.checked));
check(checked[0] === false && checked[1] === true, 'tmsearch is the default until the gate passes', JSON.stringify(checked));
await shoot('1-choice');

section('run on the copy');
await page.evaluate(() => { document.querySelector('[aria-label="Where the queries run"] input[type=radio]').click(); });
const n = gen.queries.length;
await waitText(`Run ${n} queries on the copy`);
await shoot('2-copy-chosen');
await page.evaluate((label) => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label)?.click(); }, `Run ${n} queries on the copy`);
await waitText(`${n} queries run on the copy`, 60000);
const runs = await su(db, `select count(*)::int n, count(*) filter (where register_preliminary)::int p from public.tm_query_runs where source = 'register_copy'`);
check(runs[0].n === n && runs[0].p === n, `the browser's run: ${n} runs recorded as register_copy, preliminary`, JSON.stringify(runs[0]));
const ev = await su(db, `select count(*)::int n from public.events where kind = 'tm.query.run' and actor_kind = 'user' and payload->>'source' = 'register_copy'`);
check(ev[0].n === n, 'each run its own Record row, the reviewer\'s (a browser run)');
await page.reload({ waitUntil: 'networkidle0' });
await waitText('Equazia register copy, as of');
t = await text();
check(t.includes(`Equazia register copy, as of ${yesterday} (preliminary: confirm on tmsearch)`), 'each run line shows the source, the as-of date and the label');
check(/ran only on Equazia's copy of the register \(preliminary\)/.test(t), 'stage 4\'s sign-off says why it is blocked');
await shoot('3-after-run');

section('feature off');
delete process.env.TM_REGISTER_DB_URL;
await page.reload({ waitUntil: 'networkidle0' });
await waitText('Where to run the queries');
t = await text();
check(t.includes("Search Equazia's copy of the register: not available") && /not available on this server/.test(t), 'with TM_REGISTER_DB_URL unset the first option reads "not available"');
const dis = await page.evaluate(() => document.querySelector('[aria-label="Where the queries run"] input[type=radio]').disabled);
check(dis === true, 'and cannot be chosen');
await shoot('4-not-available');

await browser.close();
await vite.close();
await new Promise((r) => server.close(r));
check(net.log.refusedOutbound.length === 0, 'nothing left for the real USPTO, a real model or a real Supabase', net.log.refusedOutbound.join(' '));
await reg.close();
fs.rmSync(REG_DIR, { recursive: true, force: true });
console.log(`\nScreenshots:\n${shots.map((x) => `  ${x}`).join('\n')}`);
done();
