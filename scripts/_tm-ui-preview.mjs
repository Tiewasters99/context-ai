// The headless browser check of the Trademark tab's slice-2 flow, at a phone
// (390×844, the primary target) and a desktop (1440×900), with screenshots.
//
// Everything is local and stubbed: PGlite with the REAL migrations 121 and 122
// (scripts/_tm-connector-fixture.mjs), the REAL /api/trademark and
// /api/sandbox handlers, a stub model, a stub TSDR, and vite serving the REAL
// components (scripts/tm-preview/). Nothing reaches USPTO, a model provider or
// Supabase.
//
//   npm i --no-save @electric-sql/pglite@0.5.8
//   node scripts/_tm-ui-preview.mjs [out-dir]
//
// The flow: the one box (three marks, one sentence) → the review screen →
// "Accept all" with initials → the search sheet → (the searches recorded) →
// triage on its own → the deep check (stub TSDR) → the application stage.

import {
  harness, makeDb, installFetch, stubModel, su, SB_URL, ADA, OPEN, FIXTURE_ROWS, Q7_ROWS,
} from './_tm-connector-fixture.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'docs', 'screenshots', 'trademark-slice2'));
fs.mkdirSync(OUT, { recursive: true });
const { check, section, done } = harness();

const db = await makeDb();
process.env.USPTO_TSDR_API_KEY = 'preview-stub-tsdr-key';
process.env.OPENAI_API_KEY = 'preview-stub-openai-key';
const stubTsdr = (url) => {
  const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
  return new Response(JSON.stringify({ transactionList: [{ trademarks: ids.map((s) => ({
    status: { serialNumber: Number(s), markElement: s === '97333333' ? 'QUALLEX' : s === '90562533' ? 'EQUASITE' : `REC ${s}`,
      status: s === '97222222' ? 602 : 800, tm5StatusDesc: s === '97222222' ? 'DEAD/APPLICATION/Abandoned' : 'LIVE/REGISTRATION/Issued and Active',
      filingDate: '2021-01-01', usRegistrationNumber: s === '97222222' ? null : '6900001', usRegistrationDate: s === '97222222' ? null : '2022-02-02' },
    parties: { currentOwners: [{ name: 'Some Owner LLC' }] },
    gsList: [{ description: 'Software', internationalClasses: [{ code: '9' }] }],
    prosecutionHistory: [{ entryDate: '2021-01-01', entryCode: 'NWAP', entryDesc: 'NEW APPLICATION ENTERED' }],
  })) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const net = installFetch(db, { anthropic: stubModel, tsdr: stubTsdr, openaiDown: true });

// Supabase Auth's /user, for the browser's session and the handlers' getUser().
const USER = { id: ADA, aud: 'authenticated', role: 'authenticated', email: 'reviewer@example.com', user_metadata: { display_name: 'Eden Quainton' }, app_metadata: {} };
const stubbed = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (href.startsWith(`${SB_URL}/auth/v1/user`)) return new Response(JSON.stringify(USER), { status: 200, headers: { 'content-type': 'application/json' } });
  return stubbed(input, init);
};

const trademark = (await import('../api/trademark.mjs')).default;
const sandbox = (await import('../api/sandbox.mjs')).default;

// A browser session token: the stub reads claims, it does not verify signatures.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: ADA, role: 'authenticated', aud: 'authenticated', aal: 'aal2', exp: 4102444800, email: USER.email })}.c2lnbmF0dXJl`;

// The local "Supabase" (and /api) the browser talks to.
const server = http.createServer(async (req, res) => {
  const cors = {
    'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*',
    'access-control-expose-headers': 'content-range, content-type',
  };
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

// Vite, on the real components, pointed at the local stub.
process.env.VITE_SUPABASE_URL = API;
process.env.VITE_SUPABASE_ANON_KEY = 'stub-anon-key';
const { createServer } = await import('vite');
const vite = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error',
  server: { port: 0, host: '127.0.0.1', proxy: { '/api': API } },
});
await vite.listen();
const VITE = vite.resolvedUrls.local[0].replace(/\/$/, '');
const PAGE = `${VITE}/scripts/tm-preview/index.html?t=${encodeURIComponent(TOKEN)}&m=${OPEN}`;

const puppeteer = (await import('puppeteer')).default;
const browser = await puppeteer.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [page error]', e.message));
const shots = [];
const shoot = async (name) => {
  for (const [w, h, tag] of [[390, 844, 'phone'], [1440, 900, 'desktop']]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await new Promise((r) => setTimeout(r, 300));
    const file = path.join(OUT, `${name}-${tag}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(!overflow, `${name} at ${w}×${h}: no horizontal page scroll`);
    shots.push(file);
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
};
const waitText = (t, timeout = 30000) => page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, t);
const clickText = async (selector, t) => {
  const ok = await page.evaluate((sel, x) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(x) && !e.disabled);
    if (!el) return false;
    el.click();
    return true;
  }, selector, t);
  if (!ok) throw new Error(`no enabled ${selector} "${t}"`);
};

section('the one box (phone first)');
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
await page.goto(PAGE, { waitUntil: 'networkidle0' });
await waitText('Start a clearance');
await page.type('textarea[aria-label="Marks, one per line"]', 'QUALLET\nQUIDDIT\nQUIRLD');
await page.type('textarea[aria-label="What the marks are for"]', 'A mobile wallet app and payment services for small businesses');
await shoot('1-one-box');
await clickText('button', 'Start 3 clearances');
await waitText('Review: 3 marks to confirm', 60000);
check(true, 'the one box opened three clearances and stopped at the review screen');
const [n] = await su(db, `select count(*)::int n, count(*) filter (where proposals ? 'classes' and proposals ? 'decompose')::int p, count(*) filter (where jsonb_array_length(search_classes) > 0)::int c from public.tm_clearances`);
check(n.n === 3 && n.p === 3 && n.c === 0, 'three clearances, proposals saved PROPOSED, none confirmed', JSON.stringify(n));
await shoot('2-review-screen');

section('accept all, one confirmation per mark');
await page.type('input[aria-label="Your initials"]', 'EQ');
await clickText('button', 'Accept all 3 as proposed');
await waitText('Search sheet', 60000);
const st = await su(db, `select count(*)::int n from public.tm_stages where stage in (1,2,3) and status = 'done' and initials = 'EQ' and done_by = $1`, [ADA]);
const q = await su(db, `select count(*)::int n from public.tm_queries`);
check(st[0].n === 9 && q[0].n > 20, 'stages 1–3 signed with EQ for each mark (9 sign-offs), the queries generated', `${st[0].n} sign-offs, ${q[0].n} queries`);
const ev = await su(db, `select count(*)::int n from public.events where kind = 'tm.stage.done' and actor_kind = 'user'`);
check(ev[0].n === 9, 'each sign-off its own Record row, the reviewer\'s');
await shoot('3-search-sheet');

section('the searches recorded → triage on its own');
// The person's tmsearch results, recorded through the UI's own path for Q0 of the first mark…
await clickText('button', 'Paste results');
await page.type('input[inputmode="numeric"]', '1');
await page.type('textarea[placeholder^="serial | mark"]', '90562533 | EQUASITE | Equasite Inc. | LIVE REGISTERED | 042 | Software as a service');
await clickText('button', 'Record run');
await page.waitForFunction(() => !document.body.innerText.includes('Recording…'), { timeout: 20000 });
// …and the rest straight into the database, as the same rows (speed, not a different path for the screens that follow).
const { callTool } = await import('../lib/mcp-core.mjs');
const { userScopedClient, callToolOptsFor } = await import('../lib/oauth-bearer.mjs');
const { trademarkToolOptsFor } = await import('../lib/trademark/connector-opts.mjs');
const sb = userScopedClient(ADA);
const identity = { userId: ADA, kind: 'user', tokenId: null, name: 'preview harness' };
const base = callToolOptsFor(identity, {});
const opts = { ...base, ...trademarkToolOptsFor(identity, sb, base, { supabaseUrl: SB_URL, serviceKey: 'unused' }) };
for (const c of await su(db, 'select id from public.tm_clearances')) {
  const g = await callTool(sb, 'tm_get_clearance', { clearance_id: c.id }, opts);
  for (const x of g.queries.filter((y) => !y.latest_run)) {
    const rows = x.purpose === 'selftest' ? FIXTURE_ROWS : x.purpose === 'prefix' ? Q7_ROWS : [];
    await callTool(sb, 'tm_record_results', { clearance_id: c.id, query_id: x.query_id, reported_count: rows.length, rows }, opts);
  }
}
await page.reload({ waitUntil: 'networkidle0' });
await waitText('Triage proposed for', 60000);
const tri = await su(db, `select count(*) filter (where proposed is not null)::int p, count(*) filter (where bin is not null)::int b from public.tm_hits`);
check(tri[0].p > 0 && tri[0].b === 0, 'triage proposed on its own when the last query was recorded; no bin decided', JSON.stringify(tri[0]));
await page.evaluate(() => document.getElementById('tm-stage-5')?.scrollIntoView());
await shoot('4-triage-proposed');

section('the deep check (stub TSDR)');
await clickText('button', 'Fetch official status');
await waitText('fetched', 30000);
await page.waitForFunction(() => !document.body.innerText.includes('Fetching…'), { timeout: 60000 });
const t = await su(db, `select count(*)::int n from public.tm_hits where tsdr is not null`);
check(t[0].n > 0, `official status stored on ${t[0].n} record(s)`);
await page.evaluate(() => document.getElementById('tm-stage-6')?.scrollIntoView());
await shoot('5-deep-check');

section('the application stage');
await page.evaluate(() => document.getElementById('tm-stage-9')?.scrollIntoView());
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#tm-stage-9 button[role="radio"]')].find((x) => x.textContent.trim() === 'No');
  b?.click();
});
await waitText('Add evidence');
await shoot('6-application');

await browser.close();
await vite.close();
await new Promise((r) => server.close(r));
check(net.log.refusedOutbound.length === 0, 'nothing left for the real USPTO, a real model or a real Supabase', net.log.refusedOutbound.join(' '));
console.log(`\nScreenshots:\n${shots.map((s) => `  ${s}`).join('\n')}`);
done();
