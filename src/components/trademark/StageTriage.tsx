// Stage 5 — Triage. One row per register record (deduplicated by serial).
// Dead records are kept in the log, below, and not scored. "Propose triage"
// asks the model for a bin and two scores per live hit; the reviewer decides
// every row (Flag for review | Note | Dismiss), with a reason and initials.
// Accepting a page of proposals still writes one decision, and one Record
// row, per hit.

import { useMemo, useState } from 'react';
import { decideHit, rememberInitials, trademarkApi, type Bin, type ClearanceBundle, type TmHit } from '@/lib/trademark/data';
import { crowdedField, exclusionCheck, isDead } from '../../../lib/trademark/triage.mjs';
import { btn, day, field, td, th } from './styles';
import { ErrorLine, InitialsField, Note, Panel, Scroll } from './ui';
import SignOff from './SignOff';

const PAGE = 25;
const BIN_LABEL: Record<Bin, string> = { flag: 'Flag for review', note: 'Note', dismiss: 'Dismiss' };

function Goods({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  if (!text) return <>—</>;
  if (text.length <= 80) return <>{text}</>;
  return (
    <button className="text-left hover:text-white" onClick={() => setOpen(!open)} title={open ? 'Show less' : 'Show all'}>
      {open ? text : `${text.slice(0, 80)}…`}
    </button>
  );
}

function HitRow({ b, h, initials, onSaved }: { b: ClearanceBundle; h: TmHit; initials: string; onSaved: () => Promise<void> }) {
  const [bin, setBin] = useState<Bin | null>(h.bin);
  const [reason, setReason] = useState(h.bin_reason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = bin !== h.bin || (reason || null) !== (h.bin_reason || null);

  const save = async () => {
    if (!bin) return;
    setBusy(true); setError(null);
    try {
      await decideHit(b.clearance, h, bin, reason, initials);
      rememberInitials(initials);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const p = h.proposed;
  return (
    <tr className="border-b border-white/5">
      <td className={`${td} font-mono`}>{h.serial}</td>
      <td className={td}>{h.mark ?? '—'}</td>
      <td className={td}>{h.owner ?? '—'}</td>
      <td className={td}>{h.status_text ?? '—'}</td>
      <td className={td}>{h.classes.join(' ') || '—'}</td>
      <td className={`${td} max-w-[220px]`}><Goods text={h.goods_services} /></td>
      <td className={td}>{h.query_seqs.map((s) => `Q${s}`).join(' ')}</td>
      <td className={`${td} min-w-[180px]`}>
        {p ? (
          <span className="text-white/75">
            <span className="text-[#e8b84a]">{BIN_LABEL[p.bin]}</span> · similarity {p.similarity.score} <span className="text-white/50">({p.similarity.reason})</span>
            {' '}· relatedness {p.relatedness.score} <span className="text-white/50">({p.relatedness.reason})</span>
          </span>
        ) : '—'}
      </td>
      <td className={`${td} min-w-[260px]`}>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={`Decision for ${h.serial}`}>
          {(['flag', 'note', 'dismiss'] as Bin[]).map((x) => (
            <button key={x} role="radio" aria-checked={bin === x}
              className={`px-2 py-1 rounded border text-[11.5px] ${bin === x ? 'border-[#e8b84a] text-[#e8b84a]' : 'border-white/15 text-white/70 hover:text-white'}`}
              onClick={() => setBin(x)}>{BIN_LABEL[x]}</button>
          ))}
        </div>
        <input className={`${field} mt-1`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" aria-label="Reason" />
        <div className="mt-1 flex items-center gap-2">
          <button className={btn} disabled={busy || !bin || !dirty || !initials.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
          {h.bin && <span className="text-[11.5px] text-white/55">{BIN_LABEL[h.bin]} · {h.initials} · {day(h.decided_at)}</span>}
        </div>
        <ErrorLine text={error} />
      </td>
    </tr>
  );
}

export default function StageTriage({ b, initials, setInitials, onChanged }: {
  b: ClearanceBundle; initials: string; setInitials: (v: string) => void; onChanged: () => Promise<void>;
}) {
  const c = b.clearance;
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const live = useMemo(() => b.hits.filter((h) => !isDead(h)), [b.hits]);
  const dead = useMemo(() => b.hits.filter((h) => isDead(h)), [b.hits]);
  const undecided = live.filter((h) => !h.bin).length;
  const pages = Math.max(1, Math.ceil(live.length / PAGE));
  const shown = live.slice(page * PAGE, page * PAGE + PAGE);
  const crowd = c.decomposition ? crowdedField(b.hits, c.decomposition.opening, c.search_classes.map((x) => x.code)) : null;
  const excl = c.decomposition?.exclusions ?? [];
  const check = excl.length ? exclusionCheck({ exclusions: excl, knownMarks: c.known_marks ?? [], hits: b.hits }) : null;

  const propose = async () => {
    setBusy('propose'); setError(null); setNote(null);
    try {
      // 50 hits a request; keep going until none are left (a clearance can
      // hold thousands), newest serials first.
      let total = 0; let dropped = 0; let left = 0;
      for (let i = 0; i < 200; i++) {
        const out = await trademarkApi<{ proposed: number; discarded: { serial: string; reason: string }[]; remaining: number }>('triage', { clearance_id: c.id });
        total += out.proposed; dropped += out.discarded.length; left = out.remaining;
        setNote(`${total} proposal${total === 1 ? '' : 's'} added so far; ${left} still to propose…`);
        if (!out.remaining || out.proposed === 0) break;
      }
      setNote(`${total} proposal${total === 1 ? '' : 's'} added${dropped ? `; ${dropped} discarded (a phrase this product never prints, or an answer about a record not asked about)` : ''}.${left ? ` ${left} live record${left === 1 ? '' : 's'} still without a proposal — press Propose again.` : ''} Decide each row.`);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const acceptPage = async () => {
    setBusy('accept'); setError(null);
    try {
      const todo = shown.filter((h) => !h.bin && h.proposed);
      for (const h of todo) await decideHit(c, h, h.proposed!.bin, 'Accepted the proposal', initials);
      rememberInitials(initials);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel id="tm-stage-5" title="5. Triage" aside={
      <button className={btn} disabled={busy !== null || live.length === 0} onClick={() => void propose()}>{busy === 'propose' ? 'Asking…' : 'Propose triage'}</button>
    }>
      <Note>
        {live.length} live record{live.length === 1 ? '' : 's'}, {undecided} not yet decided; {dead.length} dead record{dead.length === 1 ? '' : 's'} kept in the log.
        {crowd ? ` Crowded field: ${crowd.count} live hit${crowd.count === 1 ? '' : 's'} in the search classes begin with “${c.decomposition?.opening}”.` : ''}
      </Note>
      {check && check.swallowed.length > 0 && (
        <p className="mt-1 text-[12px] text-[#e8b84a]">
          Exclusion check: {check.swallowed.map((s) => `${s.stem}* would swallow ${s.name}`).join('; ')}.
        </p>
      )}
      {note && <p className="mt-2 text-[12px] text-white/75">{note}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <InitialsField value={initials} onChange={setInitials} />
        <button className={btn} disabled={busy !== null || !initials.trim() || !shown.some((h) => !h.bin && h.proposed)} onClick={() => void acceptPage()}>
          {busy === 'accept' ? 'Saving…' : 'Accept all proposals on this page'}
        </button>
        {pages > 1 && (
          <span className="flex items-center gap-1 text-[12px] text-white/70">
            <button className={btn} disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            Page {page + 1} of {pages}
            <button className={btn} disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</button>
          </span>
        )}
      </div>
      <ErrorLine text={error} />
      <div className="mt-3">
        <Scroll>
          <table className="w-full min-w-[1100px] border-collapse">
            <thead><tr className="border-b border-white/10">
              {['Serial', 'Mark', 'Owner', 'Status', 'Classes', 'Goods and services', 'Found by', 'Proposed', 'Decision'].map((x) => <th key={x} className={th}>{x}</th>)}
            </tr></thead>
            <tbody>{shown.map((h) => <HitRow key={`${h.id}:${h.bin}:${h.decided_at}`} b={b} h={h} initials={initials} onSaved={onChanged} />)}</tbody>
          </table>
        </Scroll>
        {live.length === 0 && <p className="mt-2 text-[12.5px] text-white/60">No live records yet. Record the runs in stage 4.</p>}
      </div>
      {dead.length > 0 && (
        <details className="mt-4">
          <summary className="text-[12.5px] text-white/75 cursor-pointer">Dead (kept in the log): {dead.length}</summary>
          <Scroll>
            <table className="mt-2 w-full min-w-[480px] border-collapse">
              <thead><tr className="border-b border-white/10"><th className={th}>Serial</th><th className={th}>Mark</th><th className={th}>Status</th><th className={th}>Found by</th></tr></thead>
              <tbody>{dead.map((h) => (
                <tr key={h.id} className="border-b border-white/5">
                  <td className={`${td} font-mono`}>{h.serial}</td><td className={td}>{h.mark}</td><td className={td}>{h.status_text ?? 'dead'}</td>
                  <td className={td}>{h.query_seqs.map((s) => `Q${s}`).join(' ')}</td>
                </tr>
              ))}</tbody>
            </table>
          </Scroll>
        </details>
      )}
      <SignOff b={b} stage={5} initials={initials} setInitials={setInitials} onChanged={onChanged}
        blocked={undecided > 0 ? `${undecided} live record${undecided === 1 ? '' : 's'} still to decide.` : null} />
    </Panel>
  );
}
