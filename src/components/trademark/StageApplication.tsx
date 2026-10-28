// Stage 9 — Application draft (use-based or intent-to-use). The applicant,
// and per filing class: the identification, whether the mark is in use now
// (dates of first use and a specimen; or the dated evidence of a bona fide
// intent), the recommended basis and the reviewer's choice, and the transfer
// plan. The draft is assembled in TEAS order with a separate cautions annex,
// filed as a DRAFT, and signed off here with initials — which files the
// reviewed copy. Nothing is filed with the USPTO: the applicant signs the
// declaration and files in TEAS.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fileApplicationDraft, fileExport, rememberInitials, saveApplicationAnswers, signApplication, type ClearanceBundle,
} from '@/lib/trademark/data';
import {
  applicationQuestions, assembleApplication, draftLegend, normalizeApplicant, normalizeApplication, recommendBasis, specimenCheck,
  isServiceClass, SPECIMEN_KINDS, type AppClass, type ApplicantBlock, type Application, type Tri,
} from '../../../lib/trademark/application.mjs';
import { btn, btnPrimary, day, field, label, mono } from './styles';
import { ErrorLine, InitialsField, Note, Panel, StageChip } from './ui';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const TRI: { v: Tri; l: string }[] = [{ v: '', l: '—' }, { v: 'yes', l: 'Yes' }, { v: 'no', l: 'No' }, { v: 'unknown', l: 'Not sure' }];

function TriSelect({ value, onChange, aria }: { value: Tri; onChange: (v: Tri) => void; aria: string }) {
  return (
    <select className={`${field} w-[110px]`} value={value} aria-label={aria} onChange={(e) => onChange(e.target.value as Tri)}>
      {TRI.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
    </select>
  );
}

function ClassCard({ c, row, setRow, matterId, mark }: { c: string; row: AppClass; setRow: (r: AppClass) => void; matterId: string; mark: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const services = isServiceClass(c);
  const rec = recommendBasis(row, today());
  const flags = specimenCheck(row);
  const sp = row.specimen;
  const setSp = (k: keyof AppClass['specimen'], v: string) => setRow({ ...row, specimen: { ...sp, [k]: v } });
  const upload = async (f: File | null) => {
    if (!f) return;
    setBusy(true); setError(null);
    try {
      const id = await fileExport(matterId, f);
      setRow({ ...row, specimen: { ...sp, document_id: id } });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const checks: { k: keyof AppClass['specimen']; q: string }[] = [
    { k: 'shows_mark', q: `Does the specimen show ${mark}?` },
    { k: 'mark_as_brand', q: `Is ${mark} shown as the brand${services ? ' of the service' : ' of the goods'}, not only as the name of a feature or an in-product unit?` },
    ...(services
      ? [{ k: 'shows_services' as const, q: 'Does it show the services being offered under the mark?' }, { k: 'services_available' as const, q: 'Can a customer use the services today (not "coming soon")?' }]
      : [{ k: 'goods_sold' as const, q: 'Have the goods been sold or shipped under the mark?' }, ...(sp.kind === 'webpage' ? [{ k: 'means_of_ordering' as const, q: 'Does the page show a price and a way to order?' }] : [])]),
    { k: 'mockup', q: 'Is it a mockup, rendering or edited image?' },
  ];
  return (
    <div className="rounded border border-white/10 px-3 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-semibold text-white/90">Class {c}</span>
        <span className="text-[11.5px] text-white/50">{services ? 'services' : 'goods'}</span>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div><span className={label}>Identification</span>
          <textarea className={`${field} min-h-[56px]`} value={row.identification} onChange={(e) => setRow({ ...row, identification: e.target.value })}
            placeholder="Wording from the ID Manual, if one fits" />
        </div>
        <div>
          <span className={label}>Source</span>
          <select className={field} value={row.id_source} onChange={(e) => setRow({ ...row, id_source: e.target.value as AppClass['id_source'] })}>
            <option value="">—</option><option value="id_manual">ID Manual</option><option value="free_form">Free-form (surcharge)</option>
          </select>
          {row.id_source === 'id_manual' && <input className={`${field} mt-1`} value={row.id_manual_entry} onChange={(e) => setRow({ ...row, id_manual_entry: e.target.value })} placeholder="ID Manual entry" />}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2" role="radiogroup" aria-label={`Is the mark in use for class ${c}?`}>
        <span className="text-[12.5px] text-white/85">In use in commerce now, for these {services ? 'services' : 'goods'}?</span>
        {[true, false].map((v) => (
          <button key={String(v)} role="radio" aria-checked={row.in_use === v}
            className={`px-2.5 py-1 rounded border text-[12px] ${row.in_use === v ? 'border-[#e8b84a] text-[#e8b84a]' : 'border-white/15 text-white/70'}`}
            onClick={() => setRow({ ...row, in_use: v })}>{v ? 'Yes' : 'No'}</button>
        ))}
      </div>
      {row.in_use === true && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div><span className={label}>First use anywhere</span><input type="date" className={field} value={row.first_use_anywhere} onChange={(e) => setRow({ ...row, first_use_anywhere: e.target.value })} /></div>
          <div><span className={label}>First use in commerce</span><input type="date" className={field} value={row.first_use_in_commerce} onChange={(e) => setRow({ ...row, first_use_in_commerce: e.target.value })} /></div>
          <div className="sm:col-span-2">
            <span className={label}>Specimen</span>
            <div className="flex flex-wrap items-center gap-2">
              <input type="file" accept=".png,.jpg,.jpeg,.pdf" className="text-[12px] text-white/75 max-w-full" disabled={busy} onChange={(e) => void upload(e.target.files?.[0] ?? null)} />
              {sp.document_id && <Link className="text-[12px] text-[#e8b84a] hover:underline" to={`/app/document/${sp.document_id}`}>filed specimen</Link>}
              {busy && <span className="text-[12px] text-white/60">Filing…</span>}
            </div>
          </div>
          <div><span className={label}>What it is</span>
            <select className={field} value={sp.kind} onChange={(e) => setSp('kind', e.target.value)}>
              <option value="">—</option>{SPECIMEN_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          {sp.kind === 'webpage' && (
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2">
              <div><span className={label}>URL</span><input className={field} value={sp.url} onChange={(e) => setSp('url', e.target.value)} /></div>
              <div><span className={label}>Accessed</span><input type="date" className={field} value={sp.access_date} onChange={(e) => setSp('access_date', e.target.value)} /></div>
            </div>
          )}
          <div className="sm:col-span-2"><span className={label}>What the specimen shows</span>
            <input className={field} value={sp.description} onChange={(e) => setSp('description', e.target.value)} placeholder="e.g. the sign-up page offering the service under the mark" />
          </div>
          <ul className="sm:col-span-2 space-y-1">
            {checks.map((x) => (
              <li key={x.k} className="flex flex-wrap items-center gap-2 text-[12.5px] text-white/80">
                <TriSelect value={sp[x.k] as Tri} onChange={(v) => setSp(x.k, v)} aria={x.q} /> {x.q}
              </li>
            ))}
          </ul>
        </div>
      )}
      {row.in_use === false && (
        <div className="mt-2">
          <span className={label}>Dated evidence of a bona fide intent to use</span>
          {row.intent_evidence.map((e, i) => (
            <div key={i} className="mt-1 grid gap-2 grid-cols-[150px_minmax(0,1fr)_auto]">
              <input type="date" className={field} value={e.date} onChange={(ev) => setRow({ ...row, intent_evidence: row.intent_evidence.map((x, j) => (j === i ? { ...x, date: ev.target.value } : x)) })} />
              <input className={field} value={e.description} placeholder="Business plan, product specification, budget…" onChange={(ev) => setRow({ ...row, intent_evidence: row.intent_evidence.map((x, j) => (j === i ? { ...x, description: ev.target.value } : x)) })} />
              <button className={btn} onClick={() => setRow({ ...row, intent_evidence: row.intent_evidence.filter((_, j) => j !== i) })} aria-label="Remove">×</button>
            </div>
          ))}
          <button className={`${btn} mt-1`} onClick={() => setRow({ ...row, intent_evidence: [...row.intent_evidence, { date: '', description: '' }] })}>Add evidence</button>
        </div>
      )}
      {flags.length > 0 && (
        <ul className="mt-2 space-y-1">
          {flags.map((f) => <li key={f.id} className={`text-[12px] ${f.severity === 'flag' ? 'text-[#e8b84a]' : 'text-white/65'}`}>{f.severity === 'flag' ? 'Flag: ' : 'Question: '}{f.text}</li>)}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-white/80">Basis</span>
        <select className={`${field} w-[230px]`} value={row.basis} onChange={(e) => setRow({ ...row, basis: e.target.value as AppClass['basis'] })} aria-label={`Basis for class ${c}`}>
          <option value="">— choose —</option><option value="1a">Section 1(a) — use in commerce</option><option value="1b">Section 1(b) — intent to use</option>
        </select>
        {rec.basis && <span className="text-[12px] text-white/60">Recommended: {rec.basis === '1a' ? '1(a)' : '1(b)'} — {rec.reason}</span>}
      </div>
      <ErrorLine text={error} />
    </div>
  );
}

export default function StageApplication({ b, initials, setInitials, onChanged }: {
  b: ClearanceBundle; initials: string; setInitials: (v: string) => void; onChanged: () => Promise<void>;
}) {
  const c = b.clearance;
  const stored = normalizeApplication(c.application ?? {});
  const [a, setA] = useState<ApplicantBlock>(normalizeApplicant(c.applicant ?? {}));
  const [rows, setRows] = useState<AppClass[]>(() => (c.filing_classes ?? []).map((fc) => stored.classes.find((x) => x.code === fc.code)
    ?? normalizeApplication({ classes: [{ code: fc.code }] }).classes[0]));
  const [transfer, setTransfer] = useState<Application['transfer']>(stored.transfer);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const s6 = b.stages.find((s) => s.stage === 6);
  const s8 = b.stages.find((s) => s.stage === 8);
  const s9 = b.stages.find((s) => s.stage === 9);
  const d = today();
  const working = useMemo(() => ({ ...c, applicant: a, application: { ...stored, classes: rows, transfer } }), [c, a, stored, rows, transfer]);
  const questions = applicationQuestions({ clearance: working, today: d });
  const built = useMemo(() => assembleApplication({
    clearance: working, hits: b.hits, today: d, stages: { stage6: s6?.status, stage8: s8?.status, reportDocumentId: s8?.output_document_id ?? null },
  }), [working, b.hits, d, s6?.status, s8?.status, s8?.output_document_id]);
  const [preview, setPreview] = useState<'draft' | 'annex' | null>(null);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null); setNote(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const save = () => act('save', async () => {
    const refused = await saveApplicationAnswers(c, { applicant: a, classes: rows, transfer });
    setNote(refused.length ? `Saved. Not saved: ${refused.join('; ')}.` : 'Saved.');
    await onChanged();
  });
  const fileDraft = () => act('file', async () => {
    await saveApplicationAnswers(c, { applicant: a, classes: rows, transfer });
    const legend = `${draftLegend({ date: d, doNotFileBefore: built.doNotFileBefore })}\n`;
    await fileApplicationDraft(c, legend + built.draft, legend + built.annex, d, built.bases);
    setNote('The DRAFT and its cautions annex are filed in the matter.');
    await onChanged();
  });
  const sign = () => act('sign', async () => {
    await signApplication(c, built.draft, initials, d, built.doNotFileBefore);
    rememberInitials(initials);
    setNote('Signed off. The reviewed copy is filed; the applicant files in TEAS.');
    await onChanged();
  });
  const setApp = (k: keyof ApplicantBlock, v: string) => setA({ ...a, [k]: v });
  const blocked = built.blocking.length ? `${built.blocking.length} answer${built.blocking.length === 1 ? '' : 's'} still needed.`
    : built.lint.length ? `The draft uses "${built.lint[0].phrase}", a phrase this product never prints.`
      : s8?.status !== 'done' ? 'Stage 8 (the knockout report) is signed first.'
        : !(s6?.status === 'done' || s6?.status === 'skipped') ? 'Stage 6 (deep check) is signed or skipped first.'
          : !stored.draft ? 'File the draft first.' : !initials.trim() ? 'Your initials sign stage 9 off.' : null;

  if (!(c.filing_classes ?? []).length) {
    return (
      <Panel id="tm-stage-9" title="9. Application draft" aside={s9 ? <StageChip status={s9.status} /> : null}>
        <Note>No filing class is confirmed yet. Confirm the filing classes in stage 2 (each needs dated evidence of a bona fide intent) to draft an application.</Note>
      </Panel>
    );
  }

  return (
    <Panel id="tm-stage-9" title="9. Application draft (use-based or intent-to-use)" aside={s9 ? <StageChip status={s9.status} /> : null}>
      <Note>
        For each filing class: is {c.mark} in use now? If yes, the dates and a specimen (Section 1(a)); if not, the dated
        evidence of intent (Section 1(b)). The procedure recommends a basis; you choose. Nothing here is filed with the USPTO.
      </Note>
      <h4 className="mt-3 mb-2 text-[12px] font-semibold text-white/80">Applicant</h4>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="sm:col-span-2"><span className={label}>Legal name</span><input className={field} value={a.legal_name} onChange={(e) => setApp('legal_name', e.target.value)} placeholder="Grapheon.ai, LLC" /></div>
        <div><span className={label}>Entity type</span><input className={field} value={a.entity_type} onChange={(e) => setApp('entity_type', e.target.value)} placeholder="limited liability company" /></div>
        <div><span className={label}>State of organization</span><input className={field} value={a.state} onChange={(e) => setApp('state', e.target.value)} /></div>
        <div><span className={label}>Formed?</span>
          <select className={field} value={a.formation_status} onChange={(e) => setApp('formation_status', e.target.value)}>
            <option value="">—</option><option value="formed">Formed</option><option value="pending">Not yet</option><option value="individual">An individual</option>
          </select>
        </div>
        <div><span className={label}>Formation date</span><input type="date" className={field} value={a.formation_date} onChange={(e) => setApp('formation_date', e.target.value)} /></div>
        <div className="sm:col-span-2"><span className={label}>Domicile (street address of the principal place of business)</span><input className={field} value={a.domicile_address} onChange={(e) => setApp('domicile_address', e.target.value)} /></div>
        <div><span className={label}>A P.O. box, PMB or mail drop?</span>
          <select className={field} value={a.address_is_mail_drop} onChange={(e) => setApp('address_is_mail_drop', e.target.value)}>
            <option value="">—</option><option value="no">No</option><option value="yes">Yes</option><option value="unknown">Not sure</option>
          </select>
        </div>
        <div className="sm:col-span-2"><span className={label}>Mailing address (if different)</span><input className={field} value={a.mailing_address} onChange={(e) => setApp('mailing_address', e.target.value)} /></div>
        <div><span className={label}>Email for the USPTO</span><input className={field} value={a.email} onChange={(e) => setApp('email', e.target.value)} /></div>
      </div>

      <h4 className="mt-4 mb-2 text-[12px] font-semibold text-white/80">Classes</h4>
      <div className="space-y-3">
        {rows.map((r, i) => <ClassCard key={r.code} c={r.code} row={r} mark={c.mark} matterId={c.matterspace_id} setRow={(x) => setRows(rows.map((y, j) => (j === i ? x : y)))} />)}
      </div>

      <h4 className="mt-4 mb-2 text-[12px] font-semibold text-white/80">Will the marks move to another entity later?</h4>
      <div className="grid gap-2 sm:grid-cols-3">
        <div><span className={label}>Planned?</span>
          <select className={field} value={transfer.planned} onChange={(e) => setTransfer({ ...transfer, planned: e.target.value as Tri })}>
            <option value="">—</option><option value="no">No</option><option value="yes">Yes</option>
          </select>
        </div>
        {transfer.planned === 'yes' && (
          <>
            <div><span className={label}>To whom</span><input className={field} value={transfer.entity_name} onChange={(e) => setTransfer({ ...transfer, entity_name: e.target.value })} /></div>
            <div><span className={label}>Formed yet?</span>
              <select className={field} value={transfer.entity_formed === null ? '' : transfer.entity_formed ? 'yes' : 'no'} onChange={(e) => setTransfer({ ...transfer, entity_formed: e.target.value === '' ? null : e.target.value === 'yes' })}>
                <option value="">—</option><option value="no">Not yet</option><option value="yes">Yes</option>
              </select>
            </div>
            {transfer.entity_formed === false && (
              <div className="sm:col-span-3 space-y-1" role="radiogroup" aria-label="Which option">
                {([['wait', 'Wait: form the entity first and file in its name'], ['file_now_move_later', `File now as ${a.legal_name || 'the existing applicant'} and move the marks later, with the business`], ['successor', 'File now and rely on the successor exception, with care']] as const).map(([v, l]) => (
                  <label key={v} className="flex items-center gap-2 text-[12.5px] text-white/85">
                    <input type="radio" checked={transfer.choice === v} onChange={() => setTransfer({ ...transfer, choice: v })} /> {l}
                  </label>
                ))}
                {transfer.choice === 'wait' && <div className="max-w-[220px]"><span className={label}>Not before</span><input type="date" className={field} value={transfer.wait_until} onChange={(e) => setTransfer({ ...transfer, wait_until: e.target.value })} /></div>}
              </div>
            )}
          </>
        )}
      </div>

      {built.cautions.length > 0 && (
        <ul className="mt-3 space-y-1">{built.cautions.map((x) => <li key={x.id} className={`text-[12px] ${x.severity === 'block' ? 'text-[#f8a1a1]' : 'text-[#e8b84a]'}`}>{x.text}</li>)}</ul>
      )}
      {questions.length > 0 && (
        <details className="mt-3">
          <summary className="text-[12.5px] text-white/75 cursor-pointer">{questions.length} open question{questions.length === 1 ? '' : 's'} ({questions.filter((q) => q.blocking).length} needed for the draft)</summary>
          <ul className="mt-1 space-y-0.5">{questions.map((q) => <li key={q.id} className="text-[12px] text-white/70">{q.blocking ? 'Needed: ' : ''}{q.question}</li>)}</ul>
        </details>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className={btn} disabled={busy !== null} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save answers'}</button>
        <button className={btn} onClick={() => setPreview(preview === 'draft' ? null : 'draft')}>{preview === 'draft' ? 'Hide the draft' : 'Preview the draft'}</button>
        <button className={btn} onClick={() => setPreview(preview === 'annex' ? null : 'annex')}>{preview === 'annex' ? 'Hide the cautions' : 'Preview the cautions'}</button>
        <button className={btnPrimary} disabled={busy !== null || built.blocking.length > 0 || built.lint.length > 0} onClick={() => void fileDraft()}>
          {busy === 'file' ? 'Filing…' : stored.draft ? 'File a new draft' : 'File the draft in the matter'}
        </button>
        {built.doNotFileBefore && <span className="text-[12.5px] text-[#f8a1a1]">Do not file before {built.doNotFileBefore}.</span>}
      </div>
      {stored.draft && (
        <p className="mt-2 text-[12.5px] text-white/75">
          DRAFT filed {stored.draft.date}{stored.draft.via ? ` (${stored.draft.via})` : ''}:{' '}
          <Link className="text-[#e8b84a] hover:underline" to={`/app/document/${stored.draft.document_id}`}>the draft</Link>
          {stored.draft.annex_document_id && <> · <Link className="text-[#e8b84a] hover:underline" to={`/app/document/${stored.draft.annex_document_id}`}>the cautions</Link></>}
        </p>
      )}
      {preview && <pre className={`mt-3 max-h-[520px] overflow-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-black/30 px-3 py-3 text-white/85 ${mono}`}>{preview === 'draft' ? built.draft : built.annex}</pre>}

      <div className="mt-4 pt-3 border-t border-[rgba(255,255,255,0.06)] flex flex-wrap items-center gap-2">
        {s9?.status === 'done' ? (
          <span className="text-[12.5px] text-white/75">Signed off ({s9.initials}) {day(s9.done_at)} — {s9.output_document_id && <Link className="text-[#e8b84a] hover:underline" to={`/app/document/${s9.output_document_id}`}>the reviewed copy</Link>}</span>
        ) : (
          <>
            <InitialsField value={initials} onChange={setInitials} />
            <button className={btnPrimary} disabled={busy !== null || Boolean(blocked)} onClick={() => void sign()}>{busy === 'sign' ? 'Signing…' : 'Sign off the application draft'}</button>
            {blocked && <span className="text-[12px] text-[var(--color-text-muted)]">{blocked}</span>}
          </>
        )}
      </div>
      {note && <p className="mt-2 text-[12.5px] text-[#86e0a8]">{note}</p>}
      <ErrorLine text={error} />
    </Panel>
  );
}
