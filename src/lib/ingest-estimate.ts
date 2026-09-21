// The browser's half of the upload estimate: what can be learnt about a file
// BEFORE it is uploaded, and what is left in the person's month.
//
// The arithmetic is not here. It is in lib/ingest-estimate.mjs, which the
// server imports too, so the figure shown in the dialog and the figure the
// handler re-checks come from one piece of code. This file only measures and
// reads:
//
//   measureUploadFiles  type, size, PDF page count, media duration
//   readUploadWallet    the allowance, what is spent, and credits — the
//                       account's OWN rows, under its own RLS
//   effectiveAiTier     whether this matter is sealed, because a sealed
//                       matter's pages are read by a different route at a
//                       different price
//
// Nothing here calls a provider, and nothing is remembered between uploads.

import { supabase } from '@/lib/supabase';
import { PDFJS_DOC_PARAMS } from '@/lib/pdfjs';
import { matterTierWithClient, type AiTier } from '../../lib/ai-tier-policy.mjs';
import { extOf, AUDIO_EXTENSIONS, MEDIA_EXTENSIONS } from '../../lib/ingest-formats.mjs';
import type { UploadItemInput } from '../../lib/ingest-estimate.mjs';

// ---------------------------------------------------------------------------
// Measuring, and its budget
// ---------------------------------------------------------------------------

/**
 * A PDF's page count is read by parsing it, which needs the whole file in
 * memory. Beyond this size the page count is estimated from the bytes instead
 * and the dialog says so — holding a 200 MB scan in an ArrayBuffer to learn a
 * number costs more than the number is worth.
 */
const PARSE_MAX_BYTES = 120 * 1024 * 1024;

/** How long one file may take to measure before its figure is estimated. */
const PER_FILE_TIMEOUT_MS = 5_000;

/**
 * How long the WHOLE measuring pass may take. Past it, everything still
 * unmeasured falls back to its size-derived figure — which is labelled in the
 * dialog — because a person who dropped four hundred files is owed a quote in
 * a moment, not a perfect one in a minute.
 */
const TOTAL_BUDGET_MS = 6_000;

/** Files measured at once. Parsing is CPU-bound; four keeps the tab alive. */
const CONCURRENCY = 4;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pages in a PDF, without rendering one.
 *
 * pdfjs is already in the bundle and already loaded this way by
 * src/lib/office-cover.ts; `numPages` is available the moment the document's
 * catalogue is parsed, so nothing is painted and no page is fetched. An
 * encrypted or damaged file resolves to null rather than throwing — a file
 * that cannot be counted is a file whose count is estimated, not an upload
 * that fails.
 */
export async function pdfPageCount(file: File): Promise<number | null> {
  if (file.size > PARSE_MAX_BYTES) return null;
  let doc: { numPages: number; destroy: () => Promise<void> } | null = null;
  try {
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
    const data = new Uint8Array(await file.arrayBuffer());
    doc = await pdfjsLib.getDocument({ data, ...PDFJS_DOC_PARAMS }).promise;
    const n = doc?.numPages ?? 0;
    return n > 0 ? n : null;
  } catch {
    return null;
  } finally {
    try { await doc?.destroy(); } catch { /* nothing to release */ }
  }
}

/**
 * Minutes of audio or video, from the browser's own metadata parse.
 *
 * `preload="metadata"` reads the container header and stops; no track is
 * decoded and nothing is played. A format the browser cannot open (.wma, some
 * .avi) resolves to null and the length is estimated from the file size.
 */
export async function mediaMinutes(file: File): Promise<number | null> {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(file);
  try {
    const duration = await new Promise<number | null>((resolve) => {
      const el = document.createElement(
        AUDIO_EXTENSIONS.includes(extOf(file.name)) ? 'audio' : 'video',
      ) as HTMLMediaElement;
      el.preload = 'metadata';
      const done = (v: number | null) => {
        el.removeAttribute('src');
        try { el.load(); } catch { /* the element is being thrown away */ }
        resolve(v);
      };
      el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
      el.onerror = () => done(null);
      el.src = url;
    });
    return duration && duration > 0 ? duration / 60 : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Everything the browser can say about a drop, in the order the files came.
 *
 * Deliberately cheap and deliberately bounded: no request is made, nothing is
 * uploaded, and the whole pass gives up after TOTAL_BUDGET_MS with the rest
 * falling back to size-derived figures that the dialog names as estimates.
 */
export async function measureUploadFiles(files: File[]): Promise<UploadItemInput[]> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const out: UploadItemInput[] = files.map((f) => ({ name: f.name, bytes: f.size }));

  const jobs: number[] = [];
  files.forEach((f, i) => {
    const ext = extOf(f.name);
    if (ext === '.pdf' || MEDIA_EXTENSIONS.includes(ext)) jobs.push(i);
  });

  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      if (Date.now() > deadline) return;
      const idx = jobs[i];
      const file = files[idx];
      const ext = extOf(file.name);
      if (ext === '.pdf') {
        const pages = await withTimeout(pdfPageCount(file), PER_FILE_TIMEOUT_MS);
        if (pages) out[idx] = { ...out[idx], pages };
      } else {
        const minutes = await withTimeout(mediaMinutes(file), PER_FILE_TIMEOUT_MS);
        if (minutes) out[idx] = { ...out[idx], minutes };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// What is left in the month
// ---------------------------------------------------------------------------

export interface UploadWallet {
  /** profiles.pricing_tier, or null when it could not be read. */
  plan: string | null;
  /**
   * The month's allowance in cents; null when the tier's budget row says
   * unlimited (workshop) AND `unlimited` is true, or when the row could not be
   * read at all — the two are distinguished by `allowanceKnown`.
   */
  allowanceCents: number | null;
  allowanceKnown: boolean;
  unlimited: boolean;
  usedCents: number | null;
  /** Credits (migration 067); null when the billing tables are not there. */
  creditCents: number | null;
}

/** 'YYYY-MM' in UTC — the key migration 063's usage_month is written with. */
export function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The account's own usage rows.
 *
 * Every read here is the caller's own row under migration 063/067's SELECT
 * policies — no service role, no other tenant. Any of them can fail or be
 * absent (063 or 067 not yet pasted on this database), and every failure
 * resolves to null, which the dialog renders as SILENCE about that line rather
 * than as a zero. A dialog that says "credits: $0.00" because a table is
 * missing is worse than one that does not mention credits.
 */
export async function readUploadWallet(): Promise<UploadWallet> {
  const empty: UploadWallet = {
    plan: null, allowanceCents: null, allowanceKnown: false,
    unlimited: false, usedCents: null, creditCents: null,
  };
  try {
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth?.user?.id;
    if (!userId) return empty;

    const [profileRes, creditRes, monthRes] = await Promise.all([
      supabase.from('profiles').select('pricing_tier').eq('id', userId).maybeSingle(),
      supabase.from('usage_credit_balance').select('cents_available').eq('user_id', userId).maybeSingle(),
      supabase.from('usage_month').select('cents_charged')
        .eq('user_id', userId).eq('month_key', monthKey()).maybeSingle(),
    ]);

    const plan = (profileRes.data?.pricing_tier as string | undefined) ?? null;
    let allowanceCents: number | null = null;
    let allowanceKnown = false;
    let unlimited = false;
    if (plan) {
      const budgetRes = await supabase.from('usage_budgets').select('monthly_cents')
        .eq('pricing_tier', plan).eq('kind', '*').maybeSingle();
      if (!budgetRes.error && budgetRes.data) {
        allowanceKnown = true;
        // A budget row whose monthly_cents is null is the WORKSHOP shape:
        // unlimited by design (063). That account still sees the estimate —
        // it is information — and is never blocked by it.
        if (budgetRes.data.monthly_cents === null) unlimited = true;
        else allowanceCents = Number(budgetRes.data.monthly_cents);
      }
    }

    return {
      plan,
      allowanceCents,
      allowanceKnown,
      unlimited,
      usedCents: monthRes.error ? null : Number(monthRes.data?.cents_charged ?? 0),
      creditCents: creditRes.error ? null : Number(creditRes.data?.cents_available ?? 0),
    };
  } catch {
    return empty;
  }
}

/**
 * Cents this account can still spend, or null when that cannot be known —
 * which includes "unlimited". Null means nothing is ever blocked.
 */
export function remainingCents(wallet: UploadWallet): number | null {
  if (wallet.unlimited) return null;
  if (!wallet.allowanceKnown || wallet.allowanceCents === null || wallet.usedCents === null) return null;
  const left = wallet.allowanceCents - wallet.usedCents;
  return Math.max(0, left) + Math.max(0, wallet.creditCents ?? 0);
}

// ---------------------------------------------------------------------------
// Sealed or not
// ---------------------------------------------------------------------------

/**
 * The matter's effective tier, inherited down the chain exactly as the server
 * reads it (lib/ai-tier-policy.mjs walkEffectiveTier). A sealed matter's scans
 * are read by AWS Textract inside our own account at its own rate, so the
 * figure a sealed matter is shown is not the unsealed one.
 *
 * A lookup that fails answers 'A': the unsealed rate is the DEARER of the two
 * OCR routes, so an unknown tier is quoted high rather than low.
 */
export async function effectiveAiTier(matterId: string): Promise<AiTier> {
  try {
    return (await matterTierWithClient(supabase, matterId)) ?? 'A';
  } catch {
    return 'A';
  }
}
