// Resumable uploads to Supabase Storage over the TUS protocol (Phase 4 of the
// ingestion plan, 2026-09-04: "resumable uploads for > 50 MB").
//
// A 300 MB production uploaded through a single PUT is one connection that
// must survive to the end; on hotel Wi-Fi it does not, and the browser's only
// answer is to start again from byte zero. TUS (tus.io) is the open resumable
// protocol Supabase Storage speaks: create an upload, PATCH it in chunks, and
// on any interruption ask the server how far it got (HEAD → Upload-Offset)
// and continue from there. The upload URL is remembered per file for a day,
// so even a closed tab resumes where it stopped.
//
// Dependency-free and isomorphic on purpose (fetch + Blob, which Node 22 and
// every browser have), like lib/ingest-formats.mjs: the browser imports it
// directly (src/lib/vault-persist.ts) and the Node smoke test exercises the
// same bytes against the same endpoint with the service role, interruption
// included. One implementation, proven where it is easy to prove.
//
// Supabase specifics baked in (all documented at supabase.com/docs/guides/
// storage/uploads/resumable-uploads): the endpoint is /storage/v1/upload/
// resumable; chunks must be exactly 6 MB except the last; the object is
// named through Upload-Metadata (bucketName, objectName, contentType,
// cacheControl); upsert is the x-upsert header; upload URLs expire after 24 h.

export const TUS_VERSION = '1.0.0';
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
export const TUS_URL_TTL_MS = 24 * 60 * 60 * 1000;

/** Files at or above this size use the resumable path; smaller ones keep the single request. */
export const RESUMABLE_MIN_BYTES = 50 * 1024 * 1024;

/** True when a file is big enough that a dropped connection would hurt. */
export function shouldUploadResumable(sizeBytes) {
  return (Number(sizeBytes) || 0) >= RESUMABLE_MIN_BYTES;
}

const b64 = (s) => {
  const bytes = new TextEncoder().encode(String(s));
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** TUS Upload-Metadata: comma-separated "key base64(value)" pairs. */
export function encodeUploadMetadata(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k} ${b64(v)}`)
    .join(',');
}

/** What identifies "the same file, the same destination" across attempts. */
export function tusFingerprint({ bucket, objectName, size, lastModified = 0 }) {
  return `tus:${bucket}/${objectName}:${size}:${lastModified || 0}`;
}

/** An in-memory resume store (tests, Node). */
export function memoryResumeStore() {
  const m = new Map();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { m.set(k, v); },
    delete: (k) => { m.delete(k); },
  };
}

/**
 * A resume store over Web Storage. Every call is wrapped: storage can be
 * absent, full, or throwing (private windows, blocked site data), and an
 * upload must never fail because its bookmark could not be written.
 */
export function storageResumeStore(storage) {
  const key = (k) => `cs.${k}`;
  return {
    get(k) {
      try {
        const raw = storage?.getItem(key(k));
        if (!raw) return null;
        const rec = JSON.parse(raw);
        if (!rec?.url || !rec?.at || Date.now() - rec.at > TUS_URL_TTL_MS) { this.delete(k); return null; }
        return rec.url;
      } catch { return null; }
    },
    set(k, url) {
      try { storage?.setItem(key(k), JSON.stringify({ url, at: Date.now() })); } catch { /* best effort */ }
    },
    delete(k) {
      try { storage?.removeItem(key(k)); } catch { /* best effort */ }
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (n) => Math.min(1000 * 2 ** n, 30_000) + Math.floor(Math.random() * 500);

class TusHttpError extends Error {
  constructor(status, text, phase) {
    super(`resumable upload ${phase}: ${status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    this.name = 'TusHttpError';
    this.status = status;
    this.phase = phase;
  }
}
const retryableStatus = (s) => s === 408 || s === 425 || s === 429 || s === 500 || s === 502 || s === 503 || s === 504;

/**
 * Upload `blob` to `bucket/objectName`, resuming an earlier attempt when the
 * resume store knows one. Resolves when the server has every byte.
 *
 *   supabaseUrl  — the project URL (https://<ref>.supabase.co)
 *   token        — the user's access token (browser) or the service key (Node)
 *   apikey       — the anon key (browser) — sent beside the bearer as Storage expects
 *   onProgress   — ({ sent, total, pct }) after every chunk
 *   resumeStore  — get/set/delete of upload URLs by fingerprint (storageResumeStore in the browser)
 *   signal       — AbortSignal; an abort leaves the bookmark so the next call resumes
 *   fetchImpl    — injectable for the interruption test
 *
 * Returns { uploadUrl, resumedFrom } — resumedFrom is the byte offset an
 * earlier attempt had reached, 0 for a fresh upload.
 */
export async function uploadResumable({
  supabaseUrl,
  token,
  apikey = null,
  bucket,
  objectName,
  blob,
  contentType = 'application/octet-stream',
  cacheControl = '3600',
  upsert = true,
  lastModified = 0,
  onProgress = () => {},
  resumeStore = memoryResumeStore(),
  signal = null,
  fetchImpl = globalThis.fetch,
  chunkBytes = TUS_CHUNK_BYTES,
  maxRetries = 20,
  sleepImpl = sleep,
}) {
  if (!supabaseUrl || !token || !bucket || !objectName || !blob) throw new Error('uploadResumable: supabaseUrl, token, bucket, objectName and blob are required');
  const size = blob.size;
  const endpoint = `${String(supabaseUrl).replace(/\/+$/, '')}/storage/v1/upload/resumable`;
  const baseHeaders = {
    'tus-resumable': TUS_VERSION,
    authorization: `Bearer ${token}`,
    ...(apikey ? { apikey } : {}),
    'x-upsert': upsert ? 'true' : 'false',
  };
  const fp = tusFingerprint({ bucket, objectName, size, lastModified });
  const throwIfAborted = () => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('upload aborted'); };

  // Where an earlier attempt got to, if the server still has it.
  async function offsetOf(url) {
    const res = await fetchImpl(url, { method: 'HEAD', headers: baseHeaders, signal });
    if (!res.ok) throw new TusHttpError(res.status, '', 'resume');
    const off = Number(res.headers.get('upload-offset'));
    const len = res.headers.get('upload-length');
    if (!Number.isFinite(off) || (len != null && Number(len) !== size)) throw new TusHttpError(409, 'offset/length mismatch', 'resume');
    return off;
  }

  let uploadUrl = resumeStore.get(fp);
  let offset = 0;
  let resumedFrom = 0;
  if (uploadUrl) {
    try {
      offset = await offsetOf(uploadUrl);
      resumedFrom = offset;
    } catch {
      // Expired, gone, or not ours any more: start over, quietly.
      resumeStore.delete(fp);
      uploadUrl = null;
      offset = 0;
    }
  }

  if (!uploadUrl) {
    let attempt = 0;
    for (;;) {
      throwIfAborted();
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            ...baseHeaders,
            'upload-length': String(size),
            'upload-metadata': encodeUploadMetadata({ bucketName: bucket, objectName, contentType, cacheControl }),
          },
          signal,
        });
      } catch (err) {
        if (signal?.aborted || attempt >= maxRetries) throw err;
        await sleepImpl(backoffMs(attempt++)); continue;
      }
      if (res.status === 201) {
        const loc = res.headers.get('location');
        if (!loc) throw new TusHttpError(201, 'no Location header', 'create');
        uploadUrl = new URL(loc, endpoint).toString();
        resumeStore.set(fp, uploadUrl);
        break;
      }
      const text = await res.text().catch(() => '');
      if (!retryableStatus(res.status) || attempt >= maxRetries) throw new TusHttpError(res.status, text, 'create');
      await sleepImpl(backoffMs(attempt++));
    }
  }

  onProgress({ sent: offset, total: size, pct: size ? Math.floor((offset / size) * 100) : 100 });

  let failures = 0;
  while (offset < size) {
    throwIfAborted();
    const end = Math.min(offset + chunkBytes, size);
    const chunk = blob.slice(offset, end);
    let res;
    try {
      res = await fetchImpl(uploadUrl, {
        method: 'PATCH',
        headers: {
          ...baseHeaders,
          'upload-offset': String(offset),
          'content-type': 'application/offset+octet-stream',
        },
        body: chunk,
        signal,
      });
    } catch (err) {
      // The connection dropped mid-chunk. The server may have kept part of
      // it: ask, then continue from wherever it says.
      if (signal?.aborted) throw err;
      if (++failures > maxRetries) throw new Error(`resumable upload: gave up after ${maxRetries} retries (${err?.message || err}); the upload can be resumed later`);
      await sleepImpl(backoffMs(failures - 1));
      try { offset = await offsetOf(uploadUrl); } catch { /* keep the offset we had; the next PATCH will 409 and resync */ }
      continue;
    }
    if (res.status === 204 || res.status === 200) {
      const next = Number(res.headers.get('upload-offset'));
      offset = Number.isFinite(next) ? next : end;
      failures = 0;
      onProgress({ sent: offset, total: size, pct: Math.floor((offset / size) * 100) });
      continue;
    }
    if (res.status === 409) {
      // Our idea of the offset is stale (a retried chunk landed after all).
      offset = await offsetOf(uploadUrl);
      continue;
    }
    const text = await res.text().catch(() => '');
    if (res.status === 404 || res.status === 410) {
      resumeStore.delete(fp);
      throw new TusHttpError(res.status, 'upload expired — start it again', 'upload');
    }
    if (!retryableStatus(res.status) || ++failures > maxRetries) throw new TusHttpError(res.status, text, 'upload');
    await sleepImpl(backoffMs(failures - 1));
  }

  resumeStore.delete(fp);
  return { uploadUrl, resumedFrom, size };
}
