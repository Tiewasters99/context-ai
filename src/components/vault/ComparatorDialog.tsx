import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Scale, Plus, Loader2, Check, AlertCircle, FileText, Upload, Eye, FileStack, ChevronLeft, X, Lock } from 'lucide-react';
import CardDialog from '@/components/ui/CardDialog';
import {
  listComparisonTypes, listComparisons, createComparison, getComparison, listCandidates, listGrades, keysFor,
  addCandidateFromFile, assembleAndFile, revealComparison, ComparatorMissingError,
  type Comparison, type ComparisonType, type Candidate, type Grade, type RubricDim,
} from '@/lib/comparator/data';

// The Model Comparator (spec MODEL-COMPARATOR-SPEC-2026-10-18, slice 1), as a
// docket for one Sandbox box: comparisons listed, a new one set up from a type
// (the drop-down; each type brings its default rubric, editable here), then
// for each comparison its candidates in blind order, who has a grade card,
// Assemble (the Comparison notes, filed into the box) and — once every
// candidate is graded — Reveal. Grading itself happens in the reader, on each
// candidate document: margin notes (tagged by dimension) and the grade card.

type View = { kind: 'list' } | { kind: 'new' } | { kind: 'detail'; id: string };

const INPUT = 'w-full px-3 py-2 rounded-lg border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.04)] text-[12px] text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-[#e8b84a]';
const BTN_PRIMARY = 'flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[12px] font-bold transition-colors disabled:opacity-40';
const BTN_QUIET = 'flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.1)] text-white/85 text-[12px] font-medium transition-colors disabled:opacity-40';
const LABEL = 'text-[10px] uppercase tracking-[0.08em] text-white/45 mb-1 block';

const keyOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'd$1').slice(0, 40) || 'dim';
const stamp = (ts: string) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export default function ComparatorDialog({
  box,
  docs,
  onClose,
  onFiled,
}: {
  box: { id: string; name: string };
  docs: { id: string; title: string }[];
  onClose: () => void;
  /** A document was filed into the box (a candidate or the notes): refresh its list. */
  onFiled: () => void;
}) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [types, setTypes] = useState<ComparisonType[]>([]);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No setState before the first await: the effect below calls this.
  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([listComparisonTypes(), listComparisons(box.id)]);
      setError(null);
      setTypes(t);
      setComparisons(c);
      setMissing(false);
    } catch (e) {
      if (e instanceof ComparatorMissingError) setMissing(true);
      else setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, [box.id]);

  useEffect(() => {
    let live = true;
    Promise.all([listComparisonTypes(), listComparisons(box.id)])
      .then(([t, c]) => { if (live) { setTypes(t); setComparisons(c); setMissing(false); } })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ComparatorMissingError) setMissing(true);
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [box.id]);

  const typeLabel = useCallback((key: string) => types.find((t) => t.key === key)?.label ?? key, [types]);

  return (
    <CardDialog
      storageKey="cs.dialog.modelComparator"
      z={60}
      maxWidth={760}
      height="78vh"
      onClose={onClose}
      icon={<Scale size={15} className="text-[#e8b84a]" />}
      title="Compare"
      subtitle={`Grade work product blind, side by side — ${box.name}`}
      bodyClassName="px-5 py-4 flex flex-col gap-3 overflow-y-auto"
    >
      {missing ? (
        <p className="flex items-start gap-2 text-[12px] text-amber-300/90 leading-relaxed">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          The Model Comparator is not set up in this database yet — migration 120 (model comparator) has not been applied.
        </p>
      ) : loading ? (
        <p className="flex items-center gap-2 text-[12px] text-white/50"><Loader2 size={13} className="animate-spin" /> Loading…</p>
      ) : error ? (
        <p className="flex items-start gap-2 text-[12px] text-red-400"><AlertCircle size={13} className="mt-0.5 shrink-0" /> {error}</p>
      ) : view.kind === 'new' ? (
        <NewComparison
          box={box}
          docs={docs}
          types={types}
          onCancel={() => setView({ kind: 'list' })}
          onCreated={async (c) => { await load(); setView({ kind: 'detail', id: c.id }); }}
        />
      ) : view.kind === 'detail' ? (
        <ComparisonDetail
          id={view.id}
          docs={docs}
          typeLabel={typeLabel}
          onBack={() => { setView({ kind: 'list' }); void load(); }}
          onFiled={onFiled}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-white/55 leading-snug">
              Each comparison grades several drafts of the same assignment — a model&apos;s, an associate&apos;s, a vendor&apos;s — on one rubric, blind until every draft has a grade card.
            </p>
            <button onClick={() => setView({ kind: 'new' })} className={BTN_PRIMARY}><Plus size={13} /> New comparison</button>
          </div>
          {comparisons.length === 0 ? (
            <p className="text-[12px] text-white/40 py-6 text-center border border-dashed border-white/10 rounded-lg">No comparisons in this box yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-white/[0.06] border border-white/[0.08] rounded-lg">
              {comparisons.map((c) => (
                <button key={c.id} onClick={() => setView({ kind: 'detail', id: c.id })}
                  className="flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/[0.03] transition-colors">
                  <Scale size={13} className="text-[#e8b84a]/80 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-white/90 truncate">{c.title}</span>
                    <span className="block text-[10px] text-white/45">{typeLabel(c.type)} · {stamp(c.created_at)}</span>
                  </span>
                  <span className={`text-[10px] shrink-0 ${c.revealed_at ? 'text-emerald-400/80' : 'text-white/40'}`}>
                    {c.revealed_at ? 'revealed' : 'blind'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </CardDialog>
  );
}

// ---------------------------------------------------------------------------
// New comparison: type → rubric (editable), title, instructions, packet
// ---------------------------------------------------------------------------
function NewComparison({ box, docs, types, onCancel, onCreated }: {
  box: { id: string; name: string };
  docs: { id: string; title: string }[];
  types: ComparisonType[];
  onCancel: () => void;
  onCreated: (c: Comparison) => void;
}) {
  const [typeKey, setTypeKey] = useState(types[0]?.key ?? '');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [packet, setPacket] = useState<Set<string>>(new Set());
  const [rubric, setRubric] = useState<RubricDim[]>(types[0]?.default_rubric ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickType = (key: string) => {
    setTypeKey(key);
    setRubric(types.find((t) => t.key === key)?.default_rubric ?? []);
  };
  const setDim = (i: number, label: string) =>
    setRubric((prev) => prev.map((d, j) => (j === i ? { key: d.key && d.label === label ? d.key : keyOf(label), label } : d)));

  const keys = rubric.map((d) => d.key);
  const rubricOk = rubric.length >= 3 && rubric.length <= 6 && rubric.every((d) => d.label.trim()) && new Set(keys).size === keys.length;
  const canSave = !!typeKey && title.trim().length > 0 && rubricOk && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const c = await createComparison({
        boxId: box.id, type: typeKey, title, instructions,
        packetDocIds: [...packet],
        rubric: rubric.map((d) => ({ key: d.key, label: d.label.trim() })),
      });
      onCreated(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <button onClick={onCancel} className="self-start inline-flex items-center gap-1 text-[11px] text-white/45 hover:text-white"><ChevronLeft size={12} /> Comparisons</button>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label>
          <span className={LABEL}>Type of comparison</span>
          <select value={typeKey} onChange={(e) => pickType(e.target.value)} className={`${INPUT} bg-[#181820]`}>
            {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label>
          <span className={LABEL}>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Novak 702 motion" className={INPUT} maxLength={200} />
        </label>
      </div>

      <div>
        <span className={LABEL}>Rubric — 3 to 6 dimensions, each scored 1–10 (overall and a comment are always on the grade card)</span>
        <div className="flex flex-col gap-1.5">
          {rubric.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[11px] text-white/35 w-4 text-right tabular-nums">{i + 1}</span>
              <input value={d.label} onChange={(e) => setDim(i, e.target.value)} className={INPUT} maxLength={80} />
              <button onClick={() => setRubric((prev) => prev.filter((_, j) => j !== i))} disabled={rubric.length <= 3}
                className="p-1.5 rounded text-white/35 hover:text-red-400 disabled:opacity-20" title="Remove this dimension"><X size={12} /></button>
            </div>
          ))}
          {rubric.length < 6 && (
            <button onClick={() => setRubric((prev) => [...prev, { key: `dim_${prev.length + 1}`, label: '' }])}
              className="self-start inline-flex items-center gap-1 text-[11px] text-white/45 hover:text-white/80 ml-6"><Plus size={11} /> Add a dimension</button>
          )}
          {!rubricOk && <p className="text-[11px] text-amber-300/80 ml-6">Each dimension needs a distinct name; keep 3 to 6.</p>}
        </div>
      </div>

      <label>
        <span className={LABEL}>Instructions — the assignment, the same for every candidate</span>
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} className={`${INPUT} resize-y`} />
      </label>

      <div>
        <span className={LABEL}>Packet — the documents in this box the candidates worked from (fingerprinted when you create it)</span>
        <div className="max-h-44 overflow-y-auto border border-white/[0.08] rounded-lg">
          {docs.length === 0 ? (
            <p className="text-[11px] text-white/40 px-3 py-2">This box has no documents yet.</p>
          ) : docs.map((d) => (
            <button key={d.id} onClick={() => setPacket((prev) => { const n = new Set(prev); if (n.has(d.id)) n.delete(d.id); else n.add(d.id); return n; })}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 hover:bg-white/[0.03] text-left">
              <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${packet.has(d.id) ? 'bg-[#e8b84a] border-[#e8b84a]' : 'border-white/20'}`}>
                {packet.has(d.id) && <Check size={10} className="text-black" strokeWidth={3} />}
              </span>
              <FileText size={12} className="text-white/50 shrink-0" />
              <span className="text-[12px] text-white/80 truncate">{d.title}</span>
            </button>
          ))}
        </div>
      </div>

      {error && <p className="flex items-start gap-2 text-[12px] text-red-400"><AlertCircle size={13} className="mt-0.5 shrink-0" /> {error}</p>}
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className={BTN_QUIET}>Cancel</button>
        <button onClick={() => void save()} disabled={!canSave} className={BTN_PRIMARY}>
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Create comparison
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One comparison: candidates, grade status, add, assemble, reveal
// ---------------------------------------------------------------------------
function ComparisonDetail({ id, docs, typeLabel, onBack, onFiled }: {
  id: string;
  docs: { id: string; title: string }[];
  typeLabel: (key: string) => string;
  onBack: () => void;
  onFiled: () => void;
}) {
  const navigate = useNavigate();
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [grades, setGrades] = useState<Record<string, Grade>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [maker, setMaker] = useState('');
  const [confirmReveal, setConfirmReveal] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const c = await getComparison(id);
      const list = await listCandidates(id);
      const g = await listGrades(list.map((x) => x.id));
      setError(null);
      setCmp(c);
      setCands(list);
      setGrades(Object.fromEntries(g.map((x) => [x.candidate_id, x])));
      setKeys(c.revealed_at ? await keysFor(list.map((x) => x.id)) : {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);
  useEffect(() => {
    let live = true;
    (async () => {
      const c = await getComparison(id);
      const list = await listCandidates(id);
      const g = await listGrades(list.map((x) => x.id));
      const k = c.revealed_at ? await keysFor(list.map((x) => x.id)) : {};
      return { c, list, g, k };
    })()
      .then(({ c, list, g, k }) => {
        if (!live) return;
        setCmp(c);
        setCands(list);
        setGrades(Object.fromEntries(g.map((x) => [x.candidate_id, x])));
        setKeys(k);
      })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [id]);

  const packetTitles = useMemo(() => {
    const byId = new Map(docs.map((d) => [d.id, d.title]));
    return (cmp?.packet_doc_ids ?? []).map((pid) => byId.get(pid) ?? '(a document no longer in this box)');
  }, [cmp, docs]);

  if (!cmp) {
    return error
      ? <p className="flex items-start gap-2 text-[12px] text-red-400"><AlertCircle size={13} className="mt-0.5 shrink-0" /> {error}</p>
      : <p className="flex items-center gap-2 text-[12px] text-white/50"><Loader2 size={13} className="animate-spin" /> Loading…</p>;
  }

  const allGraded = cands.length > 0 && cands.every((c) => grades[c.id]);
  const revealed = !!cmp.revealed_at;

  const add = async () => {
    if (!file) return;
    setBusy('add');
    setError(null);
    setNotice(null);
    try {
      const out = await addCandidateFromFile(cmp.id, file, maker);
      setNotice(`Filed as “${out.title}”${out.key_filed ? ' — who made it is held back until the reveal' : ''}.`);
      setFile(null);
      setMaker('');
      if (fileRef.current) fileRef.current.value = '';
      await load();
      onFiled();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  const assemble = async () => {
    setBusy('assemble');
    setError(null);
    setNotice(null);
    try {
      const out = await assembleAndFile(cmp.id);
      setNotice(`Comparison notes filed in this box as “${out.filename}”.`);
      onFiled();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  const reveal = async () => {
    setBusy('reveal');
    setError(null);
    setNotice(null);
    try {
      const out = await revealComparison(cmp, cands);
      setCmp(out.comparison);
      setKeys(out.keys);
      setConfirmReveal(false);
      setNotice('Revealed. The grade cards are now frozen; the reveal is in the matter’s Record.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <button onClick={onBack} className="self-start inline-flex items-center gap-1 text-[11px] text-white/45 hover:text-white"><ChevronLeft size={12} /> Comparisons</button>

      <div className="border-b border-white/[0.08] pb-3">
        <h3 className="text-[15px] font-semibold text-white">{cmp.title}</h3>
        <p className="text-[11px] text-white/50 mt-0.5">
          {typeLabel(cmp.type)} · rubric: {cmp.rubric.map((d) => d.label).join(' · ')} · created {stamp(cmp.created_at)}
        </p>
        <p className="text-[11px] text-white/45 mt-1">
          Packet: {packetTitles.length ? packetTitles.join('; ') : 'none'}
          {cmp.packet_hash && <span className="font-mono text-white/35"> · sha256 {cmp.packet_hash.slice(0, 12)}…</span>}
        </p>
        {cmp.instructions.trim() && (
          <details className="mt-1.5">
            <summary className="text-[11px] text-white/50 cursor-pointer hover:text-white/80">Instructions</summary>
            <p className="mt-1 text-[12px] text-white/75 whitespace-pre-wrap leading-relaxed">{cmp.instructions}</p>
          </details>
        )}
      </div>

      <div>
        <span className={LABEL}>Candidates {revealed ? '' : '(blind)'}</span>
        {cands.length === 0 ? (
          <p className="text-[12px] text-white/40 py-3">No candidates yet — add the drafts below.</p>
        ) : (
          <div className="flex flex-col divide-y divide-white/[0.06] border border-white/[0.08] rounded-lg">
            {cands.map((c) => {
              const g = grades[c.id];
              return (
                <div key={c.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-7 h-7 rounded-md bg-[rgba(232,184,74,0.12)] text-[#e8b84a] text-[12px] font-bold flex items-center justify-center shrink-0">{c.label}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] text-white/90 truncate">
                      {revealed && keys[c.id] ? <><span className="text-emerald-300/90">{keys[c.id]}</span> · </> : null}
                      {c.document?.title ?? 'document removed'}
                    </span>
                    <span className="block text-[10px] text-white/40">
                      {c.word_count != null ? `${c.word_count.toLocaleString('en-US')} words` : 'word count not recorded'}
                      {c.document?.processing_status && c.document.processing_status !== 'ready' ? ` · ${c.document.processing_status}` : ''}
                    </span>
                  </span>
                  <span className={`text-[10px] shrink-0 ${g ? 'text-emerald-400/80' : 'text-white/35'}`}>
                    {g ? `graded · ${g.initials} · overall ${g.overall}` : 'no grade card'}
                  </span>
                  {c.document_id && (
                    <button onClick={() => navigate(`/app/document/${c.document_id}`)} className={BTN_QUIET} title="Open in the reader to take margin notes and fill the grade card">
                      <FileText size={12} /> Read &amp; grade
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!revealed && (
        <div className="border border-white/[0.08] rounded-lg p-3 flex flex-col gap-2">
          <span className={LABEL}>Add a candidate — Markdown, text, PDF or Word; filed into the box as the next blind letter</span>
          <div className="flex flex-col sm:flex-row gap-2">
            <input ref={fileRef} type="file" accept=".md,.markdown,.txt,.pdf,.docx"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-[11px] text-white/70 file:mr-2 file:px-2.5 file:py-1.5 file:rounded-md file:border-0 file:bg-white/10 file:text-white/80 file:text-[11px]" />
            <input value={maker} onChange={(e) => setMaker(e.target.value)} maxLength={200}
              placeholder="Who or what made it — hidden until the reveal" className={INPUT} />
            <button onClick={() => void add()} disabled={!file || busy !== null} className={BTN_PRIMARY}>
              {busy === 'add' ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Add
            </button>
          </div>
          <p className="text-[10px] text-white/35 flex items-center gap-1"><Lock size={9} /> The name you type is stored apart from the draft; no one can read it, you included, until every candidate has a grade card and the comparison is revealed.</p>
        </div>
      )}

      {notice && <p className="flex items-start gap-2 text-[12px] text-emerald-400/90"><Check size={13} className="mt-0.5 shrink-0" /> {notice}</p>}
      {error && <p className="flex items-start gap-2 text-[12px] text-red-400"><AlertCircle size={13} className="mt-0.5 shrink-0" /> {error}</p>}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <button onClick={() => void assemble()} disabled={cands.length === 0 || busy !== null} className={BTN_QUIET}
          title="Build the Comparison notes from the grade cards and margin notes, and file them in this box">
          {busy === 'assemble' ? <Loader2 size={13} className="animate-spin" /> : <FileStack size={13} />} Assemble notes
        </button>
        {!revealed && allGraded && (confirmReveal ? (
          <>
            <span className="text-[11px] text-amber-300/90">Reveal freezes every grade card. Continue?</span>
            <button onClick={() => setConfirmReveal(false)} className={BTN_QUIET}>Not yet</button>
            <button onClick={() => void reveal()} disabled={busy !== null} className={BTN_PRIMARY}>
              {busy === 'reveal' ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />} Reveal
            </button>
          </>
        ) : (
          <button onClick={() => setConfirmReveal(true)} className={BTN_PRIMARY}><Eye size={13} /> Reveal who made each</button>
        ))}
        {!revealed && !allGraded && cands.length > 0 && (
          <span className="text-[11px] text-white/40">Reveal appears when every candidate has a grade card ({Object.keys(grades).length} of {cands.length}).</span>
        )}
        {revealed && <span className="text-[11px] text-emerald-400/80">Revealed {stamp(cmp.revealed_at as string)}</span>}
      </div>
    </div>
  );
}
