// lib/trademark/tsdr.mjs — the USPTO TSDR API client (stage 6, the deep check).
//
// Verified 2026-10-21 (spec §8.6 has the quotes; developer.uspto.gov now
// redirects to data.uspto.gov, whose pages are a script app, so the
// documentation was read from Wayback snapshots of the developer.uspto.gov
// FAQ, the Enterprise API User Guide v2 and the TSDR swagger_v1.json, and the
// live API was probed without a key):
//
//   * host https://tsdrapi.uspto.gov, base path /ts/cd/
//   * JSON is documented only for caseMultiStatus:
//       GET /ts/cd/caseMultiStatus/sn?ids=78787878,76767676
//     ("Returns case details for multiple cases as a JSON"); the single-case
//     casestatus/sn{serial}/info returns ST96 XML. This client uses
//     caseMultiStatus, one request for a whole batch of serials.
//   * the key goes in the header USPTO-API-KEY (account.uspto.gov/api-manager,
//     "Select TSDR"); no key → 401.
//   * "All requests are rate limited at 60 requests per API key per minute.
//     PDF, ZIP, and multi-case downloads are rate limited at four requests per
//     API key per minute." → 429. Whether caseMultiStatus JSON counts as a
//     "multi-case download" is not stated, so this client assumes the lower
//     limit: at most one request every 15 seconds per process. Retry-After is
//     not documented; it is honoured when present, otherwise the backoff is
//     exponential (15 s, 30 s, 60 s), then the call gives up and says so.
//   * response shape, from the swagger schema (no real response was seen —
//     no key): transactionList[].trademarks[] with status{serialNumber,
//     markElement, status, statusDate, extStatusDesc, tm5StatusDesc,
//     usRegistrationNumber, usRegistrationDate, filingDate, dateAbandoned,
//     dateCancelled}, parties.currentOwners[].name, gsList[]{description,
//     internationalClasses[].code}, prosecutionHistory[]{entryDate, entryCode,
//     entryDesc}. There is NO live/dead field: `live` is read from the TM5 /
//     extended status text and the abandoned / cancelled dates, and is null
//     (not guessed) when they say nothing. Every unmapped field is kept in
//     `raw_keys` so a mapping gap shows rather than hides. [M] until a real
//     response has been seen with Eden's key.
//
// The key comes only from the server's environment (USPTO_TSDR_API_KEY);
// it never reaches a browser, a Record row, a filed document or a log line.

import { liveFromStatus } from './parse.mjs';

export const TSDR_HOST = 'https://tsdrapi.uspto.gov';
export const TSDR_MULTI_PATH = '/ts/cd/caseMultiStatus/sn';
export const TSDR_KEY_HEADER = 'USPTO-API-KEY';
export const TSDR_KEY_ENV = 'USPTO_TSDR_API_KEY';
/** The assumed limit (see above): one request per 15 s per process. */
export const TSDR_MIN_INTERVAL_MS = 15_000;
export const TSDR_MAX_RETRIES = 3;
/** Serials per caseMultiStatus request. The documented example has two; ten is [M]. */
export const TSDR_BATCH = 10;

export const TSDR_NOT_CONFIGURED =
  'The USPTO TSDR API key is not set on this server (USPTO_TSDR_API_KEY), so no official status was fetched. ' +
  'Nothing was guessed. The reviewer may skip stage 6, or check each record by hand on tsdr.uspto.gov.';

export const TSDR_SOURCE_NOTE = 'Source: USPTO TSDR API (caseMultiStatus), as returned, unedited except for layout.';

/** The public TSDR page for a serial (a link for the reviewer; never fetched by this code). */
export const publicStatusUrl = (serial) => `https://tsdr.uspto.gov/#caseNumber=${serial}&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch`;

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const dateOnly = (v) => {
  const s = String(v ?? '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : (s || null);
};
const text = (v, max = 2000) => (v == null ? null : String(v).trim().slice(0, max) || null);

/**
 * Map one `trademarks[]` entry to the hit's tsdr record. Only fields that are
 * present are filled; nothing is defaulted.
 */
export function mapTrademark(tm, serialAsked) {
  const st = tm?.status ?? {};
  const serial = String(st.serialNumber ?? serialAsked ?? '').replace(/\D/g, '');
  const statusText = text(st.tm5StatusDesc) || text(st.extStatusDesc) || text(st.statusStr) || null;
  let live = liveFromStatus(st.tm5StatusDesc) ?? liveFromStatus(st.extStatusDesc) ?? liveFromStatus(st.statusStr);
  if (live === null && (st.dateAbandoned || st.dateCancelled)) live = false;
  const owners = Array.isArray(tm?.parties?.currentOwners) ? tm.parties.currentOwners : [];
  const owner = owners.map((o) => text(o?.name, 300)).filter(Boolean).join('; ') || null;
  const gs = Array.isArray(tm?.gsList) ? tm.gsList : [];
  const classes = [...new Set(gs.flatMap((g) => (Array.isArray(g?.internationalClasses) ? g.internationalClasses : [])
    .map((x) => String(x?.code ?? '').replace(/\D/g, '').padStart(3, '0')).filter((x) => /^\d{3}$/.test(x))))].sort();
  const goods = gs.map((g) => ({
    class: (Array.isArray(g?.internationalClasses) ? g.internationalClasses : []).map((x) => String(x?.code ?? '')).filter(Boolean).join(' '),
    text: text(g?.description, 4000) ?? '',
  })).filter((g) => g.text).slice(0, 45);
  const history = (Array.isArray(tm?.prosecutionHistory) ? tm.prosecutionHistory : []).map((e) => ({
    date: dateOnly(e?.entryDate), code: text(e?.entryCode, 20), description: text(e?.entryDesc, 500),
  })).filter((e) => e.date || e.description).slice(0, 300);
  return {
    serial,
    mark: text(st.markElement, 500),
    status_code: st.status != null ? String(st.status) : null,
    status_text: statusText,
    status_date: dateOnly(st.statusDate),
    live,
    filing_date: dateOnly(st.filingDate),
    registration_number: text(st.usRegistrationNumber, 20),
    registration_date: dateOnly(st.usRegistrationDate),
    owner,
    classes,
    goods_services: goods,
    events: history,
    raw_keys: Object.keys(tm ?? {}).sort(),
    source: `${TSDR_HOST}${TSDR_MULTI_PATH}?ids=${serial}`,
  };
}

/** Every trademark in a caseMultiStatus body, by serial. */
export function parseMultiStatus(body) {
  const out = new Map();
  const list = Array.isArray(body?.transactionList) ? body.transactionList : [];
  for (const t of list) {
    for (const tm of Array.isArray(t?.trademarks) ? t.trademarks : []) {
      const rec = mapTrademark(tm);
      if (rec.serial) out.set(rec.serial, rec);
    }
  }
  return out;
}

/**
 * @param {object} o
 * @param {string} [o.apiKey]          from the server env only
 * @param {typeof fetch} [o.fetchImpl]
 * @param {(ms:number)=>Promise<void>} [o.sleep]
 * @param {() => number} [o.now]
 * @param {number} [o.minIntervalMs]
 */
export function makeTsdrClient({ apiKey, fetchImpl = globalThis.fetch, sleep = sleepReal, now = () => Date.now(), minIntervalMs = TSDR_MIN_INTERVAL_MS, maxRetries = TSDR_MAX_RETRIES } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  let nextAt = 0;
  const log = { requests: 0, waits: [], retries: 0 };

  async function throttle() {
    const t = now();
    if (t < nextAt) { log.waits.push(nextAt - t); await sleep(nextAt - t); }
    nextAt = Math.max(now(), nextAt) + minIntervalMs;
  }

  /** One caseMultiStatus request for up to TSDR_BATCH serials. */
  async function fetchBatch(serials) {
    const url = `${TSDR_HOST}${TSDR_MULTI_PATH}?ids=${serials.join(',')}`;
    for (let attempt = 0; ; attempt++) {
      await throttle();
      log.requests++;
      let res;
      try {
        res = await fetchImpl(url, { method: 'GET', headers: { [TSDR_KEY_HEADER]: key, accept: 'application/json' } });
      } catch (err) {
        return { ok: false, code: 'network', transient: true, message: `TSDR could not be reached (${String(err?.message ?? err).slice(0, 120)}).` };
      }
      if (res.status === 429) {
        if (attempt >= maxRetries) {
          return { ok: false, code: 'rate_limited', transient: true, message: `TSDR kept answering 429 (rate limited) after ${maxRetries} retries; try again in a minute.` };
        }
        const ra = Number(res.headers?.get?.('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : minIntervalMs * 2 ** attempt;
        log.retries++; log.waits.push(wait);
        await sleep(wait);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, code: 'unauthorized', transient: false, message: `TSDR refused the API key (HTTP ${res.status}). Check USPTO_TSDR_API_KEY.` };
      }
      if (res.status === 204 || res.status === 404) return { ok: true, map: new Map() };
      if (!res.ok) {
        return { ok: false, code: 'http', transient: res.status >= 500, message: `TSDR answered HTTP ${res.status}.` };
      }
      let body;
      try { body = await res.json(); } catch {
        return { ok: false, code: 'bad_response', transient: false, message: 'TSDR answered, but not with readable JSON.' };
      }
      return { ok: true, map: parseMultiStatus(body) };
    }
  }

  const cache = new Map();
  return {
    configured: Boolean(key),
    log,
    /** Prefetch a batch, so status() for each serial is one request in all. */
    async prefetch(serials) {
      if (!key) return;
      const todo = [...new Set(serials.map((s) => String(s).replace(/\D/g, '')))].filter((s) => s && !cache.has(s));
      for (let i = 0; i < todo.length; i += TSDR_BATCH) {
        const chunk = todo.slice(i, i + TSDR_BATCH);
        const r = await fetchBatch(chunk);
        for (const s of chunk) {
          if (!r.ok) cache.set(s, r);
          else if (r.map.has(s)) cache.set(s, { ok: true, record: r.map.get(s) });
          else cache.set(s, { ok: false, code: 'not_found', transient: false, message: `TSDR returned no record for serial ${s}.` });
        }
      }
    },
    /** @returns {Promise<{ok:true, record:object}|{ok:false, code:string, transient:boolean, message:string}>} */
    async status(serial) {
      if (!key) return { ok: false, code: 'not_configured', transient: false, message: TSDR_NOT_CONFIGURED };
      const s = String(serial).replace(/\D/g, '');
      if (!cache.has(s)) await this.prefetch([s]);
      return cache.get(s);
    },
  };
}
