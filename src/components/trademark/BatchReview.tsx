// The one review screen (slice 2): every mark in this matter whose queries are
// not generated yet, side by side — the proposed search and filing classes,
// the proposed decomposition and the queries they would produce. Accept as
// shown or edit, then ONE confirmation per mark with the reviewer's initials:
// that saves the classes and the decomposition, generates the queries and
// signs stages 1 to 3 (each sign-off its own Record row). The judgment stays
// the reviewer's; only the clicks are fewer.

import { useMemo, useState } from 'react';
import {
  confirmMark, rememberInitials, trademarkApi, type ClassEntry, type ClearanceBundle, type TmDecomposition,
} from '@/lib/trademark/data';
import { decompositionProblems, generateQueries } from '../../../lib/trademark/queries.mjs';
import { btn, btnPrimary, field, label, mono } from './styles';
import { ErrorLine, InitialsField, Note } from './ui';

interface Draft { search: string; filing: string; opening: string; hinge: string; ending: string; foreign: string }

const codesOf = (s: string) => [...new Set(s.split(/[\s,;]+/).map((x) => x.replace(/\D/g, '')).filter(Boolean).map((x) => x.padStart(3, '0').slice(-3)))];

function initialDraft(b: ClearanceBundle): Draft {
  const c = b.clearance;
  const pc = c.proposals?.classes;
  const pd = c.proposals?.decompose;
  const search = c.search_classes?.length ? c.search_classes : pc?.search ?? [];
  const filing = c.search_classes?.length ? c.filing_classes : pc?.filing ?? [];
  const d = c.decomposition ?? pd;
  return {
    search: search.map((x) => x.code).join(' '), filing: filing.map((x) => x.code).join(' '),
    opening: d?.opening ?? '', hinge: d?.hinge ?? '', ending: d?.ending ?? '',
    foreign: (c.foreign_equivalents?.length ? c.foreign_equivalents : (pd?.foreign ?? []).map((f) => f.word)).join(', '),
  };
}

/** The value a confirmation saves: reasons kept from the proposal for codes that stayed. */
function valueOf(b: ClearanceBundle, d: Draft) {
  const c = b.clearance;
  const pc = c.proposals?.classes;
  const known = new Map<string, ClassEntry>([...(pc?.search ?? []), ...(c.search_classes ?? [])].map((x) => [x.code, x]));
  const knownF = new Map<string, ClassEntry>([...(pc?.filing ?? []), ...(c.filing_classes ?? [])].map((x) => [x.code, x]));
  const search = codesOf(d.search).map((code) => known.get(code) ?? { code, reason: 'Added by the reviewer' });
  const filing = codesOf(d.filing).map((code) => knownF.get(code) ?? { code, reason: 'Added by the reviewer' });
  const pd = c.decomposition ?? c.proposals?.decompose;
  const same = pd && pd.opening === d.opening.trim().toLowerCase() && pd.hinge === d.hinge.trim().toLowerCase() && pd.ending === d.ending.trim().toLowerCase();
  const decomposition: TmDecomposition = {
    opening: d.opening.trim().toLowerCase(), hinge: d.hinge.trim().toLowerCase(), ending: d.ending.trim().toLowerCase(),
    reason: same ? pd?.reason ?? '' : 'Edited by the reviewer', foreign: pd?.foreign ?? [], ...(same && pd?.model ? { model: pd.model } : {}),
  };
  return { search, filing, decomposition, foreign: d.foreign.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean) };
}

function MarkCard({ b, initials, onDone, onOpen }: { b: ClearanceBundle; initials: string; onDone: () => Promise<void>; onOpen: (id: string) => void }) {
  const c = b.clearance;
  const [d, setD] = useState<Draft>(() => initialDraft(b));
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showQ, setShowQ] = useState(false);
  const v = valueOf(b, d);
  const problems = decompositionProblems(c.mark, v.decomposition);
  const outside = v.filing.filter((f) => !v.search.some((s) => s.code === f.code)).map((f) => f.code);
  const preview = useMemo(() => {
    if (problems.length || !v.search.length) return null;
    try {
      return generateQueries({ mark: c.mark, decomposition: v.decomposition, searchClasses: v.search.map((x) => x.code), knownMarks: c.known_marks ?? [], foreignEquivalents: v.foreign }).queries;
    } catch { return null; }
  }, [c.mark, c.known_marks, problems.length, v.decomposition, v.search, v.foreign]);
  const missing = !c.proposals?.classes || !c.proposals?.decompose;
  const proposedBy = c.proposals?.classes?.model ?? c.proposals?.decompose?.model;

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const confirm = () => act('confirm', async () => {
    if (problems.length) throw new Error(problems.join(' '));
    if (!v.search.length) throw new Error('At least one search class is needed.');
    if (outside.length) throw new Error(`Filing class ${outside.join(', ')} is not a search class.`);
    await confirmMark(c.id, v, initials);
    rememberInitials(initials);
    await onDone();
  });
  const ask = () => act('ask', async () => {
    if (!c.proposals?.classes) await trademarkApi('classes', { clearance_id: c.id, save: true });
    if (!c.proposals?.decompose) await trademarkApi('decompose', { clearance_id: c.id, save: true });
    await onDone();
  });
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });

  return (
    <li className="rounded-lg border border-white/10 px-3 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px] font-serif text-[var(--color-text-bright)]">{c.mark}</span>
        <span className="text-[11.5px] text-[#e8b84a]">{missing ? 'proposals incomplete' : `proposed${proposedBy ? ` by ${proposedBy}` : ''}`}</span>
        <button className={`${btn} ml-auto`} onClick={() => setEdit(!edit)}>{edit ? 'Done editing' : 'Edit'}</button>
      </div>
      {missing && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Note>The model's proposals did not finish for this mark. Ask again, or fill them in by hand below.</Note>
          <button className={btn} disabled={busy !== null} onClick={() => void ask()}>{busy === 'ask' ? 'Asking…' : 'Ask again'}</button>
        </div>
      )}
      {!edit ? (
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-white/55">Search classes</dt>
          <dd className="text-white/85">{v.search.length ? v.search.map((x) => <span key={x.code} className="mr-3" title={x.reason}><span className={mono}>{x.code}</span> <span className="text-white/55">{x.reason}</span></span>) : '—'}</dd>
          <dt className="text-white/55">Filing classes</dt>
          <dd className="text-white/85">{v.filing.length ? v.filing.map((x) => <span key={x.code} className="mr-3"><span className={mono}>{x.code}</span> <span className="text-white/55">{x.reason}</span></span>) : '—'}</dd>
          <dt className="text-white/55">Search terms</dt>
          <dd className="text-white/85"><span className={mono}>{v.decomposition.opening} | {v.decomposition.hinge} | {v.decomposition.ending}</span>
            {v.decomposition.reason ? <span className="text-white/55"> — {v.decomposition.reason}</span> : null}
            {v.foreign.length ? <span className="text-white/55"> · foreign: {v.foreign.join(', ')}</span> : null}</dd>
        </dl>
      ) : (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div><span className={label}>Search classes</span><input className={`${field} ${mono}`} value={d.search} onChange={set('search')} placeholder="009 042" /></div>
          <div><span className={label}>Filing classes (a subset)</span><input className={`${field} ${mono}`} value={d.filing} onChange={set('filing')} placeholder="009" /></div>
          <div className="grid grid-cols-3 gap-2 sm:col-span-2">
            <div><span className={label}>Opening</span><input className={field} value={d.opening} onChange={set('opening')} /></div>
            <div><span className={label}>Hinge</span><input className={field} value={d.hinge} onChange={set('hinge')} /></div>
            <div><span className={label}>Ending</span><input className={field} value={d.ending} onChange={set('ending')} /></div>
          </div>
          <div className="sm:col-span-2"><span className={label}>Foreign equivalents to search</span><input className={field} value={d.foreign} onChange={set('foreign')} /></div>
          <div className="sm:col-span-2"><button className={btn} onClick={() => onOpen(c.id)}>Open the full stages for {c.mark}</button></div>
        </div>
      )}
      {problems.length > 0 && (d.opening || d.ending) && <p className="mt-2 text-[12px] text-[#f8a1a1]">{problems.join(' ')}</p>}
      {outside.length > 0 && <p className="mt-2 text-[12px] text-[#f8a1a1]">Filing class {outside.join(', ')} is not a search class.</p>}
      {preview && (
        <div className="mt-2">
          <button className="text-[12px] text-white/70 hover:text-white" onClick={() => setShowQ(!showQ)}>
            {showQ ? 'Hide' : 'Show'} the {preview.length} queries this will generate
          </button>
          {showQ && <ul className="mt-1 space-y-0.5">{preview.map((q) => <li key={q.seq} className={`${mono} text-white/75 break-all`}>Q{q.seq} {q.query}</li>)}</ul>}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className={btnPrimary} disabled={busy !== null || !initials.trim() || problems.length > 0 || !v.search.length || outside.length > 0} onClick={() => void confirm()}>
          {busy === 'confirm' ? 'Confirming…' : `Confirm ${c.mark}`}
        </button>
        <span className="text-[12px] text-[var(--color-text-muted)]">Saves these, generates the queries and signs stages 1 to 3 with your initials.</span>
      </div>
      <ErrorLine text={error} />
    </li>
  );
}

export default function BatchReview({ bundles, initials, setInitials, onChanged, onOpen }: {
  bundles: ClearanceBundle[]; initials: string; setInitials: (v: string) => void; onChanged: () => Promise<void>; onOpen: (id: string) => void;
}) {
  const todo = bundles.filter((b) => b.queries.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = todo.filter((b) => {
    if (!b.clearance.proposals?.classes || !b.clearance.proposals?.decompose) return false;
    const v = valueOf(b, initialDraft(b));
    return v.search.length > 0 && !decompositionProblems(b.clearance.mark, v.decomposition).length;
  });
  const acceptAll = async () => {
    setBusy(true); setError(null);
    try {
      // One confirmation per mark, each signed and recorded on its own.
      for (const b of ready) await confirmMark(b.clearance.id, valueOf(b, initialDraft(b)), initials);
      rememberInitials(initials);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!todo.length) return null;
  return (
    <section className="mt-2 rounded-lg border border-[#e8b84a]/30 bg-[rgba(232,184,74,0.03)] px-4 py-4" aria-label="Review the proposals">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-medium text-[var(--color-text-bright)]">Review: {todo.length} mark{todo.length === 1 ? '' : 's'} to confirm</h3>
        <div className="flex flex-wrap items-center gap-2">
          <InitialsField value={initials} onChange={setInitials} />
          {ready.length > 1 && (
            <button className={btn} disabled={busy || !initials.trim()} onClick={() => void acceptAll()}>
              {busy ? 'Confirming…' : `Accept all ${ready.length} as proposed`}
            </button>
          )}
        </div>
      </div>
      <Note>Proposals only. Check each mark's classes and search terms, edit what is wrong, and confirm it with your initials.</Note>
      <ErrorLine text={error} />
      <ul className="mt-3 space-y-3">
        {todo.map((b) => <MarkCard key={`${b.clearance.id}:${b.clearance.updated_at}`} b={b} initials={initials} onDone={onChanged} onOpen={onOpen} />)}
      </ul>
    </section>
  );
}
