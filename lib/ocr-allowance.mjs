// The scanned-page meter's client half (migration 107).
//
// One question, asked by lib/ingest-core.mjs just before it spends OCR on a
// document: "may this document's uploader have N more scanned pages read?"
// The answer comes from public.ocr_pages_reserve, which also records the
// charge — so asking IS charging, and a retry of the same document is charged
// only for pages it has not been charged for already.
//
// Why a hook and why the service role
// ---------------------------------------------------------------------------
// The pipeline runs as many identities — the uploader's own JWT inline in
// /api/ingest, the service role on the Fly worker, either from the MCP tool —
// but the meter belongs to the document's UPLOADER, whoever is running it. So
// the RPC is service-role only (nothing a signed-in user can call may spend
// someone else's allowance) and this module speaks to it with the service
// key, whatever client the pipeline itself was handed.
//
// Failure policy: fail OPEN. No service key, a missing function (107 not yet
// applied), a timeout, a 5xx — every one of them answers allowed, and logs.
// A scan read during an outage costs a fifth of a cent a page; a production
// refused by a database blip costs a customer. Same choice as
// lib/usage-meter.mjs makes for the money wallet.
//
// No @supabase/supabase-js import: a plain fetch is injectable for tests and
// costs nothing at cold start.

const TIMEOUT_MS = 4000;
const LOG = '[ocr-allowance]';

/**
 * Build the hook, or null when this process cannot reach the meter at all
 * (no Supabase URL or no service key — a local test, a CLI without keys).
 *
 * The hook: async ({ documentId, pages }) =>
 *   { allowed: true, charged, ... }                       read the pages
 *   { allowed: false, reason: 'ocr_allowance_exhausted',  leave them waiting
 *     need, used, monthly_ocr_pages, month_key }
 */
export function makeOcrAllowance(env = process.env, { fetchImpl = null, timeoutMs = TIMEOUT_MS } = {}) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const endpoint = `${String(url).replace(/\/$/, '')}/rest/v1/rpc/ocr_pages_reserve`;

  return async function reserveOcrPages({ documentId, pages }) {
    const n = Math.max(0, Math.floor(Number(pages) || 0));
    if (!documentId || n === 0) return { allowed: true, charged: 0 };
    const doFetch = fetchImpl || globalThis.fetch;
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: key, authorization: `Bearer ${key}` },
        body: JSON.stringify({ p_document: documentId, p_pages: n }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        console.error(`${LOG} reserve ${n} page(s) for ${documentId} failed: HTTP ${res.status} ${text.slice(0, 200)} — allowing`);
        return { allowed: true, charged: 0, degraded: true };
      }
      const data = text ? JSON.parse(text) : null;
      if (!data || typeof data.allowed !== 'boolean') {
        console.error(`${LOG} reserve for ${documentId}: unreadable answer — allowing`);
        return { allowed: true, charged: 0, degraded: true };
      }
      return data;
    } catch (err) {
      console.error(`${LOG} reserve for ${documentId} threw: ${err?.message || err} — allowing`);
      return { allowed: true, charged: 0, degraded: true };
    }
  };
}

/** The sentence a person reads on a document whose scanned pages are waiting. */
export function overAllowanceReason(gate, pages) {
  const n = Number(pages) || Number(gate?.need) || 0;
  const what = n === 1 ? '1 scanned page is' : `${n.toLocaleString('en-US')} scanned pages are`;
  return `Your plan's scanned-page (OCR) allowance for this month is used up, so ${what} waiting to be read. ` +
    'Buy an OCR pack in Settings › Billing and they will be read right away; otherwise they are read when the allowance renews on the 1st. ' +
    'The file is stored and any typed pages are already searchable.';
}

/** 'YYYY-MM' in UTC — the same month key the database uses. */
export function utcMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}
