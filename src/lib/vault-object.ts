// A stored file's bytes, the way S4a allows them (migration 096).
//
// On an unsealed (Tier A) matter the browser signs its own storage URL, as it
// always has, and nothing is recorded — opening a document to read it is not
// a copy leaving the matter (docs/specs/SECURITY-BUILD-2026-09-26.md §S4a and
// the claims table in §4).
//
// On a SEALED matter (effective tier B or C, inherited) the bucket refuses
// the browser, and the only way to the bytes is /api/document-url, which asks
// the step-up gate, mints a 900-second URL and writes `file.opened` to the
// matter's Record before it answers.
//
// How the browser knows which: one call to 094's effective_tier_is_sealed
// for the matter the path names (every object lives at "<matter>/…", which
// is also how the bucket decides). That is cheaper than asking the endpoint
// first — a database round trip instead of a serverless invocation, an auth
// check and a mint — and it keeps Tier A reads exactly as fast as they were.
// The answer is kept for a minute per matter. When it cannot be had (094 not
// pasted, a network blip) the direct path is tried first and a refusal falls
// through to the endpoint, so a matter sealed mid-session still opens.
//
// The explicit Download button is different: it always goes through the
// endpoint (purpose 'download'), on every matter, so the Record shows every
// copy a person deliberately took away — `file.exported {destination:
// 'download'}`.

import { supabase } from '@/lib/supabase';

export type StorageBucket = 'vault-documents' | 'discovery-files';
export type ObjectPurpose = 'read' | 'download';

/** The endpoint's step-up refusal: render StepUpPrompt with `mode`, then retry. */
export class StepUpRequired extends Error {
  readonly mode: 'stepup' | 'enrol';
  readonly matterId: string | null;
  constructor(mode: 'stepup' | 'enrol', matterId: string | null) {
    super(mode === 'enrol'
      ? 'This matter is sealed. Add a second factor to open it.'
      : 'This matter is sealed. Confirm it’s you.');
    this.name = 'StepUpRequired';
    this.mode = mode;
    this.matterId = matterId;
  }
}

export function isStepUpRequired(e: unknown): e is StepUpRequired {
  return e instanceof StepUpRequired;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The matter a stored object belongs to: the first segment of its path. */
export function matterOfPath(path: string): string | null {
  const first = String(path ?? '').split('/')[0];
  return UUID_RE.test(first) ? first.toLowerCase() : null;
}

const SEAL_TTL_MS = 60_000;
const sealCache = new Map<string, { at: number; sealed: Promise<boolean | null> }>();

/** Is this matter sealed? Null when the database cannot say. */
export function isSealedMatter(matterId: string | null): Promise<boolean | null> {
  if (!matterId) return Promise.resolve(false);
  const hit = sealCache.get(matterId);
  if (hit && Date.now() - hit.at < SEAL_TTL_MS) return hit.sealed;
  const sealed = (async () => {
    const { data, error } = await supabase.rpc('effective_tier_is_sealed', { p_matter: matterId });
    if (error || typeof data !== 'boolean') return null;
    return data;
  })();
  sealCache.set(matterId, { at: Date.now(), sealed });
  void sealed.then((v) => { if (v === null) sealCache.delete(matterId); });
  return sealed;
}

export interface MintedUrl {
  url: string;
  /** When the URL stops working (epoch ms). */
  expiresAt: number;
  /** True when the endpoint served it because the matter is sealed. */
  sealed: boolean;
  filename: string | null;
}

/** Ask /api/document-url. Throws StepUpRequired on the gate's refusal. */
export async function mintViaEndpoint(req: {
  purpose: ObjectPurpose;
  bucket?: StorageBucket;
  path?: string;
  documentId?: string;
}): Promise<MintedUrl> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in.');
  const res = await fetch('/api/document-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      purpose: req.purpose,
      bucket: req.bucket ?? 'vault-documents',
      ...(req.documentId ? { document_id: req.documentId } : { path: req.path }),
    }),
  });
  const body = await res.json().catch(() => null) as
    | { url?: string; expires_in?: number; sealed?: boolean; filename?: string; error?: string; mode?: string; matter_id?: string }
    | null;
  if (res.status === 403 && body?.error === 'step_up_required') {
    throw new StepUpRequired(body.mode === 'enrol' ? 'enrol' : 'stepup', body.matter_id ?? null);
  }
  if (!res.ok || !body?.url) {
    const why = body?.error === 'record_failed'
      ? 'This matter is sealed and its Record could not be written just now, so the file was not opened. Try again in a moment.'
      : body?.error === 'not_found'
        ? 'The file could not be found.'
        : `The file could not be opened (${body?.error ?? res.status}).`;
    throw new Error(why);
  }
  return {
    url: body.url,
    expiresAt: Date.now() + (body.expires_in ?? 900) * 1000,
    sealed: body.sealed === true,
    filename: body.filename ?? null,
  };
}

/**
 * A URL to READ a stored object. `ttlSeconds` applies to the direct (Tier A)
 * path only; the endpoint's URLs last 900 s, and callers that hold one longer
 * ask again when it lapses.
 */
export async function storageObjectUrl(
  path: string,
  opts: { bucket?: StorageBucket; ttlSeconds?: number; purpose?: ObjectPurpose } = {},
): Promise<MintedUrl> {
  const bucket = opts.bucket ?? 'vault-documents';
  const purpose = opts.purpose ?? 'read';
  const ttl = opts.ttlSeconds ?? 900;
  const sealed = await isSealedMatter(matterOfPath(path));
  if (sealed === true) return mintViaEndpoint({ purpose, bucket, path });

  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, ttl);
  if (!error && data?.signedUrl) {
    return { url: data.signedUrl, expiresAt: Date.now() + ttl * 1000, sealed: false, filename: null };
  }
  // Refused directly. If the matter was sealed after we last looked (or we
  // could not tell), the endpoint is the door; otherwise say what storage said.
  sealCache.delete(matterOfPath(path) ?? '');
  try {
    return await mintViaEndpoint({ purpose, bucket, path });
  } catch (e) {
    if (isStepUpRequired(e)) throw e;
    throw new Error(error?.message ?? (e instanceof Error ? e.message : 'no signed url'));
  }
}

/** A stored object's bytes, to read in the browser (Word, text, slides, print). */
export async function storageObjectBlob(
  path: string,
  opts: { bucket?: StorageBucket } = {},
): Promise<Blob> {
  const bucket = opts.bucket ?? 'vault-documents';
  const sealed = await isSealedMatter(matterOfPath(path));
  if (sealed !== true) {
    const { data, error } = await supabase.storage.from(bucket).download(path);
    if (!error && data) return data;
    if (sealed === false && error) {
      // Tier A and refused: not a seal question. One more look in case the
      // matter was sealed a moment ago; otherwise report storage's answer.
      sealCache.delete(matterOfPath(path) ?? '');
      if ((await isSealedMatter(matterOfPath(path))) !== true) throw new Error(error.message);
    }
  }
  const minted = await mintViaEndpoint({ purpose: 'read', bucket, path });
  const res = await fetch(minted.url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return res.blob();
}

/**
 * The Reader's Download button: always through the endpoint, on every
 * matter, so the Record holds `file.exported {destination:'download'}`.
 */
export async function downloadDocumentFile(documentId: string): Promise<{ blob: Blob; filename: string | null }> {
  const minted = await mintViaEndpoint({ purpose: 'download', documentId });
  const res = await fetch(minted.url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return { blob: await res.blob(), filename: minted.filename };
}
