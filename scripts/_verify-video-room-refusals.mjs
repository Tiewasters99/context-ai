// The Video Room's contract with the seal and the meter, offline.
//
// Drives the REAL api/video-discovery.mjs handler against a stubbed, witnessed
// world: Supabase Auth, PostgREST (documents, video_analyses, processing_jobs,
// video_interrogations), the RPCs (effective_tier_is_sealed, usage_consume,
// usage_record_actual, ledger_append) and the Gemini Files + generateContent
// endpoints are all globalThis.fetch here, and every request is recorded. Each
// case asserts what was CONTACTED as well as what was answered:
//
//   • a sealed matter: 403 `sealed`, zero provider requests, nothing inserted,
//     the meter never asked, and ONE completion.requested row that says
//     refused — sealed, provider null, model null;
//   • a seal that cannot be read: 503, the same silence;
//   • the meter refuses: 402, nothing queued or asked, a refused row, and for
//     a question an append-only video_interrogations row with outcome refused;
//   • the meter allows an analysis: kind 'video', a positive estimate, the
//     meter row's id rides in the job payload, and the API itself never
//     touches the provider (the worker does);
//   • a question: usage_consume → completion.requested → generateContent →
//     completion.received → usage_record_actual with the real tokens, in that
//     order; the request names the window; cited times past the end are clamped;
//   • the provider no longer holds the copy: 409 media_expired, a refresh job,
//     a refund, no generateContent;
//   • a connector token, no token, a document the caller cannot see, a reader
//     who may not start an analysis: refused with the right code, no provider.
//
// Runs with no network and no database: node scripts/_verify-video-room-refusals.mjs
import handler from '../api/video-discovery.mjs';

let failures = 0;
const pass = (m, d) => console.log(`  PASS  ${m}${d !== undefined ? `  — ${d}` : ''}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${String(JSON.stringify(d)).slice(0, 600)}` : ''}`);
  failures += 1;
};
const check = (ok, m, d) => (ok ? pass(m, typeof d === 'string' ? d : undefined) : fail(m, d));

const SB = 'https://stub.supabase.co';
process.env.VITE_SUPABASE_URL = SB;
process.env.VITE_SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
process.env.GOOGLE_API_KEY = 'stub-google-key';
delete process.env.GEMINI_VIDEO_MODELS;
delete process.env.GEMINI_VIDEO_MODEL;

const DOC = 'd1e2f3a4-0000-4000-8000-000000000001';
const MATTER = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';
const ANALYSIS = 'cccccccc-0000-4000-8000-000000000001';
const FILE_NAME = 'files/stubvideo123';
const SENTINEL_PROMPT = 'SENTINEL_QUESTION_5e8d0a4f6c';

const docRow = () => ({
  id: DOC, matterspace_id: MATTER, title: 'Body cam 3', source_filename: 'cam3.mp4',
  storage_path: `${MATTER}/${DOC}/cam3.mp4`, file_size_bytes: 150 * 1024 * 1024,
});
const readyAnalysis = () => ({
  id: ANALYSIS, document_id: DOC, matterspace_id: MATTER, status: 'ready', progress: 100, duration_sec: 90, windows: 1,
  model: 'gemini-2.5-flash', provider: 'google', media_provider_ref: FILE_NAME, created_by: USER,
  event_graph: {
    video: { duration_sec: 90, has_audio: true, camera_description: 'body camera' },
    actors: [{ id: 'A1', label: 'woman in a dark suit', identifying_marks: '', role_observed: 'subject', first_seen_sec: 5 }],
    events: [{ start_sec: 30, end_sec: 34, type: 'MOVEMENT', actor_ids: ['A1'], description: 'climbs stone steps', basis: 'VISUAL', confidence: 'HIGH', verbatim_quote: '' }],
    camera_coverage: [], subject_position: [], transcript: [],
  },
});
const activeFile = () => ({
  name: FILE_NAME, displayName: `cs-video-${DOC}`, state: 'ACTIVE', mimeType: 'video/mp4',
  uri: `https://generativelanguage.googleapis.com/v1beta/${FILE_NAME}`,
  expirationTime: new Date(Date.now() + 40 * 3600e3).toISOString(),
});
const providerAnswer = () => ({
  answer_markdown: 'She climbs the stone steps [00:31] and enters the building [00:33]. A binder is set on the podium [01:53].',
  cited_intervals: [
    { start_sec: 30, end_sec: 34, what_is_seen: 'a woman climbs stone steps carrying a dark rectangular object' },
    { start_sec: 113, end_sec: 118, what_is_seen: 'past the end of a 90-second clip' },
  ],
  line_of_sight: { status: 'FULL', basis: 'the steps are in frame throughout', what_cannot_be_seen: '' },
  claim_assessments: [{ claim_text: 'The person is carrying a briefcase.', finding: 'REFUTES', basis: 'it is a binder when set down' }],
  limitations: [],
});

let requests = [];
let world = {};
const host = (u) => { try { return new URL(u).host; } catch { return u; } };
const providerRequests = () => requests.filter((r) => host(r.url).endsWith('googleapis.com'));
const restWrites = (table) => requests.filter((r) => r.url.includes(`/rest/v1/${table}`) && ['POST', 'PATCH'].includes((r.init?.method || 'GET').toUpperCase()));
const rpcCalls = (fn) => requests.filter((r) => r.url.endsWith(`/rest/v1/rpc/${fn}`)).map((r) => { try { return JSON.parse(r.init.body || '{}'); } catch { return {}; } });
const ledgerRows = () => rpcCalls('ledger_append');
const idx = (pred) => requests.findIndex(pred);
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

function stubWorld(opts = {}) {
  world = {
    authed: true, connector: false, docFound: true, sealed: false, sealRpc: 'ok',
    meter: 'allow', writer: true, providerHolds: true, ...opts,
  };
  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    requests.push({ url: u, init });
    if (u.includes('/auth/v1/user')) return world.authed ? jsonRes({ id: USER, aud: 'authenticated' }) : jsonRes({ error: 'bad jwt' }, 401);
    if (u.includes('/rest/v1/documents')) return jsonRes(world.docFound ? [docRow()] : []);
    if (u.endsWith('/rest/v1/rpc/effective_tier_is_sealed')) {
      if (world.sealRpc === 'error') return jsonRes({ code: 'XX000', message: 'boom' }, 500);
      return jsonRes(world.sealed === true);
    }
    if (u.endsWith('/rest/v1/rpc/usage_consume')) {
      if (world.meter === 'refuse') return jsonRes({ allowed: false, status: 402, reason: 'budget_exhausted', message: "You've reached this month's included AI usage. It resets at the start of next month." });
      return jsonRes({ allowed: true, status: 200, reason: 'ok', event_id: 'ev-1', max_output_tokens: null, max_request_bytes: null });
    }
    if (u.endsWith('/rest/v1/rpc/usage_record_actual')) return jsonRes({ ok: true });
    if (u.endsWith('/rest/v1/rpc/ledger_append')) return jsonRes([{ id: 'ev', seq: 1, hash: 'h' }]);
    if (u.includes('/rest/v1/video_analyses')) {
      if (method === 'GET') return jsonRes(u.includes('duration_sec=not.is.null') ? [] : [readyAnalysis()]);
      if (method === 'POST') return world.writer
        ? jsonRes([{ id: 'dddddddd-0000-4000-8000-000000000001', document_id: DOC, matterspace_id: MATTER, status: 'queued', progress: 0 }], 201)
        : jsonRes({ code: '42501', message: 'new row violates row-level security policy for table "video_analyses"' }, 401);
      return new Response(null, { status: 204 });
    }
    if (u.includes('/rest/v1/processing_jobs')) {
      if (method === 'GET') return jsonRes([]);
      let body = {}; try { body = JSON.parse(init.body || '{}'); } catch { /* ignore */ }
      return jsonRes([{ id: 'eeeeeeee-0000-4000-8000-000000000001', status: 'queued', ...body }], 201);
    }
    if (u.includes('/rest/v1/video_interrogations')) {
      if (method === 'GET') return jsonRes([]);
      let body = {}; try { body = JSON.parse(init.body || '{}'); } catch { /* ignore */ }
      return jsonRes([{ id: 'ffffffff-0000-4000-8000-000000000001', created_at: new Date().toISOString(), ...body }], 201);
    }
    if (u.includes('/rest/v1/video_analysis_reviews')) return jsonRes([]);
    if (host(u).endsWith('googleapis.com')) {
      if (u.includes(`/v1beta/${FILE_NAME}`)) return world.providerHolds ? jsonRes(activeFile()) : jsonRes({ error: { code: 404 } }, 404);
      if (u.includes('/v1beta/files?')) return jsonRes({ files: [] });
      if (u.includes(':generateContent')) {
        if (world.provider === 'rate_limited') return jsonRes({ error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED' } }, 429);
        return jsonRes({
          candidates: [{ content: { parts: [{ text: JSON.stringify(providerAnswer()) }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 9000, candidatesTokenCount: 400, totalTokenCount: 9400 },
        });
      }
    }
    throw new Error(`unexpected request in the stubbed world: ${method} ${u}`);
  };
}

function fakeRes() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 200, headers,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    write(b) { chunks.push(Buffer.from(b)); return true; },
    end(b) { if (b) chunks.push(Buffer.from(b)); return this; },
    text() { return Buffer.concat(chunks).toString(); },
    json() { try { return JSON.parse(this.text()); } catch { return null; } },
  };
}

const connectorToken = () => `h.${Buffer.from(JSON.stringify({ cs_via: 'connector', aal: 'aal1' })).toString('base64url')}.s`;

async function call(body, opts = {}) {
  stubWorld(opts);
  const res = fakeRes();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    await handler({
      method: 'POST',
      headers: opts.noBearer ? {} : { authorization: `Bearer ${opts.connector ? connectorToken() : 'user-jwt'}` },
      body: { document_id: DOC, ...body },
    }, res);
  } finally {
    console.warn = realWarn;
  }
  return { status: res.statusCode, body: res.json() };
}

const refusedRow = () => ledgerRows().find((r) => r.p_kind === 'completion.requested' && r.p_payload?.refused);

// ---------------------------------------------------------------------------
console.log('\n1. The seal refuses before any byte moves');
{
  const r = await call({ action: 'analyze' }, { sealed: true });
  check(r.status === 403 && r.body?.error === 'sealed', 'sealed matter, Analyse: 403 sealed', `${r.status} ${r.body?.error}`);
  check(providerRequests().length === 0, 'sealed matter, Analyse: ZERO provider requests');
  check(restWrites('video_analyses').length === 0 && restWrites('processing_jobs').length === 0, 'sealed matter, Analyse: nothing inserted, nothing queued');
  check(rpcCalls('usage_consume').length === 0, 'sealed matter, Analyse: the meter was never asked (nothing to charge)');
  const row = refusedRow();
  check(Boolean(row), 'sealed matter, Analyse: ONE truthful row in the Record', row ? `${row.p_kind} refused=${row.p_payload.refused}` : ledgerRows());
  check(row?.p_payload?.refused === 'sealed' && row?.p_payload?.status === 403, 'the row says the seal refused it, with the status');
  check(row?.p_payload?.feature === 'video.analyze', 'the row names the feature', row?.p_payload?.feature);
  check(row?.p_payload?.provider == null && row?.p_payload?.model == null, 'and names NO provider and NO model, because none was chosen');
  check(row?.p_payload?.route === 'sealed', 'and says the route was the seal', row?.p_payload?.route);
  check(ledgerRows().filter((x) => x.p_kind === 'completion.received').length === 0, 'and there is no answer row to pair it with');
}
{
  const r = await call({ action: 'interrogate', question: SENTINEL_PROMPT, start_sec: 30, end_sec: 60 }, { sealed: true });
  check(r.status === 403 && r.body?.error === 'sealed', 'sealed matter, Ask: 403 sealed', `${r.status} ${r.body?.error}`);
  check(providerRequests().length === 0, 'sealed matter, Ask: ZERO provider requests');
  check(restWrites('video_interrogations').length === 0, 'sealed matter, Ask: no interrogation row (the question never became one)');
  const row = refusedRow();
  check(row?.p_payload?.refused === 'sealed' && row?.p_payload?.feature === 'video.interrogate', 'sealed matter, Ask: the Record row says refused, for video.interrogate', row?.p_payload);
  check(!JSON.stringify(ledgerRows()).includes(SENTINEL_PROMPT), 'the question itself is NOT in the Record (metadata only)');
}
{
  const r = await call({ action: 'status' }, { sealed: true });
  check(r.status === 200, 'sealed matter, status: a READ is answered (RLS decides what the caller sees)', String(r.status));
  check(providerRequests().length === 0 && ledgerRows().length === 0, 'sealed matter, status: no provider, no Record row (nothing left, nothing to record)');
}
{
  const r = await call({ action: 'analyze' }, { sealRpc: 'error' });
  check(r.status === 503 && r.body?.error === 'seal_unresolved', 'the seal cannot be read: 503 seal_unresolved — refused, not assumed open', `${r.status} ${r.body?.error}`);
  check(providerRequests().length === 0 && restWrites('video_analyses').length === 0, 'the seal cannot be read: ZERO provider requests, nothing queued');
  check(refusedRow()?.p_payload?.refused === 'seal_unresolved', 'the seal cannot be read: the Record row says why', refusedRow()?.p_payload);
}

// ---------------------------------------------------------------------------
console.log('\n2. The meter, before anything is queued or asked');
{
  const r = await call({ action: 'analyze' }, { meter: 'allow' });
  check(r.status === 202, 'open matter, Analyse, meter allows: 202 queued', String(r.status));
  const m = rpcCalls('usage_consume')[0];
  check(m?.p_kind === 'video' && Number(m?.p_cents_estimate) > 0, 'the meter was asked, kind video, a positive estimate', m);
  check(Number(m?.p_cents_estimate) < 500, 'a 150 MB recording of unknown length is estimated under five dollars', `${m?.p_cents_estimate} ¢`);
  const consumeAt = idx((q) => q.url.endsWith('/rpc/usage_consume'));
  const insertAt = idx((q) => q.url.includes('/rest/v1/video_analyses') && (q.init?.method || '') === 'POST');
  check(consumeAt >= 0 && insertAt > consumeAt, 'the meter is asked BEFORE the analysis row is inserted');
  const job = restWrites('processing_jobs').map((q) => JSON.parse(q.init.body))[0];
  check(job?.job_type === 'video_analysis' && job?.payload?.meter_event_id === 'ev-1', "the job payload carries the meter row's id for the worker to settle", job?.payload);
  check(typeof job?.payload?.meter_cents_estimate === 'number', 'and the estimate it was charged');
  check(providerRequests().length === 0, 'Analyse never touches the provider from the API (the worker does)');
  check(ledgerRows().length === 0, 'and writes no completion row (the departure is recorded by the worker as file.exported)');
}
{
  const r = await call({ action: 'analyze' }, { meter: 'refuse' });
  check(r.status === 402 && r.body?.error === 'budget_exhausted', 'open matter, Analyse, meter refuses: 402 with the meter\'s reason', `${r.status} ${r.body?.error}`);
  check(typeof r.body?.message === 'string' && /included AI usage/.test(r.body.message), 'and a plain-language sentence, not a code', r.body?.message);
  check(restWrites('video_analyses').length === 0 && restWrites('processing_jobs').length === 0, 'nothing inserted, nothing queued');
  check(providerRequests().length === 0, 'ZERO provider requests');
  const row = refusedRow();
  check(row?.p_payload?.refused === 'budget_exhausted' && row?.p_payload?.status === 402 && row?.p_payload?.feature === 'video.analyze', 'the Record row says the meter refused it', row?.p_payload);
}
{
  const r = await call({ action: 'interrogate', question: SENTINEL_PROMPT, start_sec: 30, end_sec: 60, claims: ['The person is carrying a briefcase.'] }, { meter: 'refuse' });
  check(r.status === 402, 'open matter, Ask, meter refuses: 402', String(r.status));
  check(providerRequests().length === 0, 'Ask refused by the meter: ZERO provider requests');
  const rows = restWrites('video_interrogations').map((q) => JSON.parse(q.init.body));
  check(rows.length === 1 && rows[0].outcome === 'refused', 'one video_interrogations row, outcome refused — the room\'s history stays truthful', rows[0]?.outcome);
  check(rows[0]?.result == null, 'with no answer in it');
  check(refusedRow()?.p_payload?.refused === 'budget_exhausted' && refusedRow()?.p_payload?.feature === 'video.interrogate', 'and the Record row says the meter refused video.interrogate', refusedRow()?.p_payload);
}
{
  const r = await call({ action: 'analyze' }, { writer: false });
  check(r.status === 403 && r.body?.error === 'not_a_writer', 'a reader who may not start an analysis: 403 not_a_writer (RLS said no)', `${r.status} ${r.body?.error}`);
  const refunds = rpcCalls('usage_record_actual');
  check(refunds.length === 1 && refunds[0].p_cents_actual === 0 && refunds[0].p_event_id === 'ev-1', 'and the estimate is given back (usage_record_actual 0 ¢)', refunds);
  check(providerRequests().length === 0 && restWrites('processing_jobs').length === 0, 'nothing queued, no provider');
}

// ---------------------------------------------------------------------------
console.log('\n3. A question that is answered: the order of events, and the window');
{
  const r = await call({ action: 'interrogate', question: SENTINEL_PROMPT, start_sec: 30, end_sec: 60, claims: ['The person is carrying a briefcase.'] });
  check(r.status === 200 && r.body?.interrogation?.outcome === 'ok', 'open matter, Ask: 200 ok', `${r.status} ${r.body?.error ?? ''}`);
  const consumeAt = idx((q) => q.url.endsWith('/rpc/usage_consume'));
  const requestedAt = idx((q) => q.url.endsWith('/rpc/ledger_append') && (q.init.body || '').includes('completion.requested'));
  const generateAt = idx((q) => q.url.includes(':generateContent'));
  const receivedAt = idx((q) => q.url.endsWith('/rpc/ledger_append') && (q.init.body || '').includes('completion.received'));
  const actualAt = idx((q) => q.url.endsWith('/rpc/usage_record_actual'));
  check(consumeAt >= 0 && requestedAt > consumeAt, 'meter first, then completion.requested', `${consumeAt} < ${requestedAt}`);
  check(generateAt > requestedAt, 'completion.requested is written BEFORE the provider is contacted', `${requestedAt} < ${generateAt}`);
  check(receivedAt > generateAt && actualAt > generateAt, 'completion.received and the actual charge come after the answer', `${generateAt} < ${receivedAt}, ${actualAt}`);
  const gen = JSON.parse(requests[generateAt].init.body);
  const videoPart = gen.contents[0].parts.find((p) => p.fileData || p.file_data);
  const meta = videoPart?.videoMetadata ?? videoPart?.video_metadata ?? {};
  check(/^30s$/.test(String(meta.startOffset ?? meta.start_offset)) && /^60s$/.test(String(meta.endOffset ?? meta.end_offset)), 'the provider request names the window (30s–60s), so the model sees only that footage', meta);
  check(gen.generationConfig?.responseMimeType === 'application/json' && gen.generationConfig?.responseSchema, 'and asks for structured JSON against the schema');
  check(providerRequests().filter((q) => q.url.includes(':generateContent')).length === 1, 'exactly ONE generateContent call');
  check(providerRequests().every((q) => !q.url.includes('upload')), 'and no upload — the copy the provider held was reused');
  const actual = rpcCalls('usage_record_actual')[0];
  check(actual?.p_event_id === 'ev-1' && actual?.p_cents_actual >= 1 && actual?.p_model === 'gemini-2.5-flash', 'the actual charge: the meter row, ≥ 1 ¢ for 9,000 + 400 tokens, the model that answered', actual);
  check(actual?.p_meta?.input_tokens === 9000 && actual?.p_meta?.output_tokens === 400, 'with the token counts from usageMetadata', actual?.p_meta);
  const result = r.body?.interrogation?.result;
  check(result?.cited_intervals?.every((c) => c.end_sec <= 90), 'a cited interval past the 90-second end is clamped to the recording', result?.cited_intervals);
  check(result?.claim_assessments?.[0]?.finding === 'REFUTES', 'the claim finding comes through', result?.claim_assessments?.[0]);
  const received = ledgerRows().find((x) => x.p_kind === 'completion.received');
  check(received?.p_payload?.feature === 'video.interrogate' && received?.p_payload?.model === 'gemini-2.5-flash' && received?.p_payload?.provider === 'google', 'completion.received names feature, provider and model', received?.p_payload);
  check(!JSON.stringify(ledgerRows()).includes(SENTINEL_PROMPT) && !JSON.stringify(ledgerRows()).includes('binder'), 'neither the question nor the answer is in the Record');
  const saved = restWrites('video_interrogations').map((q) => JSON.parse(q.init.body))[0];
  check(saved?.outcome === 'ok' && saved?.start_sec === 30 && saved?.end_sec === 60 && saved?.model === 'gemini-2.5-flash', 'the interrogation row stores the window, the model and the outcome', saved && { outcome: saved.outcome, start_sec: saved.start_sec, end_sec: saved.end_sec, model: saved.model });
}
{
  const r = await call({ action: 'interrogate', question: SENTINEL_PROMPT, start_sec: 30, end_sec: 60 }, { providerHolds: false });
  check(r.status === 409 && r.body?.error === 'media_expired', 'the provider no longer holds the copy: 409 media_expired', `${r.status} ${r.body?.error}`);
  const job = restWrites('processing_jobs').map((q) => JSON.parse(q.init.body))[0];
  check(job?.job_type === 'video_media_refresh', 'a refresh job is queued for the worker', job?.job_type);
  check(providerRequests().filter((q) => q.url.includes(':generateContent')).length === 0, 'no generateContent');
  const refund = rpcCalls('usage_record_actual')[0];
  check(refund?.p_cents_actual === 0 && refund?.p_meta?.reason === 'media_expired', 'the estimate is given back, with the reason', refund);
  const rows = restWrites('video_interrogations').map((q) => JSON.parse(q.init.body));
  check(rows[0]?.outcome === 'media_expired', 'and the interrogation row says media_expired', rows[0]?.outcome);
}
{
  const r = await call({ action: 'interrogate', question: SENTINEL_PROMPT, start_sec: 30, end_sec: 60 }, { provider: 'rate_limited' });
  check(r.status === 502 && r.body?.error === 'provider_error', 'the provider answers 429 (2026-10-19: the free-tier daily cap): 502 provider_error', `${r.status} ${r.body?.error}`);
  check(/quota|429/i.test(r.body?.message ?? ''), 'and the sentence says what the provider said', r.body?.message);
  const refund = rpcCalls('usage_record_actual')[0];
  check(refund?.p_cents_actual === 0 && refund?.p_meta?.reason === 'provider_error', 'nothing was answered, so nothing is charged: the estimate is given back', refund);
  const received = ledgerRows().find((x) => x.p_kind === 'completion.received');
  check(received?.p_payload?.outcome === 'provider_error', 'completion.received says provider_error', received?.p_payload?.outcome);
  const rows = restWrites('video_interrogations').map((q) => JSON.parse(q.init.body));
  check(rows[0]?.outcome === 'provider_error' && rows[0]?.result == null, 'the interrogation row says provider_error, with no answer in it', rows[0]?.outcome);
}
{
  const r = await call({ action: 'interrogate', question: SENTINEL_PROMPT }, {});
  check(r.status === 200, 'a whole-recording question on a 90-second clip is allowed (under the 20-minute rule)', String(r.status));
  const gen = requests.find((q) => q.url.includes(':generateContent'));
  const part = gen ? JSON.parse(gen.init.body).contents[0].parts.find((p) => p.fileData || p.file_data) : null;
  check(part && !(part.videoMetadata || part.video_metadata), 'and the provider request carries no window', part);
}

// ---------------------------------------------------------------------------
console.log('\n4. Who may ask at all');
{
  const r = await call({ action: 'analyze' }, { noBearer: true });
  check(r.status === 401 && r.body?.error === 'missing_bearer', 'no token: 401 missing_bearer', `${r.status} ${r.body?.error}`);
  check(requests.length === 0, 'and NO request of any kind was made');
}
{
  const r = await call({ action: 'analyze' }, { authed: false });
  check(r.status === 401 && r.body?.error === 'invalid_session', 'a token Supabase Auth rejects: 401 invalid_session', `${r.status} ${r.body?.error}`);
  check(providerRequests().length === 0 && ledgerRows().length === 0, 'no provider, no Record row (no byline to write it under)');
}
{
  const r = await call({ action: 'analyze' }, { connector: true });
  check(r.status === 403 && r.body?.error === 'browser_sessions_only', 'a connector token: 403 browser_sessions_only', `${r.status} ${r.body?.error}`);
  check(providerRequests().length === 0 && restWrites('video_analyses').length === 0, 'no provider, nothing queued');
}
{
  const r = await call({ action: 'analyze' }, { docFound: false });
  check(r.status === 404 && r.body?.error === 'not_found', 'a document the caller cannot see: 404 not_found (RLS decides; not visible = not found)', `${r.status} ${r.body?.error}`);
  check(providerRequests().length === 0 && ledgerRows().length === 0 && rpcCalls('effective_tier_is_sealed').length === 0, 'no provider, no Record row, the seal not even asked');
}
{
  const r = await call({ action: 'analyze', document_id: 'not-a-uuid' }, {});
  check(r.status === 422, 'a document id that is not an id: 422 before anything is looked up', String(r.status));
  check(requests.filter((q) => !q.url.includes('/auth/v1/user')).length === 0, 'and nothing but the auth check was contacted');
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
