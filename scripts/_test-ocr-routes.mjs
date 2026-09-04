// Unit checks for Phase 4 of the ingestion plan (2026-09-04) — "Capacity &
// resilience": the OCR route policy and fallback (lib/ocr-routes.mjs), the
// Textract and Anthropic providers' request/response handling with stubbed
// transports, long-recording segmenting (lib/media-segments.mjs) and the
// resumable-upload client (lib/tus-upload.mjs) against an in-memory TUS
// server. No network, no database, no ffmpeg. Run: node scripts/_test-ocr-routes.mjs
import assert from 'node:assert';
import crypto from 'node:crypto';
import {
  ROUTES, TIER_ROUTES, OCR_TIER_A_DEFAULT, resolveOcrRoutes, tierRouteIds, makeOcrProvider,
  ocrRouteRecord, describeOcrRoute, isOcrProvider,
} from '../lib/ocr-routes.mjs';
import { textractRequest, textFromBlocks, ocrPdfTextract, TEXTRACT_USD_PER_PAGE } from '../lib/ocr-textract.mjs';
import { ocrPdfAnthropic, estimateAnthropicUsd, textOf } from '../lib/ocr-anthropic.mjs';
import { parseDelimited, windowInstruction, ocrByWindows, OCR_PROMPT } from '../lib/ocr-protocol.mjs';
import {
  parseTimestamp, formatTimestamp, shiftTimestamps, joinSegmentTranscripts, transcribeInSegments, SEGMENT_SEC,
} from '../lib/media-segments.mjs';
import {
  encodeUploadMetadata, tusFingerprint, shouldUploadResumable, uploadResumable, memoryResumeStore,
  RESUMABLE_MIN_BYTES, TUS_CHUNK_BYTES,
} from '../lib/tus-upload.mjs';
import { describeOcrPending } from '../lib/ingest-formats.mjs';
import { extractPages } from '../lib/ingest-core.mjs';
import { mixedPdf } from './_fixtures-ingest.mjs';

let n = 0;
const ok = (msg) => { n++; console.log(`  ok  ${msg}`); };

// --- route policy -------------------------------------------------------------
{
  const both = { GOOGLE_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' };
  assert.deepStrictEqual(TIER_ROUTES.A, OCR_TIER_A_DEFAULT);
  assert.deepStrictEqual(resolveOcrRoutes('A', both).routes.map((r) => r.id), ['gemini-flash', 'anthropic-vision']);
  assert.deepStrictEqual(resolveOcrRoutes('A', { ANTHROPIC_API_KEY: 'a' }).routes.map((r) => r.id), ['anthropic-vision']);
  assert.deepStrictEqual(resolveOcrRoutes('A', { GOOGLE_API_KEY: 'PASTE', ANTHROPIC_API_KEY: 'a' }).routes.map((r) => r.id), ['anthropic-vision']);
  ok('Tier A: Gemini first, Anthropic second; a missing or PASTE key drops that route only');

  const none = resolveOcrRoutes('A', {});
  assert.strictEqual(none.routes.length, 0);
  assert(/gemini-flash needs GOOGLE_API_KEY/.test(none.reason) && /anthropic-vision needs ANTHROPIC_API_KEY/.test(none.reason), none.reason);
  ok('Tier A with no keys: no route, and the reason names each route and its key');

  assert.deepStrictEqual(tierRouteIds('A', { OCR_TIER_A_ROUTES: 'anthropic-vision,gemini-flash' }), ['anthropic-vision', 'gemini-flash']);
  assert.deepStrictEqual(tierRouteIds('A', { OCR_TIER_A_ROUTES: 'bogus, anthropic-vision' }), ['anthropic-vision']);
  assert.deepStrictEqual(tierRouteIds('A', { OCR_TIER_A_ROUTES: 'bogus' }), OCR_TIER_A_DEFAULT);
  assert.deepStrictEqual(tierRouteIds('B', { OCR_TIER_A_ROUTES: 'gemini-flash' }), ['aws-textract']);
  ok('OCR_TIER_A_ROUTES flips the Tier A order; unknown ids are ignored; a sealed tier takes no override');

  const b = resolveOcrRoutes('B', both);
  assert.strictEqual(b.routes.length, 0);
  assert(/sealed OCR route for Tier B/.test(b.reason) && /TEXTRACT_AWS_ACCESS_KEY_ID, TEXTRACT_AWS_SECRET_ACCESS_KEY, TEXTRACT_AI_OPT_OUT_CONFIRMED/.test(b.reason) && /SEALED_OCR_SETUP/.test(b.reason), b.reason);
  ok('Tier B with only unsealed keys: NO route (never borrows Gemini/Anthropic); the reason names the three TEXTRACT vars and the runbook');

  const tx = { TEXTRACT_AWS_ACCESS_KEY_ID: 'AKIA', TEXTRACT_AWS_SECRET_ACCESS_KEY: 's', TEXTRACT_AI_OPT_OUT_CONFIRMED: '2026-09-05' };
  assert.deepStrictEqual(resolveOcrRoutes('B', { ...both, ...tx }).routes.map((r) => r.id), ['aws-textract']);
  assert.strictEqual(resolveOcrRoutes('B', { ...both, ...tx, TEXTRACT_AI_OPT_OUT_CONFIRMED: '' }).routes.length, 0);
  ok('Tier B with the Textract trio: Textract only; without the opt-out attestation the route is not ready (fail closed)');

  const c = resolveOcrRoutes('C', { ...both, ...tx });
  assert.strictEqual(c.routes.length, 0);
  assert(/Silo/.test(c.reason));
  ok('Tier C: no cloud route whatever keys exist');
  assert(Object.values(ROUTES).every((r) => Array.isArray(r.requiredEnv) && typeof r.run === 'function' && typeof r.label === 'string'));
  ok('every catalogue route declares its env, a label and a run()');
}

// --- provider: fallback within a tier ----------------------------------------
{
  const stubs = (impl) => ({
    'gemini-flash': { ...ROUTES['gemini-flash'], run: impl.gemini },
    'anthropic-vision': { ...ROUTES['anthropic-vision'], run: impl.anthropic },
    'aws-textract': { ...ROUTES['aws-textract'], run: impl.textract },
  });
  const env = { GOOGLE_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', TEXTRACT_AWS_ACCESS_KEY_ID: 'k', TEXTRACT_AWS_SECRET_ACCESS_KEY: 's', TEXTRACT_AI_OPT_OUT_CONFIRMED: 'yes' };
  const pages = [{ pageNumber: 1, text: 'one' }, { pageNumber: 2, text: 'two' }];
  const calls = [];
  const p = makeOcrProvider(env, { routes: stubs({
    gemini: async () => { calls.push('g'); throw new Error('gemini 403: Lightning dunning decision is deny'); },
    anthropic: async () => { calls.push('a'); return { pages, model: 'claude-opus-5', usage: { input_tokens: 4000, output_tokens: 800 }, estimated_usd: 0.04 }; },
    textract: async () => { calls.push('t'); return { pages, model: 'textract-detect-document-text', usage: { pages: 2 }, estimated_usd: 0.003 }; },
  }) });
  assert(isOcrProvider(p));
  const msgs = [];
  const out = await p.run(Buffer.from('pdf'), { tier: 'A', onProgress: (m) => msgs.push(m.message) });
  assert.deepStrictEqual(calls, ['g', 'a']);
  assert.deepStrictEqual(out.pages, pages);
  assert.strictEqual(out.route.id, 'anthropic-vision');
  assert.strictEqual(out.route.model, 'claude-opus-5');
  assert.strictEqual(out.route.pages, 2);
  assert.strictEqual(out.route.estimated_usd, 0.04);
  assert.strictEqual(out.route.sealed, false);
  assert.deepStrictEqual(out.route.fallback_from.map((f) => f.id), ['gemini-flash']);
  assert(/Lightning dunning/.test(out.route.fallback_from[0].error));
  assert(msgs.some((m) => /Gemini failed .* trying Anthropic vision/.test(m)), msgs.join('|'));
  ok('Tier A: Gemini throws → Anthropic reads the pages; the record names the route, model, pages, cost and the failed route');

  calls.length = 0;
  const outB = await p.run(Buffer.from('pdf'), { tier: 'B' });
  assert.deepStrictEqual(calls, ['t']);
  assert.strictEqual(outB.route.id, 'aws-textract');
  assert.strictEqual(outB.route.sealed, true);
  ok('Tier B: Textract only, never the unsealed routes, recorded as sealed');

  const dead = makeOcrProvider(env, { routes: stubs({
    gemini: async () => { throw new Error('gemini 503'); },
    anthropic: async () => { throw new Error('anthropic 529 overloaded'); },
    textract: async () => { throw new Error('unused'); },
  }) });
  await assert.rejects(() => dead.run(Buffer.from('pdf'), { tier: 'A' }), (err) => /every configured route/.test(err.message) && /gemini-flash: gemini 503/.test(err.message) && /anthropic-vision: anthropic 529/.test(err.message));
  ok('every route down: one error naming each route and its failure (what ocr_pending records)');

  await assert.rejects(() => makeOcrProvider({}, { routes: stubs({}) }).run(Buffer.from('pdf'), { tier: 'A' }), /OCR is not configured/);
  assert.strictEqual(makeOcrProvider({}).configured(), false);
  assert.strictEqual(makeOcrProvider({ ANTHROPIC_API_KEY: 'a' }).configured(), true);
  ok('no ready route: run() refuses with the plan reason; configured() says whether any tier could OCR here');

  const rec = ocrRouteRecord(ROUTES['anthropic-vision'], { pages, model: 'claude-opus-5', estimated_usd: 0.3141, usage: { input_tokens: 1 } }, { attempts: [{ id: 'gemini-flash', error: 'gemini 503\nsecond line' }] });
  assert.strictEqual(rec.estimated_usd, 0.3141);
  assert.strictEqual(rec.fallback_from[0].error, 'gemini 503');
  assert.strictEqual(describeOcrRoute(rec), 'OCR: 2 pages read by Anthropic vision (claude-opus-5), about $0.31 after gemini-flash failed.');
  assert.strictEqual(describeOcrRoute(ocrRouteRecord(ROUTES['aws-textract'], { pages: [{ pageNumber: 1, text: 'x' }], model: 'textract-detect-document-text', estimated_usd: 0.0015 })),
    'OCR: 1 page read by AWS Textract (our own AWS account) at well under a cent — inside the seal.');
  assert.strictEqual(describeOcrRoute(ocrRouteRecord(ROUTES['gemini-flash'], { pages, model: 'gemini-2.5-flash', estimated_usd: 0.004 })), 'OCR: 2 pages read by Gemini (gemini-2.5-flash) at well under a cent.');
  assert.strictEqual(describeOcrRoute(null), null);
  ok('describeOcrRoute: one sentence a person can read — who, what model, the cost, the fallback, the seal');
}

// --- shared protocol ------------------------------------------------------------
{
  const out = parseDelimited('<<<PAGE 4>>>\nfour\n<<<PAGE 5>>>\n[no legible text]\n', [4, 5, 6]);
  assert.deepStrictEqual(out, [{ pageNumber: 4, text: 'four' }, { pageNumber: 5, text: '' }, { pageNumber: 6, text: '' }]);
  assert(windowInstruction([4, 5]).startsWith(OCR_PROMPT) && /numbering them: 4, 5/.test(windowInstruction([4, 5])));
  ok('parseDelimited maps markers to pages, blanks "[no legible text]", fills missing pages with empty text');

  const pdf = await mixedPdf();
  const seen = [];
  const pages = await ocrByWindows(pdf, { window: 2, concurrency: 2 }, async (bytes, absNums) => {
    seen.push(absNums);
    const sub = await extractPages(bytes, '.pdf');
    assert.strictEqual(sub.length, absNums.length);
    return absNums.map((p) => ({ pageNumber: p, text: `p${p}` }));
  });
  assert.deepStrictEqual(seen.sort((a, b) => a[0] - b[0]), [[1, 2], [3, 4], [5]]);
  assert.deepStrictEqual(pages.map((p) => p.text), ['p1', 'p2', 'p3', 'p4', 'p5']);
  ok('ocrByWindows: 5 pages in windows of 2, each window a readable sub-PDF of exactly those pages, results in page order');
}

// --- Textract ---------------------------------------------------------------------
{
  const cfg = { region: 'us-east-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: new Date('2026-09-04T12:00:00Z') };
  const bytes = Buffer.from('%PDF-1.4 one page');
  const req = textractRequest(bytes, cfg);
  assert.strictEqual(req.url, 'https://textract.us-east-1.amazonaws.com/');
  assert.strictEqual(req.headers['x-amz-target'], 'Textract.DetectDocumentText');
  assert.strictEqual(req.headers['content-type'], 'application/x-amz-json-1.1');
  assert.strictEqual(req.headers['x-amz-date'], '20260904T120000Z');
  assert(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260904\/us-east-1\/textract\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/.test(req.headers.authorization), req.headers.authorization);
  assert.deepStrictEqual(JSON.parse(req.body), { Document: { Bytes: bytes.toString('base64') } });
  assert.strictEqual(textractRequest(bytes, cfg).headers.authorization, req.headers.authorization);
  ok('Textract request: our-account endpoint, DetectDocumentText target, SigV4 over content-type/host/date/target, bytes inline, deterministic');

  assert.strictEqual(textFromBlocks([
    { BlockType: 'PAGE' }, { BlockType: 'LINE', Text: 'EXHIBIT A' }, { BlockType: 'WORD', Text: 'EXHIBIT' }, { BlockType: 'LINE', Text: 'forty jars' },
  ]), 'EXHIBIT A\nforty jars');
  assert.strictEqual(textFromBlocks(null), '');
  ok('Textract response: LINE blocks joined in order; PAGE and WORD ignored');

  const pdf = await mixedPdf();
  const requests = [];
  let throttled = false;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const pageBytes = Buffer.from(body.Document.Bytes, 'base64');
    const sub = await extractPages(pageBytes, '.pdf');
    requests.push({ url, target: init.headers['x-amz-target'], pages: sub.length });
    if (!throttled) { throttled = true; return new Response(JSON.stringify({ __type: 'com.amazonaws.textract#ThrottlingException', message: 'slow down' }), { status: 400 }); }
    return new Response(JSON.stringify({ Blocks: [{ BlockType: 'LINE', Text: `line for request ${requests.length}` }] }), { status: 200 });
  };
  const env = { TEXTRACT_AWS_ACCESS_KEY_ID: 'k', TEXTRACT_AWS_SECRET_ACCESS_KEY: 's', TEXTRACT_AWS_REGION: 'us-west-2' };
  const out = await ocrPdfTextract(pdf, { env, fetchImpl, concurrency: 2 });
  assert.strictEqual(out.pages.length, 5);
  assert(requests.every((r) => r.pages === 1 && r.url === 'https://textract.us-west-2.amazonaws.com/' && r.target === 'Textract.DetectDocumentText'));
  assert.strictEqual(requests.length, 6, 'five pages plus one throttled retry');
  assert(out.pages.every((p) => /^line for request \d$/.test(p.text)));
  assert.strictEqual(out.estimated_usd, 5 * TEXTRACT_USD_PER_PAGE);
  assert.strictEqual(out.usage.pages, 5);
  ok('ocrPdfTextract: one single-page request per page in the chosen region, a ThrottlingException is retried, every page filled, cost = pages × rate');

  await assert.rejects(() => ocrPdfTextract(pdf, { env, fetchImpl: async () => new Response(JSON.stringify({ __type: 'UnsupportedDocumentException' }), { status: 400 }) }), /UnsupportedDocumentException/);
  await assert.rejects(() => ocrPdfTextract(pdf, { env: {} }), /TEXTRACT_AWS_ACCESS_KEY_ID/);
  ok('ocrPdfTextract: a non-retryable Textract error surfaces by name; missing credentials refuse before any request');
}

// --- Anthropic ----------------------------------------------------------------------
{
  assert.strictEqual(estimateAnthropicUsd('claude-opus-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 30);
  assert.strictEqual(estimateAnthropicUsd('claude-sonnet-5', { input_tokens: 1_000_000 }), 2);
  assert.strictEqual(estimateAnthropicUsd('claude-unknown', { output_tokens: 1_000_000 }), 25);
  ok('cost estimate: list prices per model; an unknown model is priced at the Opus rate, never lower');

  const pdf = await mixedPdf();
  const seen = [];
  const fake = {
    beta: { messages: { stream: (params) => ({
      finalMessage: async () => {
        const doc = params.messages[0].content[0];
        const text = params.messages[0].content[1].text;
        assert.strictEqual(doc.type, 'document');
        assert.strictEqual(doc.source.media_type, 'application/pdf');
        assert.strictEqual(params.fallbacks, 'default');
        assert.deepStrictEqual(params.betas, ['server-side-fallback-2026-07-01']);
        assert.deepStrictEqual(params.output_config, { effort: 'low' });
        const nums = /numbering them: ([\d, ]+)/.exec(text)[1].split(', ').map(Number);
        const sub = await extractPages(Buffer.from(doc.source.data, 'base64'), '.pdf');
        assert.strictEqual(sub.length, nums.length);
        seen.push(nums);
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: nums.map((p) => `<<<PAGE ${p}>>>\nanthropic page ${p}`).join('\n') }],
          usage: { input_tokens: 1000 * nums.length, output_tokens: 100 * nums.length },
        };
      },
    }) } },
  };
  const out = await ocrPdfAnthropic(pdf, { client: fake, model: 'claude-opus-5', window: 3, concurrency: 1 });
  assert.deepStrictEqual(seen, [[1, 2, 3], [4, 5]]);
  assert.deepStrictEqual(out.pages.map((p) => p.text), [1, 2, 3, 4, 5].map((p) => `anthropic page ${p}`));
  assert.deepStrictEqual(out.usage, { input_tokens: 5000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, requests: 2 });
  assert.strictEqual(out.estimated_usd, (5000 * 5 + 500 * 25) / 1e6);
  ok('ocrPdfAnthropic: base64 PDF document per window, low effort, server-side fallbacks on, pages mapped by marker, usage summed into an estimate');

  const refusing = { beta: { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'refusal', stop_details: { category: 'graphic' }, content: [], usage: { input_tokens: 1, output_tokens: 0 } }) }) } } };
  await assert.rejects(() => ocrPdfAnthropic(pdf, { client: refusing }), /declined to transcribe page\(s\) 1, 2, 3, 4, 5 \(graphic\)/);
  const truncating = { beta: { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '<<<PAGE 1>>>\nhalf' }], usage: {} }) }) } } };
  await assert.rejects(() => ocrPdfAnthropic(pdf, { client: truncating }), /truncated/);
  assert.strictEqual(textOf({ content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab');
  ok('a refusal or a truncated window fails the window (the route falls back or records the pages) — never silent empty pages');
}

// --- long recordings --------------------------------------------------------------
{
  assert.strictEqual(parseTimestamp('[00:05]'), 5);
  assert.strictEqual(parseTimestamp('[1:02:03]'), 3723);
  assert.strictEqual(parseTimestamp('nope'), null);
  assert.strictEqual(formatTimestamp(5), '[00:05]');
  assert.strictEqual(formatTimestamp(3599), '[59:59]');
  assert.strictEqual(formatTimestamp(3600), '[1:00:00]');
  assert.strictEqual(shiftTimestamps('[00:05] Speaker 1: hello\n[59:30] Speaker 2: bye\n[00:07] VISUAL: door', 1200),
    '[20:05] Speaker 1: hello\n[1:19:30] Speaker 2: bye\n[20:07] VISUAL: door');
  assert.strictEqual(shiftTimestamps('[00:05] x', 0), '[00:05] x');
  ok('timestamps: parse/format round-trip, the hour form from 1:00:00, every bracketed stamp shifted by the part offset');

  const joined = joinSegmentTranscripts([{ offsetSec: 0, text: '[00:01] Speaker 1: first' }, { offsetSec: 1200, text: '[00:02] Speaker 1: second' }]);
  assert.strictEqual(joined, '[00:01] Speaker 1: first\n\n[20:00] — part 2 of 2 (speaker labels restart here)\n\n[20:02] Speaker 1: second');
  ok('joined transcript: parts in order, a seam line at each boundary saying labels restart');

  const calls = [];
  const res = await transcribeInSegments(Buffer.from('audio'), '.m4a', {
    probe: async () => 2500,
    segment: async () => [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')],
    transcribeSegment: async (buf, { index, total, offsetSec }) => { calls.push([buf.toString(), index, total, offsetSec]); return [{ pageNumber: 1, text: `[00:10] Speaker 1: part ${index + 1}` }]; },
  });
  assert.deepStrictEqual(calls, [['a', 0, 3, 0], ['b', 1, 3, 1200], ['c', 2, 3, 2400]]);
  assert.strictEqual(res.segments, 3);
  assert.strictEqual(res.durationSec, 2500);
  assert(res.pages[0].text.includes('[00:10] Speaker 1: part 1') && res.pages[0].text.includes('[20:10] Speaker 1: part 2') && res.pages[0].text.includes('[40:10] Speaker 1: part 3'));
  assert.strictEqual(await transcribeInSegments(Buffer.from('audio'), '.mp3', { probe: async () => SEGMENT_SEC, segment: async () => { throw new Error('must not cut'); }, transcribeSegment: async () => [] }), null);
  assert.strictEqual(await transcribeInSegments(Buffer.from('audio'), '.mp3', { probe: async () => null, segment: async () => { throw new Error('must not cut'); }, transcribeSegment: async () => [] }), null);
  ok('a 41-min recording → 3 parts transcribed in order with offsets 0/20/40 min; a 20-min or unmeasurable one is left to the whole-file path');
}

// --- resumable uploads ------------------------------------------------------------
{
  assert.strictEqual(encodeUploadMetadata({ bucketName: 'vault-documents', objectName: 'a/b.pdf', contentType: 'application/pdf', cacheControl: '3600', empty: '' }),
    `bucketName ${Buffer.from('vault-documents').toString('base64')},objectName ${Buffer.from('a/b.pdf').toString('base64')},contentType ${Buffer.from('application/pdf').toString('base64')},cacheControl ${Buffer.from('3600').toString('base64')}`);
  assert.strictEqual(tusFingerprint({ bucket: 'b', objectName: 'o', size: 5, lastModified: 7 }), 'tus:b/o:5:7');
  assert.strictEqual(shouldUploadResumable(RESUMABLE_MIN_BYTES - 1), false);
  assert.strictEqual(shouldUploadResumable(RESUMABLE_MIN_BYTES), true);
  assert.strictEqual(TUS_CHUNK_BYTES, 6 * 1024 * 1024);
  ok('TUS metadata encoding, fingerprint, the 50 MB threshold and the 6 MB chunk Supabase requires');

  // An in-memory TUS server: create → PATCH chunks → HEAD reports the offset.
  function tusServer({ failPatchOnce = null } = {}) {
    const uploads = new Map();
    const log = [];
    let failed = false;
    const fetchImpl = async (url, init = {}) => {
      const m = (init.method || 'GET').toUpperCase();
      log.push(`${m} ${url.replace(/^https:\/\/x\.supabase\.co/, '')}`);
      assert.strictEqual(init.headers['tus-resumable'], '1.0.0');
      assert.strictEqual(init.headers.authorization, 'Bearer tok');
      assert.strictEqual(init.headers.apikey, 'anon');
      if (m === 'POST') {
        assert(url.endsWith('/storage/v1/upload/resumable'));
        const id = crypto.randomUUID();
        uploads.set(id, { length: Number(init.headers['upload-length']), offset: 0, chunks: [], meta: init.headers['upload-metadata'] });
        return new Response(null, { status: 201, headers: { location: `/storage/v1/upload/resumable/${id}` } });
      }
      const id = url.split('/').pop();
      const u = uploads.get(id);
      if (!u) return new Response('gone', { status: 404 });
      if (m === 'HEAD') return new Response(null, { status: 200, headers: { 'upload-offset': String(u.offset), 'upload-length': String(u.length) } });
      if (m === 'PATCH') {
        const off = Number(init.headers['upload-offset']);
        if (off !== u.offset) return new Response('conflict', { status: 409 });
        const bytes = Buffer.from(await init.body.arrayBuffer());
        if (failPatchOnce != null && u.chunks.length === failPatchOnce && !failed) {
          // The server took the bytes but the client never heard back.
          failed = true;
          u.chunks.push(bytes); u.offset += bytes.length;
          throw new TypeError('fetch failed: network dropped');
        }
        u.chunks.push(bytes); u.offset += bytes.length;
        return new Response(null, { status: 204, headers: { 'upload-offset': String(u.offset) } });
      }
      return new Response('nope', { status: 405 });
    };
    return { fetchImpl, uploads, log, bytesOf: (id) => Buffer.concat(uploads.get(id).chunks) };
  }
  const data = crypto.randomBytes(2500);
  const blob = new Blob([data]);
  const common = { supabaseUrl: 'https://x.supabase.co/', token: 'tok', apikey: 'anon', bucket: 'vault-documents', objectName: 'm/d/big.bin', blob, chunkBytes: 1000, sleepImpl: async () => {} };

  {
    const srv = tusServer();
    const progress = [];
    const res = await uploadResumable({ ...common, fetchImpl: srv.fetchImpl, onProgress: (p) => progress.push(p.sent) });
    const id = res.uploadUrl.split('/').pop();
    assert(Buffer.compare(srv.bytesOf(id), data) === 0);
    assert.deepStrictEqual(progress, [0, 1000, 2000, 2500]);
    assert.strictEqual(res.resumedFrom, 0);
    assert.deepStrictEqual(srv.log.map((l) => l.split(' ')[0]), ['POST', 'PATCH', 'PATCH', 'PATCH']);
    assert.strictEqual(srv.uploads.get(id).meta, encodeUploadMetadata({ bucketName: 'vault-documents', objectName: 'm/d/big.bin', contentType: 'application/octet-stream', cacheControl: '3600' }));
    ok('clean upload: create, three PATCHes of 1000/1000/500, bytes identical, progress after every chunk');
  }
  {
    const srv = tusServer({ failPatchOnce: 1 });
    const res = await uploadResumable({ ...common, fetchImpl: srv.fetchImpl });
    const id = res.uploadUrl.split('/').pop();
    assert(Buffer.compare(srv.bytesOf(id), data) === 0);
    assert.deepStrictEqual(srv.log.map((l) => l.split(' ')[0]), ['POST', 'PATCH', 'PATCH', 'HEAD', 'PATCH']);
    ok('connection drops after the server took chunk 2: HEAD learns the real offset, upload continues from byte 2000 — no duplicate, no restart');
  }
  {
    const srv = tusServer();
    const store = memoryResumeStore();
    const ac = new AbortController();
    let sent = 0;
    await assert.rejects(() => uploadResumable({ ...common, fetchImpl: srv.fetchImpl, resumeStore: store, signal: ac.signal, onProgress: (p) => { sent = p.sent; if (p.sent >= 1000) ac.abort(new Error('tab closed')); } }), /tab closed/);
    assert.strictEqual(sent, 1000);
    const res = await uploadResumable({ ...common, fetchImpl: srv.fetchImpl, resumeStore: store });
    const id = res.uploadUrl.split('/').pop();
    assert.strictEqual(res.resumedFrom, 1000);
    assert(Buffer.compare(srv.bytesOf(id), data) === 0);
    assert.strictEqual(srv.log.filter((l) => l.startsWith('POST')).length, 1, 'the second call resumed the first upload instead of creating another');
    assert.strictEqual(store.get(tusFingerprint({ bucket: 'vault-documents', objectName: 'm/d/big.bin', size: 2500, lastModified: 0 })), null, 'bookmark cleared on completion');
    ok('aborted after 1000 bytes (tab closed), called again with the same store: resumes at 1000 from the remembered URL and finishes; bookmark cleared');
  }
  {
    const srv = tusServer();
    const store = memoryResumeStore();
    store.set(tusFingerprint({ bucket: 'vault-documents', objectName: 'm/d/big.bin', size: 2500, lastModified: 0 }), 'https://x.supabase.co/storage/v1/upload/resumable/expired');
    const res = await uploadResumable({ ...common, fetchImpl: srv.fetchImpl, resumeStore: store });
    assert.strictEqual(res.resumedFrom, 0);
    assert.deepStrictEqual(srv.log.map((l) => l.split(' ')[0]), ['HEAD', 'POST', 'PATCH', 'PATCH', 'PATCH']);
    ok('a remembered URL the server no longer knows (expired after 24 h): HEAD 404 → start fresh, quietly');
  }
}

// --- words ---------------------------------------------------------------------------
{
  const d = describeOcrPending({ pages: [4, 5], page_count: 5, held: true, reason: 'SecureSpace seal — 2 scanned page(s) were not sent out for OCR. The sealed OCR route for Tier B is not configured where this ran: aws-textract needs TEXTRACT_AWS_ACCESS_KEY_ID.' });
  assert(/SEALED_OCR_SETUP/.test(d.detail) && /Re-run/.test(d.detail));
  assert.strictEqual(d.label, "2 pages not OCR'd — SecureSpace seal");
  ok('the held record tells a person where the sealed route is provisioned and that a Re-run follows');
}

console.log(`\nPASS — ${n} checks`);
