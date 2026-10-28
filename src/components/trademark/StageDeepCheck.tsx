// Stage 6 — Deep check (TSDR). For each record triage proposed to flag, or the
// reviewer flagged, the official status and prosecution history from the
// USPTO TSDR API, fetched on the server (the key never reaches the browser),
// stored on the record and filed as a document in the matter. A dead record
// is noted, never dropped. Without a key on the server the stage says so and
// the reviewer may skip it.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { rememberInitials, runDeepCheck, signStage, type ClearanceBundle, type DeepCheckResult } from '@/lib/trademark/data';
import { isDead } from '../../../lib/trademark/triage.mjs';
import { btn, btnPrimary, day, td, th } from './styles';
import { ErrorLine, InitialsField, Note, Panel, Scroll, StageChip } from './ui';

function deepCheckTargets(b: ClearanceBundle) {
  return b.hits.filter((h) => h.bin === 'flag' || (!h.bin && h.proposed?.bin === 'flag') || h.deep_check === true);
}

export default function StageDeepCheck({ b, initials, setInitials, onChanged }: {
  b: ClearanceBundle; initials: string; setInitials: (v: string) => void; onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<DeepCheckResult | null>(null);
  const targets = deepCheckTargets(b);
  const s5 = b.stages.find((s) => s.stage === 5)?.status;
  const s6 = b.stages.find((s) => s.stage === 6);
  const unchecked = targets.filter((h) => !h.tsdr_checked_at).length;

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const fetchAll = (force = false) => act('fetch', async () => {
    let out: DeepCheckResult | null = null;
    for (let i = 0; i < 10; i++) {
      out = await runDeepCheck(b.clearance.id, force && i === 0);
      if (!out.configured || !out.remaining || out.stopped || out.checked === 0) break;
    }
    setLast(out);
    await onChanged();
  });
  const sign = (status: 'done' | 'skipped') => act(status, async () => {
    await signStage(b.clearance, 6, status, initials);
    rememberInitials(initials);
    await onChanged();
  });

  return (
    <Panel id="tm-stage-6" title="6. Deep check (official status, TSDR)" aside={s6 ? <StageChip status={s6.status} /> : null}>
      <Note>
        The official USPTO status of each record flagged in triage (proposed or decided), fetched from the TSDR API and filed
        in the matter. A dead record is noted here and in the application cautions; it is not dropped.
      </Note>
      {targets.length === 0 && <p className="mt-2 text-[12.5px] text-white/60">No record is flagged yet. Triage (stage 5) decides what is checked.</p>}
      {targets.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className={btnPrimary} disabled={busy !== null} onClick={() => void fetchAll(false)}>
            {busy === 'fetch' ? 'Fetching…' : unchecked ? `Fetch official status (${unchecked})` : 'Fetch again'}
          </button>
          <span className="text-[12px] text-[var(--color-text-muted)]">{targets.length - unchecked} of {targets.length} fetched.</span>
        </div>
      )}
      {last && !last.configured && (
        <p className="mt-2 rounded border border-[#e8b84a]/40 px-3 py-2 text-[12.5px] text-[#e8b84a]" role="status">{last.message}</p>
      )}
      {last?.stopped && <p className="mt-2 text-[12.5px] text-[#f8a1a1]">{last.message}</p>}
      {last && last.results.some((r) => !r.ok) && (
        <ul className="mt-2 space-y-0.5">{last.results.filter((r) => !r.ok).map((r) => <li key={r.serial} className="text-[12px] text-[#f8a1a1]">{r.serial}: {r.reason}</li>)}</ul>
      )}
      {targets.length > 0 && (
        <div className="mt-3">
          <Scroll>
            <table className="w-full min-w-[720px] border-collapse">
              <thead><tr className="border-b border-white/10">
                {['Serial', 'Mark', 'Official status', 'Live', 'Registration', 'Owner', 'Classes', 'Fetched', 'Record'].map((x) => <th key={x} className={th}>{x}</th>)}
              </tr></thead>
              <tbody>
                {targets.map((h) => {
                  const t = h.tsdr;
                  return (
                    <tr key={h.id} className="border-b border-white/5">
                      <td className={`${td} font-mono`}>{h.serial}</td>
                      <td className={td}>{t?.mark || h.mark || '—'}</td>
                      <td className={td}>{!t ? 'not fetched' : t.error ? <span className="text-[#f8a1a1]">not fetched: {t.error}</span> : [t.status_code, t.status_text].filter(Boolean).join(' — ') || '—'}</td>
                      <td className={td}>{!t || t.error ? '—' : t.live === true ? 'live' : t.live === false ? <span className="text-[#e8b84a]">dead (noted)</span> : 'not stated'}</td>
                      <td className={td}>{[t?.registration_number, t?.registration_date].filter(Boolean).join(', ') || '—'}</td>
                      <td className={td}>{t?.owner || h.owner || '—'}</td>
                      <td className={td}>{(t?.classes ?? h.classes ?? []).join(' ') || '—'}</td>
                      <td className={td}>{day(h.tsdr_checked_at)}</td>
                      <td className={td}>{h.tsdr_document_id ? <Link className="text-[#e8b84a] hover:underline" to={`/app/document/${h.tsdr_document_id}`}>open</Link> : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Scroll>
          {targets.some((h) => isDead(h)) && <Note>Records the search already showed as dead are listed too, so the official record of each is in the file.</Note>}
        </div>
      )}
      <div className="mt-4 pt-3 border-t border-[rgba(255,255,255,0.06)] flex flex-wrap items-center gap-2">
        {s6?.status === 'done' || s6?.status === 'skipped' ? (
          <span className="text-[12.5px] text-white/75">{s6.status === 'done' ? 'Signed off' : 'Skipped'} ({s6.initials}) {day(s6.done_at)}</span>
        ) : (
          <>
            <InitialsField value={initials} onChange={setInitials} />
            <button className={btnPrimary} disabled={busy !== null || !initials.trim() || s5 !== 'done' || unchecked > 0} onClick={() => void sign('done')}>Sign off this stage</button>
            <button className={btn} disabled={busy !== null || !initials.trim()} onClick={() => void sign('skipped')}>Skip this stage</button>
            <span className="text-[12px] text-[var(--color-text-muted)]">
              {s5 !== 'done' ? 'Stage 5 (triage) is signed first.' : unchecked ? `${unchecked} flagged record${unchecked === 1 ? '' : 's'} not fetched.` : ''}
            </span>
          </>
        )}
      </div>
      <ErrorLine text={error} />
    </Panel>
  );
}
