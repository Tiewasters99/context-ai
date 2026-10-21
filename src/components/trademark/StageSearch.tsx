// Stage 4 — Register search (the reviewer runs each query on tmsearch).
// For each query: the string with a Copy button, the USPTO link, and Record
// run: the reported count, then rows keyed or pasted one per line
// (serial | mark | owner | status | classes | goods), or an export file.
// The captured count and any gap show at once; the database computes them
// again when the run is stored.

import { useMemo, useState } from 'react';
import { fileExport, recordRun, type ClearanceBundle, type TmQuery } from '@/lib/trademark/data';
import { parseManualRows, readExportFile, type ParsedRow } from '../../../lib/trademark/parse.mjs';
import { latestRuns, selfTestState, summarizeRun, SELF_TEST_FAILED_WARNING } from '../../../lib/trademark/triage.mjs';
import { TMSEARCH_URL } from '../../../lib/trademark/queries.mjs';
import { btn, btnPrimary, copyText, day, field, label, mono } from './styles';
import { ErrorLine, Note, Panel } from './ui';
import SignOff from './SignOff';

function RunForm({ b, q, onDone }: { b: ClearanceBundle; q: TmQuery; onDone: () => Promise<void> }) {
  const [reported, setReported] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileRows, setFileRows] = useState<ParsedRow[] | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const manual = useMemo(() => parseManualRows(text), [text]);
  const rows = fileRows ?? manual.rows;
  const rep = reported.trim() === '' ? null : Number(reported);
  const preview = summarizeRun({ source: fileRows ? 'export' : 'manual', reported_count: Number.isFinite(rep) ? rep : null, rows });

  const pick = async (f: File | null) => {
    setFile(f); setFileRows(null); setFileNote(null); setError(null);
    if (!f) return;
    try {
      const out = await readExportFile(new Uint8Array(await f.arrayBuffer()), f.name);
      setFileRows(out.rows);
      const p = out.preamble;
      const range = p.from != null && p.to != null ? ` Export says results ${p.from} to ${p.to}; the reported count is still the number tmsearch showed.` : '';
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const mismatch = p.searchTerm && norm(p.searchTerm) !== norm(q.query)
        ? ` WARNING: the file's search term is "${p.searchTerm}", not this query.`
        : '';
      setFileNote(`${out.rows.length} rows read${out.errors.length ? `, ${out.errors.length} without a serial skipped` : ''}${out.unknownHeaders.length ? `; kept as-is: ${out.unknownHeaders.join(', ')}` : ''}.${range}${mismatch}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async (failed = false) => {
    setBusy(true); setError(null);
    try {
      if (!failed && (rep == null || !Number.isInteger(rep) || rep < 0)) throw new Error('Enter the result count tmsearch reported (0 or more).');
      let exportDocumentId: string | null = null;
      if (!failed && file && fileRows) exportDocumentId = await fileExport(b.clearance.matterspace_id, file);
      await recordRun(b, q, {
        source: failed ? 'failed' : fileRows ? 'export' : 'manual',
        reported: failed ? null : rep,
        rows: failed ? [] : rows,
        exportDocumentId,
      });
      setReported(''); setText(''); setFile(null); setFileRows(null); setFileNote(null);
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded border border-white/10 px-3 py-3 space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div><span className={label}>Reported count</span><input className={`${field} w-[110px]`} inputMode="numeric" value={reported} onChange={(e) => setReported(e.target.value.replace(/[^\d]/g, ''))} /></div>
        <div className="min-w-0"><span className={label}>Or an export (CSV / XLSX)</span>
          <input type="file" accept=".csv,.xlsx,.xls" className="text-[12px] text-white/75 max-w-full" onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
        </div>
      </div>
      {!fileRows && (
        <textarea className={`${field} ${mono} min-h-[80px]`} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="serial | mark | owner | status | classes | goods/services   (one record per line)" />
      )}
      {fileNote && <Note>{fileNote}</Note>}
      {manual.errors.length > 0 && !fileRows && (
        <p className="text-[12px] text-[#f8a1a1]">Line {manual.errors.map((e) => e.line).join(', ')}: no serial number (6 to 9 digits) at the start.</p>
      )}
      <p className="text-[12px] text-white/75">
        Captured {preview.captured}{rep != null ? ` of ${rep} reported` : ''}.{' '}
        {preview.gap ? <span className="text-[#e8b84a]">Gap: {preview.gapNote}.</span> : <span className="text-[#86e0a8]">No gap.</span>}
      </p>
      <div className="flex flex-wrap gap-2">
        <button className={btnPrimary} disabled={busy} onClick={() => void save(false)}>{busy ? 'Recording…' : 'Record run'}</button>
        <button className={btn} disabled={busy} onClick={() => void save(true)}>Mark as failed</button>
      </div>
      <ErrorLine text={error} />
    </div>
  );
}

export default function StageSearch({ b, initials, setInitials, onChanged }: {
  b: ClearanceBundle; initials: string; setInitials: (v: string) => void; onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const latest = useMemo(() => latestRuns(b.runs), [b.runs]);
  const st = selfTestState(b.queries, b.runs);
  const runCount = (id: string) => b.runs.filter((r) => r.query_id === id).length;

  return (
    <Panel id="tm-stage-4" title="4. Register search">
      <Note>
        Run each query on the USPTO search page and record what it showed. Record the self-test (Q0) first: until it has
        returned exactly one record, a run with no results cannot be relied on.{' '}
        <a className="text-[#e8b84a] hover:underline" href={TMSEARCH_URL} target="_blank" rel="noreferrer">USPTO trademark search</a>
      </Note>
      {st === 'failed' && <p className="mt-2 rounded border border-[#f87171]/40 px-3 py-2 text-[12.5px] text-[#f8a1a1]">Warning: {SELF_TEST_FAILED_WARNING}.</p>}
      {b.queries.length === 0 && <p className="mt-2 text-[12.5px] text-white/60">Generate the queries in stage 3 first.</p>}
      <ul className="mt-3 divide-y divide-white/5">
        {b.queries.map((q) => {
          const r = latest.get(q.id);
          return (
            <li key={q.id} className="py-2">
              <div className="flex flex-wrap items-start gap-2">
                <span className="text-[12.5px] text-white/60 w-10 shrink-0">Q{q.seq}</span>
                <span className={`${mono} text-white/90 break-all flex-1 min-w-[200px]`}>{q.query}</span>
                <button className={btn} onClick={() => void copyText(q.query).then((ok) => { if (ok) { setCopied(q.id); setTimeout(() => setCopied(null), 1500); } })}>
                  {copied === q.id ? 'Copied' : 'Copy'}
                </button>
                <button className={btn} onClick={() => setOpen(open === q.id ? null : q.id)}>{open === q.id ? 'Close' : r ? 'Record a re-run' : 'Record run'}</button>
              </div>
              <p className="mt-1 pl-12 text-[12px] text-white/60">
                {r ? (
                  <>
                    {day(r.run_at)} · {r.source} · reported {r.reported_count ?? '—'} · captured {r.captured_count}
                    {r.gap ? <span className="text-[#e8b84a]"> · gap{r.gap_note ? `: ${r.gap_note}` : ''}</span> : ' · no gap'}
                    {runCount(q.id) > 1 ? ` · ${runCount(q.id)} runs (the latest is current)` : ''}
                    {st === 'failed' && q.purpose !== 'selftest' ? <span className="text-[#f8a1a1]"> · {SELF_TEST_FAILED_WARNING}</span> : ''}
                  </>
                ) : 'Not run.'}
              </p>
              {open === q.id && <RunForm b={b} q={q} onDone={async () => { setOpen(null); await onChanged(); }} />}
            </li>
          );
        })}
      </ul>
      <SignOff b={b} stage={4} initials={initials} setInitials={setInitials} onChanged={onChanged}
        blocked={st === 'not_run' ? 'Record the self-test (Q0) first.' : null} />
    </Panel>
  );
}
