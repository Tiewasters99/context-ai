// lib/trademark/deepcheck.mjs — stage 6, the TSDR deep check (spec §8 slice 2;
// build brief 2026-10-21 §B).
//
// For each hit triage proposed to flag, or the reviewer flagged, or the
// reviewer asked about (tm_hits.deep_check), fetch the official status and
// prosecution history from the USPTO TSDR API (lib/trademark/tsdr.mjs), store
// it on the hit (tm_hits.tsdr), and file the status record as a document in
// the matter, one per hit. A dead record is NOTED, never dropped: its bin and
// its place in the report are untouched.
//
// No key on the server = the stage says so plainly and fetches nothing; the
// reviewer may skip stage 6. Nothing here ever invents a status: a record
// TSDR did not return is reported as not fetched, with the reason.
//
// Server side only (the key never reaches a browser). Used by
// api/trademark.mjs (the browser's door) and lib/trademark/connector.mjs
// (tm_deep_check), each with its own fileDocument and Record actor.

import { cell } from './report.mjs';
import { TSDR_NOT_CONFIGURED, TSDR_SOURCE_NOTE, publicStatusUrl } from './tsdr.mjs';
import { isSlice2Missing, SLICE2_NOT_READY_MESSAGE, TrademarkActionError } from './actions.mjs';

/** Hits checked per request, so one request ends inside the function's time. */
export const MAX_PER_REQUEST = 10;

/** Which hits stage 6 checks: flagged by the reviewer, or proposed flag and not yet decided, or asked for. */
export function deepCheckTargets(hits) {
  return (hits ?? []).filter((h) => h.bin === 'flag' || (!h.bin && h.proposed?.bin === 'flag') || h.deep_check === true)
    .sort((a, b) => String(a.serial).localeCompare(String(b.serial)));
}

const dash = (v) => (v == null || v === '' ? '—' : v);

export function statusRecordFilename(mark, serial, date) {
  const safe = String(mark ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'MARK';
  return `TSDR status — ${serial} — ${safe} — ${date}.md`;
}

/** The status record as filed: what TSDR returned, nothing added. */
export function statusRecordMarkdown({ clearance, hit, tsdr, date }) {
  const t = tsdr;
  const out = [];
  out.push(`# TSDR status — SN ${hit.serial} — ${t.mark || hit.mark || ''}`.trim(), '');
  out.push(`Fetched ${t.fetched_at ? String(t.fetched_at).slice(0, 19).replace('T', ' ') + ' UTC' : date} from the USPTO TSDR API ` +
    `for the clearance of ${clearance.mark}. ${TSDR_SOURCE_NOTE} The official record: ${publicStatusUrl(hit.serial)}`, '');
  const rows = [
    ['Serial number', hit.serial],
    ['Mark', dash(t.mark)],
    ['Status', [t.status_code, t.status_text].filter(Boolean).join(' — ') || '—'],
    ['Status date', dash(t.status_date)],
    ['Live / dead', t.live === true ? 'Live' : t.live === false ? 'Dead (noted in the clearance; not dropped)' : 'Not stated'],
    ['Filing date', dash(t.filing_date)],
    ['Registration', [t.registration_number, t.registration_date].filter(Boolean).join(', ') || '—'],
    ['Owner', dash(t.owner)],
    ['Classes', (t.classes ?? []).join(' ') || '—'],
  ];
  out.push('| Field | Value |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`), '');
  if (t.goods_services?.length) {
    out.push('## Goods and services', '');
    out.push(...t.goods_services.map((g) => `- Class ${g.class || '?'}: ${cell(g.text)}`), '');
  }
  out.push('## Prosecution history', '');
  if (t.events?.length) {
    out.push('| Date | Code | Event |', '| --- | --- | --- |', ...t.events.map((e) => `| ${cell(e.date)} | ${cell(e.code)} | ${cell(e.description)} |`), '');
  } else {
    out.push('_TSDR returned no prosecution history entries._', '');
  }
  return out.join('\n');
}

/**
 * Run stage 6 over a clearance's targets.
 * @param {object} o
 * @param {object} o.sb            the caller's user-scoped client (RLS)
 * @param {object} o.bundle        {clearance, hits, stages}
 * @param {{configured:boolean, status:(serial:string)=>Promise<object>}} o.client   lib/trademark/tsdr.mjs makeTsdrClient()
 * @param {(args:object)=>Promise<{document_id?:string}>} [o.fileDocument]  files one document in the matter
 * @param {Function} [o.record]    lib/ledger.mjs record()
 * @param {object} o.actor         the Record's byline
 * @param {boolean} [o.force]      re-fetch hits already checked
 * @param {number} [o.max]
 * @param {() => string} [o.now]
 */
export async function runDeepCheck({ sb, bundle, client, fileDocument, record, actor, force = false, max = MAX_PER_REQUEST, now = () => new Date().toISOString() }) {
  const c = bundle.clearance;
  const targets = deepCheckTargets(bundle.hits);
  const via = actor?.kind === 'connector' ? { via: 'connector' } : {};
  const rec = async (kind, payload) => {
    if (typeof record !== 'function') return;
    try { await record(sb, { kind, matterId: c.matterspace_id, actor, payload: { clearance_id: c.id, ...payload, ...via } }); } catch { /* never blocks */ }
  };

  if (!client?.configured) {
    await rec('tm.deep_check.run', { checked: 0, live: 0, dead: 0, failed: 0, filed: 0, configured: false });
    return { configured: false, message: TSDR_NOT_CONFIGURED, targets: targets.length, checked: 0, remaining: targets.length, results: [] };
  }
  if (!targets.length) {
    return { configured: true, message: 'No record is flagged (by triage or by the reviewer), so there is nothing to check.', targets: 0, checked: 0, remaining: 0, results: [] };
  }

  const todo = targets.filter((h) => force || !h.tsdr_checked_at);
  const batch = todo.slice(0, Math.max(1, max));
  const results = [];
  let stoppedFor = null;
  // One caseMultiStatus request for the whole batch (lib/trademark/tsdr.mjs).
  if (typeof client.prefetch === 'function') await client.prefetch(batch.map((h) => h.serial));
  for (const h of batch) {
    const r = await client.status(h.serial);
    if (!r.ok) {
      results.push({ serial: h.serial, ok: false, reason: r.message, code: r.code });
      if (r.code === 'rate_limited' || r.code === 'unauthorized' || r.code === 'not_configured') { stoppedFor = r.code; break; }
      if (!r.transient) {
        // A definite answer (no such serial, a malformed record): kept on the hit
        // as "not fetched, because …", so the next call does not ask again.
        await sb.from('tm_hits').update({ tsdr: { error: r.message, code: r.code, fetched_at: now() }, tsdr_checked_at: now() })
          .eq('clearance_id', c.id).eq('serial', h.serial);
      }
      continue;
    }
    const tsdr = { ...r.record, fetched_at: now() };
    const { data: upd, error } = await sb.from('tm_hits')
      .update({ tsdr, tsdr_checked_at: tsdr.fetched_at })
      .eq('clearance_id', c.id).eq('serial', h.serial).select('id');
    if (error) {
      if (isSlice2Missing(error)) throw new TrademarkActionError(SLICE2_NOT_READY_MESSAGE, 503, 'not_ready');
      results.push({ serial: h.serial, ok: false, reason: `the status was fetched but not stored: ${error.message}`, code: 'write_failed' });
      continue;
    }
    if (!upd?.length) { results.push({ serial: h.serial, ok: false, reason: 'the status was fetched but the hit could not be updated', code: 'write_failed' }); continue; }

    let documentId = null;
    let fileNote = null;
    if (typeof fileDocument === 'function') {
      const date = tsdr.fetched_at.slice(0, 10);
      try {
        const out = await fileDocument({
          matter: c.matterspace_id,
          filename: statusRecordFilename(c.mark, h.serial, date),
          title: `TSDR status — ${h.serial} — ${tsdr.mark || h.mark || ''} — ${date}`,
          content: statusRecordMarkdown({ clearance: c, hit: h, tsdr, date }),
          encoding: 'utf8',
          doc_type: 'other',
        });
        documentId = out?.document_id ?? null;
        if (documentId) await sb.from('tm_hits').update({ tsdr_document_id: documentId }).eq('clearance_id', c.id).eq('serial', h.serial);
      } catch (err) {
        fileNote = `the status is stored on the hit, but the record could not be filed: ${err?.message ?? err}`;
      }
    }
    await rec('tm.hit.status', { serial: h.serial, live: tsdr.live, status_code: tsdr.status_code ?? null, document_id: documentId });
    results.push({
      serial: h.serial, ok: true, live: tsdr.live, status_code: tsdr.status_code ?? null, status_text: tsdr.status_text ?? null,
      registration_number: tsdr.registration_number ?? null, owner: tsdr.owner ?? null, document_id: documentId, ...(fileNote ? { note: fileNote } : {}),
    });
  }
  const ok = results.filter((r) => r.ok);
  const summary = {
    checked: ok.length, live: ok.filter((r) => r.live === true).length, dead: ok.filter((r) => r.live === false).length,
    failed: results.length - ok.length, filed: ok.filter((r) => r.document_id).length, configured: true,
  };
  await rec('tm.deep_check.run', summary);
  // What a later call would still fetch: not yet asked, plus any transient failure.
  const settled = results.filter((r) => r.ok || !['rate_limited', 'unauthorized', 'not_configured', 'http', 'network'].includes(r.code)).length;
  const remaining = Math.max(0, todo.length - settled);
  return {
    configured: true, targets: targets.length, ...summary, remaining,
    ...(stoppedFor ? { stopped: stoppedFor, message: results.find((r) => r.code === stoppedFor)?.reason } : {}),
    results,
  };
}
