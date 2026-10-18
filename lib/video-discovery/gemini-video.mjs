// lib/video-discovery/gemini-video.mjs — the Google Gemini adapter for the Video Room.
//
// The one file in the module that knows Gemini's request shape. It uploads a
// stored recording from DISK to the Files API in resumable 16 MB chunks (a
// 1.2 GB file must never be a Buffer — the worker's own 2026-10-04 lesson),
// waits for the file to become ACTIVE, and asks for structured JSON against the
// schemas in schemas.mjs, optionally restricted to a time window with the
// request's video metadata. Model ids come from the environment; the repo has
// only ever shipped gemini-2.5-flash, so that is the fallback.
//
// Sealed matters never reach this file: the worker and the API refuse before
// any upload (lib/seal-pipes.mjs, pipe 'video_analysis').
//
//   GEMINI_VIDEO_MODELS   comma-separated ids, tried in order (optional)
//   GEMINI_VIDEO_MODEL    one id (optional; used when the list is absent)
//   GOOGLE_API_KEY        required, from process.env only


import fsp from 'node:fs/promises';
import path from 'node:path';
import { EVENT_GRAPH_SCHEMA, INTERROGATION_SCHEMA } from './schemas.mjs';

const GEMINI = 'https://generativelanguage.googleapis.com';
const CHUNK_BYTES = 16 * 1024 * 1024;
const DEFAULT_MODEL = 'gemini-2.5-flash';

/** Gemini keeps an uploaded file for 48 h; we treat it as gone an hour early. */
export const MEDIA_TTL_MS = 47 * 60 * 60 * 1000;

export const PROVIDER = 'google';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (n) => Math.min(1000 * 2 ** n, 30000) + Math.floor(Math.random() * 1000);

export function modelsFromEnv(env = process.env) {
  const list = String(env.GEMINI_VIDEO_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  return [String(env.GEMINI_VIDEO_MODEL ?? '').trim() || DEFAULT_MODEL];
}

/** A stable display name per document, so a still-ACTIVE earlier upload can be found and reused. */
export function displayNameFor(documentId) {
  return `cs-video-${documentId}`;
}

export function mimeForExt(ext) {
  const e = String(ext ?? '').toLowerCase();
  return ({
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
    '.mov': 'video/mov', '.avi': 'video/avi', '.webm': 'video/webm', '.wmv': 'video/wmv', '.3gp': 'video/3gpp',
  })[e] ?? 'video/mp4';
}

// ---------------------------------------------------------------------------
// Files API
// ---------------------------------------------------------------------------
async function withRetries(label, fn, { attempts = 5 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      last = err;
      if (err?.noRetry) throw err;
      if (i < attempts - 1) await sleep(backoff(i));
    }
  }
  throw new Error(`${label}: ${last?.message ?? last}`);
}

/**
 * Upload a file on disk in resumable chunks. Returns the file resource
 * ({ name, uri, mimeType, state, sizeBytes, expirationTime }).
 */
export async function uploadVideoFromPath({ apiKey, filePath, mimeType = 'video/mp4', displayName, onProgress = () => {} }) {
  if (!apiKey) throw new Error('gemini-video: apiKey required');
  const { size: totalBytes } = await fsp.stat(filePath);
  if (!(totalBytes > 0)) throw new Error('gemini-video: empty file');

  const start = await withRetries('files.start', async () => {
    const res = await fetch(`${GEMINI}/upload/v1beta/files?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(totalBytes),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName || path.basename(filePath) } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const url = res.headers.get('x-goog-upload-url');
    if (!url) throw new Error('no upload URL');
    return url;
  });

  const fh = await fsp.open(filePath, 'r');
  let fileInfo = null;
  try {
    let offset = 0;
    while (offset < totalBytes) {
      const len = Math.min(CHUNK_BYTES, totalBytes - offset);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      if (bytesRead !== len) throw new Error(`short read at ${offset}`);
      const isLast = offset + len >= totalBytes;
      onProgress({ stage: 'uploading', offset, total: totalBytes, pct: Math.round((offset / totalBytes) * 100) });
      const chunkOffset = offset;
      const json = await withRetries(`files.upload@${chunkOffset}`, async () => {
        const res = await fetch(start, {
          method: 'POST',
          headers: {
            'Content-Length': String(len),
            'X-Goog-Upload-Offset': String(chunkOffset),
            'X-Goog-Upload-Command': isLast ? 'upload, finalize' : 'upload',
          },
          body: buf,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return isLast ? res.json() : null;
      });
      if (isLast) fileInfo = json;
      offset += len;
    }
  } finally {
    await fh.close();
  }
  if (!fileInfo?.file?.name) throw new Error('gemini-video: upload finalised but no file resource returned');
  onProgress({ stage: 'uploaded', offset: totalBytes, total: totalBytes, pct: 100 });
  return fileInfo.file;
}

/** The file resource, or null when Gemini no longer has it (404). */
export async function getFile({ apiKey, name }) {
  if (!name) return null;
  const res = await fetch(`${GEMINI}/v1beta/${name}?key=${apiKey}`);
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`files.get ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function waitActive({ apiKey, name, timeoutMs = 20 * 60 * 1000, pollMs = 8000, onProgress = () => {} }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const f = await getFile({ apiKey, name });
    if (!f) throw new Error('gemini-video: file disappeared while processing');
    if (f.state === 'ACTIVE') return f;
    if (f.state === 'FAILED') throw new Error(`gemini-video: processing FAILED: ${JSON.stringify(f.error ?? {}).slice(0, 200)}`);
    onProgress({ stage: 'processing', message: `Provider is processing the upload (${Math.round((Date.now() - started) / 1000)}s)` });
    await sleep(pollMs);
  }
  throw new Error('gemini-video: timed out waiting for the upload to become ACTIVE');
}

export async function deleteFile({ apiKey, name }) {
  if (!name) return;
  try { await fetch(`${GEMINI}/v1beta/${name}?key=${apiKey}`, { method: 'DELETE' }); } catch { /* best effort */ }
}

/** An ACTIVE file with this display name, if one exists (paged list). */
export async function findActiveByDisplayName({ apiKey, displayName, maxPages = 10 }) {
  let pageToken = null;
  for (let i = 0; i < maxPages; i++) {
    const url = new URL(`${GEMINI}/v1beta/files`);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const hit = (data.files ?? []).find((f) => f.displayName === displayName && f.state === 'ACTIVE');
    if (hit) return hit;
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return null;
}

/** The recording's length from the file resource (Gemini reports videoMetadata.videoDuration as "90s"), or null. */
export function durationOf(fileResource) {
  const raw = fileResource?.videoMetadata?.videoDuration ?? fileResource?.video_metadata?.video_duration ?? null;
  if (raw == null) return null;
  const n = Number(String(raw).replace(/s$/i, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** When Gemini says it will drop the file, or our own 47 h if it did not say. */
export function expiryOf(fileResource, now = Date.now()) {
  const t = fileResource?.expirationTime ? Date.parse(fileResource.expirationTime) : NaN;
  const own = now + MEDIA_TTL_MS;
  return new Date(Number.isFinite(t) ? Math.min(t, own) : own).toISOString();
}

// ---------------------------------------------------------------------------
// Structured generation
// ---------------------------------------------------------------------------
function videoPart({ fileUri, mimeType, startSec, endSec, fps }) {
  const part = { fileData: { mimeType: mimeType || 'video/mp4', fileUri } };
  const meta = {};
  if (startSec != null) meta.startOffset = `${Math.max(0, Math.floor(startSec))}s`;
  if (endSec != null) meta.endOffset = `${Math.max(0, Math.ceil(endSec))}s`;
  if (fps != null) meta.fps = fps;
  if (Object.keys(meta).length) part.videoMetadata = meta;
  return part;
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('');
}

function parseJsonLoose(text) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('empty answer');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('answer was not JSON');
}

/**
 * Ask for JSON against `schema`, trying each model in order. Returns
 * { json, model, usage, ms, finishReason }. Throws with the last error when
 * every model failed.
 */
export async function generateJson({
  apiKey, models, prompt, fileUri, mimeType, schema,
  startSec = null, endSec = null, fps = null,
  maxOutputTokens = 65536, temperature = 0.1, onProgress = () => {},
}) {
  if (!apiKey) throw new Error('gemini-video: apiKey required');
  const list = Array.isArray(models) && models.length ? models : modelsFromEnv();
  let lastErr = null;
  for (const model of list) {
    onProgress({ stage: 'querying', model });
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }, videoPart({ fileUri, mimeType, startSec, endSec, fps })] }],
      generationConfig: {
        temperature,
        maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    };
    const started = Date.now();
    try {
      const data = await withRetries(`generate(${model})`, async (attempt) => {
        const res = await fetch(`${GEMINI}/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        if (res.ok) return JSON.parse(text);
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        // A model that does not exist or refuses the schema will not start working on retry.
        if (res.status === 400 || res.status === 404) err.noRetry = true;
        if (res.status === 429 && attempt < 4) err.message += ' (rate limited)';
        throw err;
      });
      const text = extractText(data);
      const finishReason = data?.candidates?.[0]?.finishReason ?? null;
      let json;
      try {
        json = parseJsonLoose(text);
      } catch (e) {
        throw new Error(`${model}: ${e.message}${finishReason ? ` (finishReason ${finishReason})` : ''}`);
      }
      return {
        json, model, finishReason,
        usage: data?.usageMetadata ?? null,
        ms: Date.now() - started,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`gemini-video: every model failed — ${lastErr?.message ?? lastErr}`);
}

export function analyzeWindow({ apiKey, models, prompt, fileUri, mimeType, startSec, endSec, onProgress }) {
  return generateJson({ apiKey, models, prompt, fileUri, mimeType, schema: EVENT_GRAPH_SCHEMA, startSec, endSec, onProgress });
}

export function interrogate({ apiKey, models, prompt, fileUri, mimeType, startSec, endSec, onProgress }) {
  return generateJson({ apiKey, models, prompt, fileUri, mimeType, schema: INTERROGATION_SCHEMA, startSec, endSec, maxOutputTokens: 16384, onProgress });
}

/** The models the key can see, for a smoke script to print — never hardcode ids from a memo. */
export async function listModels({ apiKey }) {
  const res = await fetch(`${GEMINI}/v1beta/models?key=${apiKey}&pageSize=200`);
  if (!res.ok) throw new Error(`models.list ${res.status}`);
  const data = await res.json();
  return (data.models ?? []).map((m) => ({ name: m.name?.replace(/^models\//, ''), methods: m.supportedGenerationMethods ?? [] }));
}


