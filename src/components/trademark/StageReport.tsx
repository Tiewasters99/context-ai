// Stage 8 — Knockout report. "Assemble report" builds the Markdown
// deterministically, the forbidden-phrase lint runs over it, the preview
// shows it, and "File into matter" files it (disabled until the lint is clean
// and stage 5 is done), signs stage 8 off with the initials typed here, and
// records tm.report.filed. A later assembly files a new document; the old one
// stays.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fileReport, rememberInitials, type ClearanceBundle } from '@/lib/trademark/data';
import { assembleReport, aiUseFrom, lintReport, reportFilename } from '../../../lib/trademark/report.mjs';
import { procedureHash } from '../../../lib/trademark/procedure.mjs';
import type { LintHit } from '../../../lib/trademark/lint.mjs';
import { btn, btnPrimary, mono } from './styles';
import { ErrorLine, InitialsField, Note, Panel, StageChip } from './ui';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function StageReport({ b, matterName, preparerName, initials, setInitials, onChanged }: {
  b: ClearanceBundle; matterName: string; preparerName: string; initials: string; setInitials: (v: string) => void; onChanged: () => Promise<void>;
}) {
  const [md, setMd] = useState<string | null>(null);
  const [lint, setLint] = useState<LintHit[]>([]);
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<{ documentId: string; alreadyFiled: boolean } | null>(null);
  const stage5 = b.stages.find((s) => s.stage === 5)?.status === 'done';
  const s8 = b.stages.find((s) => s.stage === 8);

  const assemble = async () => {
    setBusy('assemble'); setError(null); setFiled(null);
    try {
      const d = today();
      const text = assembleReport({
        clearance: b.clearance, matter: { name: matterName }, preparer: { name: preparerName, initials: initials.trim().toUpperCase() },
        date: d, queries: b.queries, runs: b.runs, hits: b.hits,
        aiUse: aiUseFrom({ hits: b.hits, clearance: b.clearance }), procedureHash: await procedureHash(),
      });
      setDate(d); setMd(text); setLint(lintReport(text));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const file = async () => {
    if (!md) return;
    setBusy('file'); setError(null);
    try {
      const out = await fileReport(b.clearance, md, date, initials);
      rememberInitials(initials);
      setFiled(out);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // Slice 2: the report drafts on its own once the searches are recorded (a
  // preview, never filed; filing stays the reviewer's, with initials).
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current || md || !b.runs.length || b.queries.some((q) => !b.runs.some((r) => r.query_id === q.id))) return;
    auto.current = true;
    void assemble();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.runs.length, b.queries.length, md]);

  const blocked = !md ? 'Assemble the report first.'
    : lint.length ? 'The report uses a phrase this product never prints; edit the source and assemble again.'
      : !stage5 ? 'Stage 5 (triage) must be signed off first.'
        : !initials.trim() ? 'Your initials sign stage 8 off.' : null;

  return (
    <Panel id="tm-stage-8" title="8. Knockout report" aside={s8 ? <StageChip status={s8.status} /> : null}>
      <Note>
        The report is assembled from the record above, the same way every time. It has no conclusion line: the reviewer
        writes the conclusion elsewhere. It is filed as {reportFilename(b.clearance.mark, date)}.
      </Note>
      {s8?.output_document_id && (
        <p className="mt-2 text-[12.5px]">
          Filed: <Link className="text-[#e8b84a] hover:underline" to={`/app/document/${s8.output_document_id}`}>the knockout report</Link>
          {s8.initials ? ` (signed ${s8.initials})` : ''}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <InitialsField value={initials} onChange={setInitials} />
        <button className={btn} disabled={busy !== null} onClick={() => void assemble()}>{busy === 'assemble' ? 'Assembling…' : md ? 'Assemble again' : 'Assemble report'}</button>
        <button className={btnPrimary} disabled={busy !== null || Boolean(blocked)} onClick={() => void file()}>{busy === 'file' ? 'Filing…' : 'File into matter'}</button>
        {blocked && md && <span className="text-[12px] text-[var(--color-text-muted)]">{blocked}</span>}
      </div>
      <ErrorLine text={error} />
      {filed && (
        <p className="mt-2 text-[12.5px] text-white/80">
          {filed.alreadyFiled
            ? 'An identical report was already filed today; that document was kept and nothing new was filed. '
            : 'Filed, and stage 8 is signed off. '}
          <Link className="text-[#e8b84a] hover:underline" to={`/app/document/${filed.documentId}`}>Open it</Link>
        </p>
      )}
      {md && (
        <>
          <div className={`mt-3 rounded border px-3 py-2 text-[12.5px] ${lint.length ? 'border-[#f87171]/40 text-[#f8a1a1]' : 'border-[#4ade80]/30 text-[#86e0a8]'}`}>
            {lint.length === 0 ? 'Lint: clean.' : (
              <>
                <p>Lint: {lint.length} phrase{lint.length === 1 ? '' : 's'} this product never prints. Filing is blocked.</p>
                <ul className="mt-1 list-disc pl-5">{lint.map((h, i) => <li key={i}>“{h.phrase}” in: {h.sentence}</li>)}</ul>
              </>
            )}
          </div>
          <pre className={`mt-3 max-h-[520px] overflow-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-black/30 px-3 py-3 text-white/85 ${mono}`}>{md}</pre>
        </>
      )}
    </Panel>
  );
}
