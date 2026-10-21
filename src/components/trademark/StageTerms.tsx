// Stage 3 — Search terms. Step A: the decomposition (a judgment; the model
// may propose, the reviewer confirms). Step B: deterministic generation of
// the query list. After Q7 has been run, the Q8 exclusions are proposed from
// its captured marks and checked against the known marks and every flagged
// or noted hit before the reviewer confirms them.

import { useMemo, useState } from 'react';
import {
  addManualQuery, generateAndStore, saveDecomposition, trademarkApi, type ClearanceBundle, type TmDecomposition,
} from '@/lib/trademark/data';
import { decompositionProblems, TMSEARCH_URL } from '../../../lib/trademark/queries.mjs';
import { exclusionCheck, latestRuns, proposeExclusions } from '../../../lib/trademark/triage.mjs';
import { btn, btnPrimary, copyText, field, label, mono, td, th } from './styles';
import { ErrorLine, Note, Panel, Scroll } from './ui';
import SignOff from './SignOff';

export function QueryTable({ b }: { b: ClearanceBundle }) {
  const [copied, setCopied] = useState<string | null>(null);
  const latest = useMemo(() => latestRuns(b.runs), [b.runs]);
  const copy = async (key: string, text: string) => { if (await copyText(text)) { setCopied(key); setTimeout(() => setCopied(null), 1500); } };
  const all = b.queries.map((q) => `Q${q.seq}  ${q.query}`).join('\n');
  if (!b.queries.length) return <Note>No queries yet.</Note>;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <button className={btn} onClick={() => void copy('all', all)}>{copied === 'all' ? 'Copied' : 'Copy all'}</button>
        <a className="text-[12.5px] text-[#e8b84a] hover:underline" href={TMSEARCH_URL} target="_blank" rel="noreferrer">Open the USPTO search page</a>
      </div>
      <Scroll>
        <table className="w-full min-w-[640px] border-collapse">
          <thead><tr className="border-b border-white/10"><th className={th}>Q</th><th className={th}>Purpose</th><th className={th}>Query</th><th className={th}>Filters</th><th className={th}>Runs</th><th className={th} /></tr></thead>
          <tbody>
            {b.queries.map((q) => (
              <tr key={q.id} className="border-b border-white/5">
                <td className={td}>Q{q.seq}</td>
                <td className={td}>{q.purpose}</td>
                <td className={`${td} ${mono} break-all`}>{q.query}</td>
                <td className={td}>{[q.live_only ? 'live' : null, q.class_filter.length ? q.class_filter.join(' ') : null].filter(Boolean).join(' · ') || '—'}</td>
                <td className={td}>{latest.has(q.id) ? 'run' : '—'}</td>
                <td className={td}><button className={btn} onClick={() => void copy(q.id, q.query)}>{copied === q.id ? 'Copied' : 'Copy'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
    </>
  );
}

export default function StageTerms({ b, initials, setInitials, onChanged }: {
  b: ClearanceBundle; initials: string; setInitials: (v: string) => void; onChanged: () => Promise<void>;
}) {
  const c = b.clearance;
  const d0 = c.decomposition;
  const [opening, setOpening] = useState(d0?.opening ?? '');
  const [hinge, setHinge] = useState(d0?.hinge ?? '');
  const [ending, setEnding] = useState(d0?.ending ?? '');
  const [reason, setReason] = useState(d0?.reason ?? '');
  const [foreignFound, setForeignFound] = useState(d0?.foreign ?? []);
  const [model, setModel] = useState<string | undefined>(d0?.model);
  const [foreign, setForeign] = useState((c.foreign_equivalents ?? []).join(', '));
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const draft: TmDecomposition = { opening: opening.trim().toLowerCase(), hinge: hinge.trim().toLowerCase(), ending: ending.trim().toLowerCase(), reason, foreign: foreignFound, model, exclusions: d0?.exclusions };
  const problems = decompositionProblems(c.mark, draft);

  // Q8: proposed from Q7's captured marks, once Q7 has been run.
  const q7 = b.queries.find((q) => q.purpose === 'prefix');
  const q7run = q7 ? latestRuns(b.runs).get(q7.id) : undefined;
  const proposal = useMemo(() => (q7run && d0 ? proposeExclusions((q7run.raw ?? []).map((r) => r.mark ?? ''), d0.opening) : null), [q7run, d0]);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const excl = useMemo(() => chosen ?? d0?.exclusions ?? proposal?.proposed.map((p) => p.stem) ?? [], [chosen, d0, proposal]);
  const check = useMemo(() => exclusionCheck({ exclusions: excl, knownMarks: c.known_marks ?? [], hits: b.hits }), [excl, c.known_marks, b.hits]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  const propose = () => run('propose', async () => {
    const { proposal: p } = await trademarkApi<{ proposal: TmDecomposition & { model: string } }>('decompose', { clearance_id: c.id });
    setOpening(p.opening); setHinge(p.hinge); setEnding(p.ending); setReason(p.reason ?? ''); setForeignFound(p.foreign ?? []); setModel(p.model);
  });
  const save = () => run('save', async () => {
    if (problems.length) throw new Error(problems.join(' '));
    await saveDecomposition(c, draft, foreign.split(/[,\n]+/));
    await onChanged();
  });
  const generate = () => run('generate', async () => {
    const out = await generateAndStore(b, { rescued: check.rescue });
    setWarnings(out.warnings);
    await onChanged();
  });
  const confirmExclusions = () => run('excl', async () => {
    if (!d0) throw new Error('Save the decomposition first.');
    await saveDecomposition(c, { ...d0, exclusions: excl }, c.foreign_equivalents ?? []);
    await onChanged();
  });
  const addQuery = () => run('manual', async () => { await addManualQuery(b, manual); setManual(''); await onChanged(); });

  return (
    <Panel id="tm-stage-3" title="3. Search terms">
      <h4 className="mb-2 text-[12px] font-semibold text-white/80">A. Decomposition</h4>
      <Note>
        Lower case. Opening + hinge + ending must spell the mark without spaces (or, for a mark of several words, the word
        searched). The hinge is the sound a respelling would change: EQUAZIA is equa | z | ia.
      </Note>
      <div className="mt-2 grid gap-2 grid-cols-3">
        <div><span className={label}>Opening</span><input className={field} value={opening} onChange={(e) => setOpening(e.target.value)} /></div>
        <div><span className={label}>Hinge</span><input className={field} value={hinge} onChange={(e) => setHinge(e.target.value)} /></div>
        <div><span className={label}>Ending</span><input className={field} value={ending} onChange={(e) => setEnding(e.target.value)} /></div>
      </div>
      <div className="mt-2"><span className={label}>Reason</span><input className={field} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      {model && <p className="mt-2 text-[12px] text-[#e8b84a]">Proposed by {model}. Confirm or edit, then save.</p>}
      {foreignFound.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {foreignFound.map((f, i) => <li key={i} className="text-[12px] text-white/75">Resembles {f.language} <em>{f.word}</em> ({f.meaning})</li>)}
        </ul>
      )}
      <div className="mt-2"><span className={label}>Foreign equivalents to search (comma-separated)</span>
        <input className={field} value={foreign} onChange={(e) => setForeign(e.target.value)} placeholder="equazione, equacion" />
      </div>
      {problems.length > 0 && (opening || ending) && <p className="mt-2 text-[12px] text-[#f8a1a1]">{problems.join(' ')}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={btn} disabled={busy !== null} onClick={() => void propose()}>{busy === 'propose' ? 'Asking…' : 'Propose decomposition'}</button>
        <button className={btnPrimary} disabled={busy !== null || problems.length > 0} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save decomposition'}</button>
      </div>

      <h4 className="mt-5 mb-2 text-[12px] font-semibold text-white/80">B. Queries</h4>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <button className={btnPrimary} disabled={busy !== null || !d0} onClick={() => void generate()}>
          {busy === 'generate' ? 'Generating…' : b.queries.length ? 'Regenerate queries' : 'Generate queries'}
        </button>
        <Note>Regeneration replaces only queries that have not been run; run queries stay with their results.</Note>
      </div>
      {warnings.map((w) => <p key={w} className="text-[12px] text-[var(--color-text-muted)]">{w}</p>)}
      <QueryTable b={b} />
      <div className="mt-3 flex gap-2">
        <input className={`${field} ${mono}`} value={manual} onChange={(e) => setManual(e.target.value)} placeholder='A hand-written query, e.g. CM:equaz?a AND LD:true' />
        <button className={btn} disabled={busy !== null || !manual.trim()} onClick={() => void addQuery()}>Add</button>
      </div>

      {proposal && (
        <div className="mt-5">
          <h4 className="mb-1 text-[12px] font-semibold text-white/80">Q8 — narrowing the prefix sweep</h4>
          <Note>
            Q7 captured {q7run?.captured_count ?? 0} records ({proposal.distinctWords} distinct words beginning with “{d0?.opening}”)
            {proposal.overThreshold ? ', more than the review threshold' : ''}. Choose the exclusions; nothing is excluded until you confirm.
          </Note>
          <div className="mt-2 flex flex-wrap gap-3">
            {[...new Set([...proposal.proposed.map((p) => p.stem), ...(d0?.exclusions ?? [])])].map((stem) => (
              <label key={stem} className="flex items-center gap-1.5 text-[12.5px] text-white/85">
                <input type="checkbox" checked={excl.includes(stem)}
                  onChange={(e) => setChosen(e.target.checked ? [...excl, stem] : excl.filter((x) => x !== stem))} />
                <span className="font-mono">{stem}*</span>
              </label>
            ))}
          </div>
          {check.swallowed.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {check.swallowed.map((s, i) => (
                <li key={i} className="text-[12px] text-[#e8b84a]">
                  {s.stem}* would swallow {s.kind === 'known' ? 'the known mark' : 'the hit'} {s.name}{s.serial ? ` (${s.serial})` : ''}
                  {s.kind === 'known' ? ' — it already has its own query.' : ' — it gets its own query (rescued) when you regenerate.'}
                </li>
              ))}
            </ul>
          )}
          <button className={`${btn} mt-2`} disabled={busy !== null} onClick={() => void confirmExclusions()}>Confirm exclusions</button>
        </div>
      )}
      <ErrorLine text={error} />
      <SignOff b={b} stage={3} initials={initials} setInitials={setInitials} onChanged={onChanged}
        blocked={!d0 ? 'Save the decomposition first.' : b.queries.length === 0 ? 'Generate the queries first.' : null} />
    </Panel>
  );
}
