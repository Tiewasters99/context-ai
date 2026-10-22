// Stage 4's choice of where the queries run (2026-10-21):
//   "Search Equazia's copy of the register (as of <date>)"  or
//   "I'll run them on tmsearch".
// The copy is the default only after its recall test has passed; until then
// its results are "preliminary: confirm on tmsearch" and cannot by
// themselves complete stage 4 (migration 123 refuses the sign-off too).
// tmsearch always stays available as the cross-check. When the server has
// no copy (TM_REGISTER_DB_URL unset), or it is out of date, the first option
// says so and cannot be chosen; everything else on the stage is unchanged.

import { useEffect, useId, useMemo, useState } from 'react';
import {
  registerStatus, runRegisterSearch, preliminaryQueries, PRELIMINARY_LABEL,
  type ClearanceBundle, type RegisterStatus,
} from '@/lib/trademark/data';
import { latestRuns } from '../../../lib/trademark/triage.mjs';
import { TMSEARCH_URL } from '../../../lib/trademark/queries.mjs';
import { btnPrimary } from './styles';
import { ErrorLine, Note } from './ui';

const SCOPE = 'Federal register only; no design-mark image comparison; no state or common-law marks; one or two days behind the register.';

function useRegisterStatus(): RegisterStatus | null {
  const [st, setSt] = useState<RegisterStatus | null>(null);
  useEffect(() => { let live = true; void registerStatus().then((s) => { if (live) setSt(s); }); return () => { live = false; }; }, []);
  return st;
}

export default function RegisterChoice({ bundles, onChanged }: { bundles: ClearanceBundle[]; onChanged: () => Promise<void> }) {
  const st = useRegisterStatus();
  const [choice, setChoice] = useState<'copy' | 'tmsearch' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const group = useId();

  const unrun = useMemo(() => bundles.map((b) => {
    const latest = latestRuns(b.runs);
    return { b, ids: b.queries.filter((q) => !latest.has(q.id)).map((q) => q.id) };
  }).filter((x) => x.ids.length), [bundles]);
  const total = unrun.reduce((n, x) => n + x.ids.length, 0);
  const prelim = bundles.flatMap((b) => preliminaryQueries(b).map((q) => `${bundles.length > 1 ? `${b.clearance.mark} ` : ''}Q${q.seq}`));

  if (!st) return null;
  const effective = choice ?? (st.offered && st.default ? 'copy' : 'tmsearch');

  const run = async () => {
    setBusy(true); setError(null); setNotes([]);
    try {
      const out: string[] = [];
      for (const x of unrun) {
        const r = await runRegisterSearch(x.b.clearance.id);
        const head = bundles.length > 1 ? `${x.b.clearance.mark}: ` : '';
        out.push(`${head}${r.runs.length} quer${r.runs.length === 1 ? 'y' : 'ies'} run on the copy.`);
        if (r.not_run.length) out.push(`${head}${r.not_run.map((n) => `${n.label} (${n.reason})`).join('; ')}: run on tmsearch.`);
        if (r.out_of_time.length) out.push(`${head}${r.out_of_time.join(', ')} did not fit in one call: press the button again.`);
      }
      setNotes(out);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const radio = 'mt-0.5 accent-[#e8b84a]';
  return (
    <div className="mt-3 rounded border border-white/10 px-3 py-3" role="group" aria-label="Where the queries run">
      <p className="text-[12.5px] font-medium text-white/85">Where to run the queries</p>
      <label className={`mt-2 flex items-start gap-2 text-[12.5px] ${st.offered ? 'text-white/85' : 'text-white/45'}`}>
        <input type="radio" name={group} className={radio} disabled={!st.offered}
          checked={effective === 'copy'} onChange={() => setChoice('copy')} />
        <span className="min-w-0">
          {st.offered ? `Search Equazia's copy of the register (as of ${st.as_of})` : 'Search Equazia\'s copy of the register: not available'}
          <span className="block text-[11.5px] text-white/55">
            {st.offered ? (st.gate_passed ? SCOPE : `Results are ${PRELIMINARY_LABEL}${st.gate ? ` (${st.gate})` : ''}. ${SCOPE}`) : (st.message ?? '')}
          </span>
        </span>
      </label>
      <label className="mt-2 flex items-start gap-2 text-[12.5px] text-white/85">
        <input type="radio" name={group} className={radio} checked={effective === 'tmsearch'} onChange={() => setChoice('tmsearch')} />
        <span className="min-w-0">I&apos;ll run them on tmsearch
          <span className="block text-[11.5px] text-white/55">
            The official USPTO search (<a className="text-[#e8b84a] hover:underline" href={TMSEARCH_URL} target="_blank" rel="noreferrer">open it</a>).
            {st.offered ? ' It stays available as the cross-check.' : ''}
          </span>
        </span>
      </label>
      {effective === 'copy' && st.offered && (
        <div className="mt-3 space-y-2">
          {total > 0
            ? <button className={btnPrimary} disabled={busy} onClick={() => void run()}>{busy ? 'Running on the copy…' : `Run ${total} quer${total === 1 ? 'y' : 'ies'} on the copy`}</button>
            : <Note>Every query has a run.</Note>}
          {!st.gate_passed && <Note>Until the copy&apos;s recall test passes, stage 4 cannot be signed on its results alone: run those queries on tmsearch too and record what it shows.</Note>}
        </div>
      )}
      {prelim.length > 0 && (
        <p className="mt-2 text-[12px] text-[#e8b84a]">{prelim.join(', ')}: {PRELIMINARY_LABEL}.</p>
      )}
      {notes.map((n) => <p key={n} className="mt-1 text-[12px] text-white/70">{n}</p>)}
      <ErrorLine text={error} />
    </div>
  );
}
