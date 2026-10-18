// POST /api/video-discovery — the Video Room's one door (migration 119).
//
// Every action is taken AS THE USER: the bearer is verified with Supabase Auth,
// the document is read through PostgREST with that bearer (RLS decides whether
// it exists for them), and every row this file writes is written with that
// bearer too, so 119's policies — not this code — say who may do what. The
// service role is used for exactly one thing: the worker-owned columns of
// video_analyses that a refresh must set (job_id), because 119 gives
// authenticated no update on that table.
//
//   { action: 'status',      document_id }
//       → { analysis, reviews, interrogations } (latest analysis, its reviews, recent questions)
//   { action: 'analyze',     document_id }
//       → insert a 'queued' video_analyses row (as the user) + a processing_jobs
//         row 'video_analysis' (as the user, 032's policy). Idempotent while one
//         is in flight (119's partial unique index → 'already_running').
//   { action: 'interrogate', document_id, question, start_sec?, end_sec?, claims?[] }
//       → ask the model about the window. If the provider no longer holds the
//         recording (48 h), enqueue 'video_media_refresh' and answer 409
//         media_expired with the job id; the room says so and offers to wait.
//   { action: 'review',      document_id, analysis_id, status: 'reviewed'|'problem', initials, note? }
//       → one append-only video_analysis_reviews row, as the user.
//
// Refusals: 401 missing_bearer / invalid_session · 403 browser_sessions_only ·
// 403 sealed (the recording would leave the seal) · 404 not_found ·
// 409 already_running / media_expired / no_analysis · 422 bad_request ·
// 500 config_error / provider_error.
//
// What never comes from the client: an API key, a file path, a URL, a model id.
// GOOGLE_API_KEY is read from process.env and nowhere else.

import {
  json, corsPreflight, bearerFrom, readJsonBody, authUser, jwtClaims, serviceRpc,
  SUPABASE_URL, ANON_KEY, SERVICE_KEY,
} from '../lib/account-security.mjs';
import { ledgerClientFor, recordLlmRequested, recordLlmReceived, newCallId } from '../lib/llm-record.mjs';
import { walkEffectiveTier, isSealedTier } from '../lib/ai-tier-policy.mjs';
import { VIDEO_EXTENSIONS } from '../lib/ingest-formats.mjs';
import {
  buildInterrogationPrompt, normalizeInterrogation, digestForWindow, timestampsIn, deriveMeasures, ANALYSIS_WINDOW_SEC, fmtTime,
} from '../lib/video-discovery/core.mjs';
import * as gemini from '../lib/video-discovery/gemini-video.mjs';

const TIMEOUT_MS = 10000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CLAIMS = 6;
const MAX_CLAIM_CHARS = 1000;
const MAX_QUESTION_CHARS = 4000;

const base = () => String(SUPABASE_URL() || '').replace(/\/$/, '');
const rpcNotDeployed = (r) => r.status === 404 || r.error === 'PGRST202' || r.error === '42883';

/** PostgREST as the user. */
async function userRest(bearer, method, pathAndQuery, body = null, doFetch = globalThis.fetch, extraHeaders = {}) {
  const res = await doFetch(`${base()}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: ANON_KEY(), authorization: `Bearer ${bearer}`, accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data, text };
}

/** PostgREST as the service role — the worker-owned columns only. */
async function serviceRest(method, pathAndQuery, body = null, doFetch = globalThis.fetch) {
  const res = await doFetch(`${base()}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: SERVICE_KEY(), authorization: `Bearer ${SERVICE_KEY()}`, accept: 'application/json',
      ...(body ? { 'content-type': 'application/json', prefer: 'return=minimal' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { ok: res.ok, status: res.status };
}

async function isSealedMatter(matterId, doFetch) {
  const r = await serviceRpc('effective_tier_is_sealed', { p_matter: matterId }, { fetchImpl: doFetch });
  if (r.ok && typeof r.data === 'boolean') return r.data;
  if (!r.ok && rpcNotDeployed(r)) {
    try {
      const fetchRow = async (id) => {
        const res = await doFetch(`${base()}/rest/v1/matterspaces?select=id,parent_matterspace_id,ai_tier&id=eq.${id}&limit=1`, {
          headers: { apikey: SERVICE_KEY(), authorization: `Bearer ${SERVICE_KEY()}`, accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const rows = await res.json().catch(() => []);
        return Array.isArray(rows) ? rows[0] ?? null : null;
      };
      const tier = await walkEffectiveTier(fetchRow, matterId);
      return tier == null ? null : isSealedTier(tier);
    } catch { return null; }
  }
  return null; // unknown = refused by every caller
}

const extOf = (name) => { const s = String(name ?? ''); const i = s.lastIndexOf('.'); return i >= 0 ? s.slice(i).toLowerCase() : ''; };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null));

/** The analysis the room shows: the latest ready one, else the latest of any status. */
function pickAnalysis(rows) {
  if (!rows?.length) return null;
  const ready = rows.find((r) => r.status === 'ready');
  const inflight = rows.find((r) => r.status === 'queued' || r.status === 'running');
  return inflight ?? ready ?? rows[0];
}

export default async function handler(req, res, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  if (corsPreflight(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (!SUPABASE_URL() || !ANON_KEY() || !SERVICE_KEY()) return json(res, 500, { error: 'config_error' });

  const bearer = bearerFrom(req);
  if (!bearer) return json(res, 401, { error: 'missing_bearer' });
  const user = await authUser(bearer, { fetchImpl: doFetch });
  if (!user) return json(res, 401, { error: 'invalid_session' });
  if (jwtClaims(bearer).cs_via === 'connector') return json(res, 403, { error: 'browser_sessions_only' });

  const body = await readJsonBody(req);
  const action = body?.action;
  const documentId = String(body?.document_id ?? '').toLowerCase();
  if (!UUID_RE.test(documentId)) return json(res, 422, { error: 'bad_request', message: 'document_id must be a document id.' });

  // The document, as the user. Not visible = not found.
  const d = await userRest(bearer, 'GET', `documents?select=id,matterspace_id,title,source_filename,storage_path,file_size_bytes&id=eq.${documentId}&limit=1`, null, doFetch);
  if (!d.ok) return json(res, 502, { error: 'lookup_failed' });
  const doc = Array.isArray(d.data) ? d.data[0] : null;
  if (!doc) return json(res, 404, { error: 'not_found' });
  const isVideo = VIDEO_EXTENSIONS.includes(extOf(doc.source_filename ?? doc.storage_path));

  if (action === 'status') {
    const [a, r, q] = await Promise.all([
      userRest(bearer, 'GET', `video_analyses?select=*&document_id=eq.${documentId}&order=created_at.desc&limit=10`, null, doFetch),
      userRest(bearer, 'GET', `video_analysis_reviews?select=*&document_id=eq.${documentId}&order=created_at.desc&limit=20`, null, doFetch),
      userRest(bearer, 'GET', `video_interrogations?select=id,analysis_id,question,start_sec,end_sec,claims,result,outcome,model,created_at&document_id=eq.${documentId}&order=created_at.desc&limit=30`, null, doFetch),
    ]);
    if (!a.ok && a.status === 404) return json(res, 503, { error: 'migration_missing', message: 'Migration 119 is not applied yet.' });
    const analysis = pickAnalysis(Array.isArray(a.data) ? a.data : []);
    return json(res, 200, {
      document: { id: doc.id, title: doc.title, source_filename: doc.source_filename, storage_path: doc.storage_path, matterspace_id: doc.matterspace_id, is_video: isVideo, file_size_bytes: doc.file_size_bytes },
      analysis: analysis ? { ...analysis, measures: analysis.event_graph ? deriveMeasures(analysis.event_graph) : null } : null,
      reviews: Array.isArray(r.data) ? r.data.filter((x) => !analysis || x.analysis_id === analysis.id) : [],
      interrogations: Array.isArray(q.data) ? q.data : [],
    });
  }

  if (!isVideo) return json(res, 422, { error: 'not_a_video', message: `"${doc.source_filename ?? doc.title}" is not a video file.` });
  if (!doc.storage_path) return json(res, 422, { error: 'no_stored_file', message: 'This document has no stored file to analyse.' });

  // The seal, for every action that moves the recording to a provider.
  const sealed = await isSealedMatter(doc.matterspace_id, doFetch);
  if (sealed !== false) {
    return json(res, sealed === true ? 403 : 503, {
      error: sealed === true ? 'sealed' : 'seal_unresolved',
      message: sealed === true
        ? 'This matter is sealed: its recording cannot be sent to an outside video model. The Video Room reads unsealed matters only.'
        : 'The matter\'s seal could not be read, so nothing was sent.',
    });
  }

  if (action === 'analyze') {
    const ins = await userRest(bearer, 'POST', 'video_analyses', {
      document_id: doc.id, matterspace_id: doc.matterspace_id, status: 'queued', created_by: user.id,
    }, doFetch, { prefer: 'return=representation' });
    if (!ins.ok) {
      if (ins.status === 409) return json(res, 409, { error: 'already_running', message: 'An analysis of this recording is already in progress.' });
      if (ins.status === 404) return json(res, 503, { error: 'migration_missing', message: 'Migration 119 is not applied yet.' });
      if (ins.status === 401 || ins.status === 403) return json(res, 403, { error: 'not_a_writer', message: 'Only a member who can write this matter can start an analysis.' });
      return json(res, 502, { error: 'insert_failed', detail: ins.text?.slice(0, 300) });
    }
    const analysis = Array.isArray(ins.data) ? ins.data[0] : ins.data;
    const job = await userRest(bearer, 'POST', 'processing_jobs', {
      matterspace_id: doc.matterspace_id, production_id: null, job_type: 'video_analysis',
      payload: { document_id: doc.id, analysis_id: analysis.id }, created_by: user.id,
    }, doFetch, { prefer: 'return=representation' });
    if (!job.ok) {
      await serviceRest('PATCH', `video_analyses?id=eq.${analysis.id}`, { status: 'error', error: 'The analysis job could not be queued.' }, doFetch);
      return json(res, 502, { error: 'enqueue_failed', detail: job.text?.slice(0, 300) });
    }
    const jobRow = Array.isArray(job.data) ? job.data[0] : job.data;
    await serviceRest('PATCH', `video_analyses?id=eq.${analysis.id}`, { job_id: jobRow?.id ?? null }, doFetch);
    return json(res, 202, { analysis: { ...analysis, job_id: jobRow?.id ?? null }, job: jobRow });
  }

  if (action === 'interrogate') {
    const question = String(body?.question ?? '').trim();
    if (!question || question.length > MAX_QUESTION_CHARS) return json(res, 422, { error: 'bad_request', message: 'question is required (up to 4000 characters).' });
    const claims = (Array.isArray(body?.claims) ? body.claims : [])
      .filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim().slice(0, MAX_CLAIM_CHARS)).slice(0, MAX_CLAIMS);
    let startSec = num(body?.start_sec); let endSec = num(body?.end_sec);
    if (startSec != null && endSec != null && endSec <= startSec) return json(res, 422, { error: 'bad_request', message: 'end_sec must be after start_sec.' });
    if ((startSec == null) !== (endSec == null)) { startSec = null; endSec = null; }
    if (!process.env.GOOGLE_API_KEY) return json(res, 500, { error: 'config_error', missing_env: ['GOOGLE_API_KEY'] });

    const a = await userRest(bearer, 'GET', `video_analyses?select=*&document_id=eq.${documentId}&order=created_at.desc&limit=10`, null, doFetch);
    const analysis = pickAnalysis(Array.isArray(a.data) ? a.data : []);
    if (!analysis || analysis.status !== 'ready') {
      return json(res, 409, { error: 'no_analysis', message: 'Analyse the recording first; questions are asked against the analysed copy.' });
    }
    // One question watches at most one analysis pass's worth of footage: the
    // whole of a long recording is past the model's context (the worker's
    // 2026-09-16 note), and would fail as a provider error after a long wait.
    const knownDuration = num(analysis.duration_sec) ?? num(analysis.event_graph?.video?.duration_sec);
    if (startSec == null && knownDuration != null && knownDuration > ANALYSIS_WINDOW_SEC) {
      return json(res, 422, { error: 'window_required', message: `This recording is ${fmtTime(knownDuration)} long. Ask about a window of up to ${ANALYSIS_WINDOW_SEC / 60} minutes.` });
    }
    if (startSec != null && endSec - startSec > ANALYSIS_WINDOW_SEC) {
      return json(res, 422, { error: 'window_too_long', message: `A window can be at most ${ANALYSIS_WINDOW_SEC / 60} minutes.` });
    }

    // Does the provider still hold the recording?
    const apiKey = process.env.GOOGLE_API_KEY;
    let fileResource = null;
    try { fileResource = analysis.media_provider_ref ? await gemini.getFile({ apiKey, name: analysis.media_provider_ref }) : null; } catch { fileResource = null; }
    if (!fileResource || fileResource.state !== 'ACTIVE') {
      try { fileResource = await gemini.findActiveByDisplayName({ apiKey, displayName: gemini.displayNameFor(doc.id) }); } catch { fileResource = null; }
    }
    if (!fileResource) {
      // Enqueue a refresh unless one is already queued/running for this analysis.
      const running = await userRest(bearer, 'GET', `processing_jobs?select=id,status&matterspace_id=eq.${doc.matterspace_id}&job_type=eq.video_media_refresh&status=in.(queued,running)&payload->>analysis_id=eq.${analysis.id}&limit=1`, null, doFetch);
      let jobRow = Array.isArray(running.data) ? running.data[0] : null;
      if (!jobRow) {
        const job = await userRest(bearer, 'POST', 'processing_jobs', {
          matterspace_id: doc.matterspace_id, production_id: null, job_type: 'video_media_refresh',
          payload: { document_id: doc.id, analysis_id: analysis.id }, created_by: user.id,
        }, doFetch, { prefer: 'return=representation' });
        jobRow = job.ok ? (Array.isArray(job.data) ? job.data[0] : job.data) : null;
      }
      await userRest(bearer, 'POST', 'video_interrogations', {
        analysis_id: analysis.id, document_id: doc.id, matterspace_id: doc.matterspace_id, user_id: user.id,
        question, start_sec: startSec, end_sec: endSec, claims, provider: gemini.PROVIDER, outcome: 'media_expired',
      }, doFetch).catch(() => {});
      return json(res, 409, {
        error: 'media_expired',
        message: 'The video model no longer holds this recording (uploads last 48 hours). It is being re-uploaded; ask again when the room says the copy is back.',
        job: jobRow,
      });
    }

    // Record the request before the provider is contacted (lib/llm-record.mjs's rule), then ask.
    const ledger = ledgerClientFor({ supabaseUrl: SUPABASE_URL(), anonKey: ANON_KEY(), bearer, fetchImpl: doFetch });
    const actor = { kind: 'user', ref: user.id, user_id: user.id };
    const callId = newCallId();
    const models = gemini.modelsFromEnv();
    await recordLlmRequested(ledger, {
      matterId: doc.matterspace_id, actor, feature: 'video.interrogate', callId, tier: 'A',
      provider: gemini.PROVIDER, model: models[0], documentIds: [doc.id], maxOutputTokens: 16384,
    });

    const prompt = buildInterrogationPrompt({
      question, startSec, endSec, claims,
      digest: digestForWindow(analysis.event_graph, startSec, endSec),
    });
    const started = Date.now();
    let r;
    try {
      r = await gemini.interrogate({
        apiKey, models, prompt, fileUri: fileResource.uri, mimeType: fileResource.mimeType, startSec, endSec,
      });
    } catch (err) {
      await recordLlmReceived(ledger, { matterId: doc.matterspace_id, actor, feature: 'video.interrogate', callId, tier: 'A', provider: gemini.PROVIDER, model: models[0], outcome: 'provider_error', ms: Date.now() - started });
      await userRest(bearer, 'POST', 'video_interrogations', {
        analysis_id: analysis.id, document_id: doc.id, matterspace_id: doc.matterspace_id, user_id: user.id,
        question, start_sec: startSec, end_sec: endSec, claims, provider: gemini.PROVIDER, outcome: 'provider_error', ms: Date.now() - started,
      }, doFetch).catch(() => {});
      return json(res, 502, { error: 'provider_error', message: String(err?.message ?? err).slice(0, 400) });
    }
    const result = normalizeInterrogation(r.json, { claims, durationSec: analysis.duration_sec ?? analysis.event_graph?.video?.duration_sec ?? null });
    result.timestamps = timestampsIn(result.answer_markdown);
    await recordLlmReceived(ledger, {
      matterId: doc.matterspace_id, actor, feature: 'video.interrogate', callId, tier: 'A', provider: gemini.PROVIDER, model: r.model,
      outcome: 'ok', ms: r.ms, tokens: r.usage ? { input: r.usage.promptTokenCount, output: r.usage.candidatesTokenCount } : null,
    });
    const saved = await userRest(bearer, 'POST', 'video_interrogations', {
      analysis_id: analysis.id, document_id: doc.id, matterspace_id: doc.matterspace_id, user_id: user.id,
      question, start_sec: startSec, end_sec: endSec, claims, provider: gemini.PROVIDER, model: r.model, result, outcome: 'ok', ms: r.ms,
    }, doFetch, { prefer: 'return=representation' });
    const row = saved.ok ? (Array.isArray(saved.data) ? saved.data[0] : saved.data) : null;
    return json(res, 200, {
      interrogation: row ?? { id: null, analysis_id: analysis.id, question, start_sec: startSec, end_sec: endSec, claims, result, model: r.model, outcome: 'ok', created_at: new Date().toISOString() },
      recorded: saved.ok,
    });
  }

  if (action === 'review') {
    const analysisId = String(body?.analysis_id ?? '').toLowerCase();
    const status = body?.status;
    const initials = String(body?.initials ?? '').trim();
    const note = String(body?.note ?? '').trim().slice(0, 1000);
    if (!UUID_RE.test(analysisId)) return json(res, 422, { error: 'bad_request', message: 'analysis_id required.' });
    if (status !== 'reviewed' && status !== 'problem') return json(res, 422, { error: 'bad_request', message: 'status must be reviewed or problem.' });
    if (!initials || initials.length > 6) return json(res, 422, { error: 'bad_request', message: 'initials (1–6 characters) required.' });
    const ins = await userRest(bearer, 'POST', 'video_analysis_reviews', {
      analysis_id: analysisId, document_id: doc.id, status, note, initials, user_id: user.id,
    }, doFetch, { prefer: 'return=representation' });
    if (!ins.ok) {
      if (ins.status === 401 || ins.status === 403) return json(res, 403, { error: 'not_a_writer', message: 'Only a member who can write this matter can review an analysis.' });
      return json(res, 502, { error: 'insert_failed', detail: ins.text?.slice(0, 300) });
    }
    return json(res, 200, { review: Array.isArray(ins.data) ? ins.data[0] : ins.data });
  }

  return json(res, 422, { error: 'bad_request', message: 'action must be status, analyze, interrogate or review.' });
}
