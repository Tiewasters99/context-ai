// lib/video-discovery/jobs.mjs — the worker's side of the Video Room.
//
// Two job types on processing_jobs, both run by worker/discovery-worker.mjs
// with the service role:
//
//   video_analysis       payload { document_id, analysis_id }
//                        Stream the stored recording to disk, upload it to the
//                        provider, analyse it in windows (core.planWindows),
//                        merge, and write the event graph + media handle to the
//                        video_analyses row. Progress is mirrored into that row
//                        so the room polls one thing.
//   video_media_refresh  payload { document_id, analysis_id }
//                        The provider dropped the upload (48 h). Upload again
//                        and refresh the handle; the event graph stays.
//
// Everything that touches the network or disk is injected through `ctx`, so
// tests drive these functions with stubs and the worker passes the real
// thing. The seal is asked first, before a byte moves: a sealed matter's
// recording never leaves (SealedPipeError, pipe 'video_analysis'), and the
// worker parks the job as 'held' exactly as it does for transcription.

import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { VIDEO_EXTENSIONS } from '../ingest-formats.mjs';
import { SealedPipeError, matterSeal, assertAiNotPaused } from '../seal-pipes.mjs';
import { JobRefusedError } from '../job-scope.mjs';
import {
  planWindows, buildAnalysisPrompt, normalizeEventGraph, looksExcerptRelative, mergeWindowGraphs, deriveMeasures,
} from './core.mjs';
import * as gemini from './gemini-video.mjs';

export const VIDEO_ANALYSIS_JOB = 'video_analysis';
export const VIDEO_REFRESH_JOB = 'video_media_refresh';

const extOf = (name) => {
  const base = String(name ?? '');
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i).toLowerCase() : '';
};

export function isVideoFilename(name) {
  return VIDEO_EXTENSIONS.includes(extOf(name));
}

async function setAnalysis(supabase, analysisId, patch) {
  const { error } = await supabase.from('video_analyses')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', analysisId);
  if (error) throw new Error(`video_analyses update: ${error.message}`);
}

async function loadDocument(supabase, documentId) {
  const { data, error } = await supabase.from('documents')
    .select('id, matterspace_id, title, source_filename, storage_path, file_size_bytes, metadata')
    .eq('id', documentId).maybeSingle();
  if (error) throw new Error(`document lookup: ${error.message}`);
  return data ?? null;
}

async function loadAnalysis(supabase, analysisId) {
  const { data, error } = await supabase.from('video_analyses').select('*').eq('id', analysisId).maybeSingle();
  if (error) throw new Error(`video_analyses lookup: ${error.message}`);
  return data ?? null;
}

/**
 * Probe the recording's duration with ffprobe when the worker has it (the
 * Dockerfile installs ffmpeg). Null when it cannot be told; the first pass
 * then covers the whole file and the model's own duration_sec is used.
 */
async function probeDuration(filePath, ctx) {
  if (typeof ctx.probeDurationSec === 'function') {
    try { return await ctx.probeDurationSec(filePath); } catch { return null; }
  }
  return null;
}

/**
 * Make sure the provider holds an ACTIVE copy of this document's recording.
 * Reuses a still-ACTIVE earlier upload (same display name) before downloading
 * a gigabyte again. Returns { fileResource, reused }.
 */
async function ensureUploaded({ ctx, doc, analysis, onProgress }) {
  const apiKey = ctx.apiKey;
  const displayName = gemini.displayNameFor(doc.id);

  if (analysis?.media_provider_ref) {
    const f = await gemini.getFile({ apiKey, name: analysis.media_provider_ref });
    if (f?.state === 'ACTIVE') return { fileResource: f, reused: true, durationSec: gemini.durationOf(f) };
  }
  const existing = await gemini.findActiveByDisplayName({ apiKey, displayName });
  if (existing) return { fileResource: existing, reused: true, durationSec: gemini.durationOf(existing) };

  const tmpDir = await fsp.mkdtemp(path.join(ctx.tmpRoot ?? os.tmpdir(), 'cs-video-'));
  const tmpFile = path.join(tmpDir, `source${extOf(doc.source_filename) || '.mp4'}`);
  try {
    onProgress(8, `Fetching ${doc.source_filename ?? 'the recording'} from the Vault`);
    await ctx.downloadToFile('vault-documents', doc.storage_path, tmpFile);
    const durationSec = await probeDuration(tmpFile, ctx);
    onProgress(15, 'Uploading to the video model');
    const uploaded = await gemini.uploadVideoFromPath({
      apiKey, filePath: tmpFile, mimeType: gemini.mimeForExt(extOf(doc.source_filename)), displayName,
      onProgress: (p) => { if (p.stage === 'uploading') onProgress(15 + Math.round(p.pct * 0.25), `Uploading to the video model (${p.pct}%)`); },
    });
    onProgress(42, 'Provider is processing the upload');
    const active = await gemini.waitActive({ apiKey, name: uploaded.name, onProgress: (p) => onProgress(42, p.message) });
    return { fileResource: active, reused: false, durationSec: durationSec ?? gemini.durationOf(active) };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The analysis pass. `ctx` carries: supabase (service role), apiKey, models?,
 * downloadToFile(bucket, path, dest), probeDurationSec?(path), tmpRoot?, log?.
 * `job` is the processing_jobs row; `progress(pct, note)` reports to it.
 */
export async function runVideoAnalysisJob(ctx, job, progress = async () => {}) {
  const { supabase } = ctx;
  const p = job.payload ?? {};
  const analysis = p.analysis_id ? await loadAnalysis(supabase, p.analysis_id) : null;
  if (!analysis) throw new JobRefusedError('the video analysis row this job names no longer exists');
  const report = async (pct, note) => {
    await progress(pct, note);
    await setAnalysis(supabase, analysis.id, { progress: Math.min(99, Math.round(pct)), progress_note: note }).catch(() => {});
  };

  try {
    const doc = await loadDocument(supabase, p.document_id);
    if (!doc) throw new JobRefusedError('the document no longer exists');
    if (doc.matterspace_id !== analysis.matterspace_id) throw new JobRefusedError('the analysis row and the document name different matters');
    if (!doc.storage_path) throw new JobRefusedError('this document has no stored file to analyse');
    if (!isVideoFilename(doc.source_filename ?? doc.storage_path)) throw new JobRefusedError(`"${doc.source_filename}" is not a video the Video Room reads (${VIDEO_EXTENSIONS.join(', ')})`);
    if (!ctx.apiKey) throw new Error('GOOGLE_API_KEY is not configured on the worker');

    // The seal, before a byte moves. The worker parks a SealedPipeError as 'held'.
    const seal = await matterSeal(supabase, doc.matterspace_id);
    if (seal.sealed) {
      await setAnalysis(supabase, analysis.id, { status: 'held', error: new SealedPipeError('video_analysis', { tier: seal.tier, matterName: seal.name }).message, progress_note: null });
      throw new SealedPipeError('video_analysis', { tier: seal.tier, matterName: seal.name });
    }
    await assertAiNotPaused(supabase, doc.matterspace_id, { pipe: 'video_analysis', pause: seal.pause });

    await setAnalysis(supabase, analysis.id, { status: 'running', job_id: job.id, error: null, provider: gemini.PROVIDER });
    await report(5, 'Starting');

    const { fileResource, reused, durationSec: probed } = await ensureUploaded({ ctx, doc, analysis, onProgress: report });
    await setAnalysis(supabase, analysis.id, {
      media_provider_ref: fileResource.name, media_uri: fileResource.uri, media_expires_at: gemini.expiryOf(fileResource),
    });
    if (reused) await report(45, 'Reusing the provider\'s copy of the recording');

    // Windows. Duration from ffprobe when the file was downloaded; otherwise one
    // pass over the whole file and the model's own duration estimate afterwards.
    let durationSec = probed ?? (analysis.duration_sec != null ? Number(analysis.duration_sec) : null);
    // Known before the first pass, so a crash mid-way leaves the length on the row for the retry.
    if (durationSec != null) await setAnalysis(supabase, analysis.id, { duration_sec: durationSec });
    const windows = planWindows(durationSec);
    const models = ctx.models ?? gemini.modelsFromEnv();
    const passes = [];
    let usedModel = null;
    for (const w of windows) {
      const base = 50 + Math.round((w.index / windows.length) * 45);
      await report(base, windows.length > 1 ? `Analysing pass ${w.index + 1} of ${windows.length}` : 'Analysing the recording');
      const prompt = buildAnalysisPrompt({ windowStart: w.startSec, windowEnd: w.endSec, durationSec, windowIndex: w.index, windowCount: windows.length });
      const r = await gemini.analyzeWindow({
        apiKey: ctx.apiKey, models, prompt, fileUri: fileResource.uri, mimeType: fileResource.mimeType,
        startSec: windows.length > 1 ? w.startSec : null, endSec: windows.length > 1 ? w.endSec : null,
      });
      usedModel = r.model;
      const shiftSec = looksExcerptRelative(r.json, { windowStart: w.startSec, windowEnd: w.endSec }) ? w.startSec : 0;
      if (shiftSec) ctx.log?.(`  pass ${w.index + 1}: times looked excerpt-relative; shifted by ${shiftSec}s`);
      const graph = normalizeEventGraph(r.json, { durationSec, shiftSec, clampStart: w.startSec, clampEnd: w.endSec ?? undefined });
      if (durationSec == null && graph.video.duration_sec) durationSec = graph.video.duration_sec;
      passes.push({ index: w.index, windowStart: w.startSec, windowEnd: w.endSec, graph });
    }
    const merged = passes.length === 1 ? passes[0].graph : mergeWindowGraphs(passes, { durationSec });
    if (merged.video.duration_sec == null) merged.video.duration_sec = durationSec;
    const measures = deriveMeasures(merged);

    await setAnalysis(supabase, analysis.id, {
      status: 'ready', progress: 100, progress_note: null, error: null,
      model: usedModel, event_graph: merged, duration_sec: durationSec ?? merged.video.duration_sec ?? null,
      windows: windows.length,
    });
    await progress(99, 'Analysis stored');
    ctx.log?.(`  video analysis ${analysis.id}: ${measures.event_count} events, ${measures.actor_count} actors, ${windows.length} pass(es) via ${usedModel}`);
    return { analysisId: analysis.id, events: measures.event_count, windows: windows.length, model: usedModel };
  } catch (err) {
    if (!(err instanceof SealedPipeError)) {
      await setAnalysis(supabase, analysis.id, { status: 'error', error: String(err?.message ?? err).slice(0, 2000), progress_note: null }).catch(() => {});
    }
    throw err;
  }
}

/** Re-upload only. The event graph stays; the media handle is refreshed. */
export async function runVideoMediaRefreshJob(ctx, job, progress = async () => {}) {
  const { supabase } = ctx;
  const p = job.payload ?? {};
  const analysis = p.analysis_id ? await loadAnalysis(supabase, p.analysis_id) : null;
  if (!analysis) throw new JobRefusedError('the video analysis row this job names no longer exists');
  const doc = await loadDocument(supabase, p.document_id);
  if (!doc) throw new JobRefusedError('the document no longer exists');
  if (doc.matterspace_id !== analysis.matterspace_id) throw new JobRefusedError('the analysis row and the document name different matters');
  if (!doc.storage_path) throw new JobRefusedError('this document has no stored file');
  if (!ctx.apiKey) throw new Error('GOOGLE_API_KEY is not configured on the worker');

  const seal = await matterSeal(supabase, doc.matterspace_id);
  if (seal.sealed) throw new SealedPipeError('video_analysis', { tier: seal.tier, matterName: seal.name });
  await assertAiNotPaused(supabase, doc.matterspace_id, { pipe: 'video_analysis', pause: seal.pause });

  const report = async (pct, note) => {
    await progress(pct, note);
    await setAnalysis(supabase, analysis.id, { progress_note: note }).catch(() => {});
  };
  const { fileResource } = await ensureUploaded({ ctx, doc, analysis, onProgress: report });
  await setAnalysis(supabase, analysis.id, {
    media_provider_ref: fileResource.name, media_uri: fileResource.uri, media_expires_at: gemini.expiryOf(fileResource), progress_note: null,
  });
  await progress(99, 'Recording re-uploaded');
  return { analysisId: analysis.id, media: fileResource.name };
}
