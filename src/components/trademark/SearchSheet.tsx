// The combined search sheet (slice 2): every query not yet run, for every
// confirmed mark in this matter, in one list — the query line with Copy, the
// USPTO search page, and a slot to paste what tmsearch showed (or upload its
// export). The USPTO search is run by the person; this code never fetches
// tmsearch. When a mark's last query is recorded, triage is proposed on its
// own (TrademarkTab), and the report preview assembles on its own (stage 8).

import { useMemo, useState } from 'react';
import type { ClearanceBundle, TmQuery } from '@/lib/trademark/data';
import { latestRuns, selfTestState, SELF_TEST_FAILED_WARNING } from '../../../lib/trademark/triage.mjs';
import { TMSEARCH_URL } from '../../../lib/trademark/queries.mjs';
import { btn, copyText, mono } from './styles';
import { Note } from './ui';
import { RunForm } from './StageSearch';

function Row({ b, q, onDone }: { b: ClearanceBundle; q: TmQuery; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-start gap-2">
        <span className="text-[12px] text-white/55 w-10 shrink-0">Q{q.seq}</span>
        <span className={`${mono} text-white/90 break-all flex-1 min-w-[180px]`}>{q.query}</span>
        <button className={btn} onClick={() => void copyText(q.query).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } })}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className={btn} onClick={() => setOpen(!open)}>{open ? 'Close' : 'Paste results'}</button>
      </div>
      {q.purpose === 'selftest' && <p className="pl-12 text-[11.5px] text-white/50">The self-test: it must return exactly one record. Record it first.</p>}
      {open && <RunForm b={b} q={q} onDone={async () => { setOpen(false); await onDone(); }} />}
    </li>
  );
}

export default function SearchSheet({ bundles, onChanged }: { bundles: ClearanceBundle[]; onChanged: () => Promise<void> }) {
  const groups = useMemo(() => bundles.map((b) => {
    const latest = latestRuns(b.runs);
    const unrun = [...b.queries].sort((x, y) => x.seq - y.seq).filter((q) => !latest.has(q.id));
    return { b, unrun, st: selfTestState(b.queries, b.runs) };
  }).filter((g) => g.b.queries.length > 0 && g.unrun.length > 0), [bundles]);
  if (!groups.length) return null;
  const total = groups.reduce((n, g) => n + g.unrun.length, 0);
  return (
    <section className="mt-4 rounded-lg border border-white/10 bg-[rgba(255,255,255,0.02)] px-4 py-4" aria-label="Search sheet">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-medium text-[var(--color-text-bright)]">Search sheet: {total} quer{total === 1 ? 'y' : 'ies'} to run</h3>
        <a className="text-[12.5px] text-[#e8b84a] hover:underline" href={TMSEARCH_URL} target="_blank" rel="noreferrer">Open the USPTO search page</a>
      </div>
      <Note>
        For each line: copy it, paste it into the USPTO search, run it, then paste what it showed (the result count and the
        records) or upload its export. Triage is proposed for a mark as soon as its last query is recorded.
      </Note>
      {groups.map(({ b, unrun, st }) => (
        <div key={b.clearance.id} className="mt-3">
          <h4 className="text-[13px] font-semibold text-white/85">{b.clearance.mark} <span className="text-[11.5px] font-normal text-white/50">{unrun.length} to run</span></h4>
          {st === 'failed' && <p className="text-[12px] text-[#f8a1a1]">Warning: {SELF_TEST_FAILED_WARNING}.</p>}
          <ul className="divide-y divide-white/5">{unrun.map((q) => <Row key={q.id} b={b} q={q} onDone={onChanged} />)}</ul>
        </div>
      ))}
    </section>
  );
}
