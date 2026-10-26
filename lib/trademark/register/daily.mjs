// lib/trademark/register/daily.mjs — the daily update of the register copy.
//
// Each morning: fetch every daily applications file from the day after the
// copy's as-of date up to yesterday, in order, load each (load.mjs), and
// stamp as_of to the LAST DAY OF THE UNBROKEN RUN that loaded. The first day
// that fails (no key, a 404, a 429, a broken file) stops the run: as_of does
// not move past it, and once as_of is older than the stale threshold the copy
// reports itself stale and the agent falls back to tmsearch.
//
// Source [V 10-21, data.uspto.gov/apis/bulk-data/download and
// /apis/api-rate-limits, read in a browser]:
//   GET https://api.uspto.gov/api/v1/datasets/products/files/{productIdentifier}/{fileName}
//   "API Key is required"; the key is sent as the X-API-KEY header (the API's
//   CORS allow-list names X-Api-Key; a request without it answers 401, with a
//   wrong one 403 — probed 2026-10-21).
//   product TRTDXFAP (Trademark Full Text XML Data, daily applications;
//   data.gov's catalog entry links https://data.uspto.gov/bulkdata/datasets/trtdxfap);
//   file name apcYYMMDD.zip (the BDSS listing, Wayback snapshot of 2025-03-07).
//   "Our files are redirected and digitally signed with a signature expiring
//   in 5 seconds": the redirect is followed at once, and WITHOUT the key
//   header (the key goes to api.uspto.gov only, never to the file host).
//   "We limit all API calls to one API call per API key" (no parallel calls)
//   and "up to 5 files per 10 seconds from the same IP": files are fetched one
//   at a time, at most one every 2.5 s.
//
// Downloads land in a directory OUTSIDE the repo (TM_REGISTER_DOWNLOAD_DIR,
// default C:\Users\equai\context-ai-scratch\uspto-bulk\daily on this machine)
// and are treated as untrusted data: parsed, never executed.

import fs from 'node:fs';
import path from 'node:path';
import { loadFile, stampAsOf } from './load.mjs';

export const ODP_KEY_ENV = 'USPTO_ODP_API_KEY';
export const ODP_FILES_URL = 'https://api.uspto.gov/api/v1/datasets/products/files';
export const DAILY_PRODUCT = 'TRTDXFAP';
export const KEY_NEEDED =
  'No USPTO Open Data Portal key (USPTO_ODP_API_KEY). The bulk download needs one: a USPTO.gov account with the ' +
  'Open Data Portal fields filled in, linked to a verified ID.me account, then "Manage API Key" at data.uspto.gov ' +
  '(data.uspto.gov/apis/getting-started). The TSDR key from account.uspto.gov/api-manager is a different key.';

const DAY = 86_400_000;
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const dailyFileName = (iso) => `apc${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}.zip`;

/** The days to fetch: from as_of + 1 to `through`, inclusive (just `through` when there is no as_of). At most `max`. */
export function daysToFetch(asOf, through, max = 31) {
  if (!through) return [];
  if (!asOf) return [through];
  const out = [];
  for (let d = addDays(asOf, 1); d <= through && out.length < max; d = addDays(d, 1)) out.push(d);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Download one daily file to `dir`. Throws a plain Error on any failure. */
export async function fetchDaily(day, { key, dir, fetchImpl = fetch, product = DAILY_PRODUCT }) {
  if (!key) throw new Error(KEY_NEEDED);
  const name = dailyFileName(day);
  const url = `${ODP_FILES_URL}/${product}/${name}`;
  let res = await fetchImpl(url, { headers: { 'X-API-KEY': key }, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc) throw new Error(`${name}: a redirect without a location`);
    res = await fetchImpl(new URL(loc, url).href, { redirect: 'follow' }); // no key header off api.uspto.gov
  }
  if (res.status === 401 || res.status === 403) throw new Error(`${name}: the Open Data Portal refused the key (HTTP ${res.status}).`);
  if (res.status === 404) throw new Error(`${name}: not published (HTTP 404).`);
  if (res.status === 429) throw new Error(`${name}: rate limited (HTTP 429).`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}.`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, file);
  return file;
}

/**
 * The daily run.
 * @param {{db:object, through?:string, key?:string|null, dir:string, fetchImpl?:Function, log?:Function, pauseMs?:number, max?:number}} o
 * @returns {Promise<{asOfBefore:string|null, asOfAfter:string|null, loaded:string[], failed:{day:string, error:string}|null, stale:boolean}>}
 */
export async function runDaily({ db, through, key = process.env[ODP_KEY_ENV] || null, dir, fetchImpl, log = () => {}, pauseMs = 2500, max = 31 }) {
  const target = through ?? addDays(new Date().toISOString().slice(0, 10), -1);
  const before = (await db.query("select value from register_meta where key = 'as_of'")).rows[0]?.value ?? null;
  const days = daysToFetch(before, target, max);
  const loaded = [];
  let failed = null;
  for (const [i, day] of days.entries()) {
    if (i > 0 && pauseMs) await sleep(pauseMs);
    try {
      const file = await fetchDaily(day, { key, dir, fetchImpl });
      await loadFile(db, file, { kind: 'daily', asOf: day, log });
      await stampAsOf(db, day);
      loaded.push(day);
    } catch (err) {
      failed = { day, error: String(err?.message ?? err) };
      log(`${day}: FAILED — ${failed.error} The copy's as-of date stays ${loaded.at(-1) ?? before ?? 'unset'}.`);
      break;
    }
  }
  const after = (await db.query("select value from register_meta where key = 'as_of'")).rows[0]?.value ?? null;
  return { asOfBefore: before, asOfAfter: after, loaded, failed, stale: Boolean(failed) || !after };
}
