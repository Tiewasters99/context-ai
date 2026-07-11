import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Upload, X, Trash2 } from 'lucide-react';
import { useServerspaces } from '@/hooks/useServerspaces';
import { allModels } from '@/lib/llm';
import { extractText } from '@/lib/extract';
import { listMatterDocumentsRecursive } from '@/lib/vault-persist';
import type { VaultFile } from '@/lib/vault-types';
import { collectDescendantIds } from '@/components/matter/DeleteMatterModal';
import { loadCorpusDocumentText } from '@/lib/cite-check/corpus';
import {
  listSessions, createSession, deleteSession,
  type PrepSession, type PrepSource, type PrepMode,
} from '@/lib/moot';
import { GoldButton, Working, Notice, FieldLabel, INPUT_CLASS, PageHead } from '@/components/mediation/ui';

// Moot Bench — oral-argument prep. The hub: start a new session (name it,
// pick the matter and the model, hand up the briefs) and return to past ones.
// The shared mediation primitives are the house style for formal legal
// surfaces; they carry no mediation-specific branding.

export default function MootBench() {
  const navigate = useNavigate();

  const [sessions, setSessions] = useState<PrepSession[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const refresh = () => {
    listSessions()
      .then(setSessions)
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Could not load sessions.'));
  };
  useEffect(refresh, []);

  // ---- New session form ----
  const [title, setTitle] = useState('');
  const models = useMemo(() => allModels(), []);
  const [modelId, setModelId] = useState(models[0]?.id ?? '');
  const [mode, setMode] = useState<PrepMode>('bench');
  const [matterId, setMatterId] = useState('');
  const [sources, setSources] = useState<PrepSource[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Documents already ingested into the selected matter (and its
  // sub-matters) — the preferred source: they stay inside Contextspaces and
  // scanned PDFs arrive already OCR'd.
  const [matterDocs, setMatterDocs] = useState<VaultFile[] | null>(null);
  const [pickedDocIds, setPickedDocIds] = useState<Set<string>>(new Set());

  const { data: serverspaces = [] } = useServerspaces();
  const matterOptions = useMemo(
    () =>
      serverspaces.flatMap((s) =>
        s.matterspaces.map((m) => ({ id: m.id, label: `${s.name} / ${m.name}` })),
      ),
    [serverspaces],
  );

  // Load the matter's document list whenever the matter changes.
  useEffect(() => {
    setPickedDocIds(new Set());
    if (!matterId) { setMatterDocs(null); return; }
    let cancelled = false;
    const ids = collectDescendantIds(serverspaces, matterId);
    const nameById = new Map(
      serverspaces.flatMap((s) => s.matterspaces.map((m) => [m.id, m.name] as const)),
    );
    listMatterDocumentsRecursive(ids.length ? ids : [matterId], nameById)
      .then((docs) => { if (!cancelled) setMatterDocs(docs); })
      .catch(() => { if (!cancelled) setMatterDocs([]); });
    return () => { cancelled = true; };
  }, [matterId, serverspaces]);

  const togglePickedDoc = (id: string) => {
    setPickedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setExtracting(true);
    setFormError('');
    const next: PrepSource[] = [];
    for (const file of Array.from(files)) {
      try {
        const content = await extractText(file);
        if (!content.trim()) {
          setFormError(`No text could be read from ${file.name}. Scanned PDFs need OCR — ingest them into a matter first, or upload a text-layer copy.`);
          continue;
        }
        next.push({ name: file.name, content });
      } catch (e) {
        setFormError(`${file.name}: ${e instanceof Error ? e.message : 'could not read file'}`);
      }
    }
    setSources((prev) => [...prev, ...next]);
    setExtracting(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const start = async () => {
    const cleanTitle = title.trim();
    if (!cleanTitle || (sources.length === 0 && pickedDocIds.size === 0) || creating) return;
    setCreating(true);
    setFormError('');
    try {
      // Pull picked matter documents from the corpus (already ingested +
      // OCR'd) and merge with any device uploads.
      const fromMatter: PrepSource[] = [];
      for (const docId of pickedDocIds) {
        const doc = await loadCorpusDocumentText(docId);
        fromMatter.push({ name: doc.title, content: doc.text });
      }
      const s = await createSession({
        title: cleanTitle,
        modelId,
        matterspaceId: matterId || null,
        mode,
        sources: [...fromMatter, ...sources],
      });
      navigate(`/app/moot-bench/${s.id}`);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'The session could not be created.');
      setCreating(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteSession(id);
      refresh();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not delete the session.');
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:px-8 sm:py-12">
      <PageHead
        kicker="Productivity Suite"
        title="Moot Bench"
        lede="Prepare for oral argument two ways: stand before a hot bench that questions you like the real one, or sit down with a brilliant colleague who knows the record cold and work the arguments until you own them."
      />

      {/* ---- New session ---- */}
      <section
        className="rounded-xl border border-[rgba(255,255,255,0.08)] p-5 sm:p-6 mb-10"
        style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
      >
        <h2 className="text-[11px] uppercase tracking-wider text-white/50 mb-4">New session</h2>

        <div className="space-y-4">
          {/* Mode: adversarial bench, or a colleague to internalize with */}
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Prep mode">
            {([
              {
                key: 'bench' as const,
                title: 'The hot bench',
                blurb: 'A skeptical judge asks one question at a time, weakest point first. Take a bench memo, then stand for argument.',
              },
              {
                key: 'colleague' as const,
                title: 'A brilliant colleague',
                blurb: 'Work through the motions and arguments with a colleague who knows the record cold — until you own the material.',
              },
            ]).map((m) => (
              <button
                key={m.key}
                type="button"
                role="radio"
                aria-checked={mode === m.key}
                onClick={() => setMode(m.key)}
                className={`text-left rounded-lg border px-4 py-3 transition-colors ${
                  mode === m.key
                    ? 'border-[#d4a054] bg-[rgba(212,160,84,0.06)]'
                    : 'border-[rgba(255,255,255,0.1)] hover:border-[rgba(255,255,255,0.25)]'
                }`}
              >
                <span className={`block text-[13.5px] font-semibold ${mode === m.key ? 'text-[#e8b84a]' : 'text-white/85'}`}>
                  {m.title}
                </span>
                <span className="block text-[12px] text-white/45 leading-snug mt-1">{m.blurb}</span>
              </button>
            ))}
          </div>

          <div>
            <FieldLabel htmlFor="moot-title">Argument</FieldLabel>
            <input
              id="moot-title"
              className={INPUT_CLASS}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="GateGuard v. Amazon — motion to compel, oral argument"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel htmlFor="moot-model">The bench</FieldLabel>
              <select id="moot-model" className={INPUT_CLASS} value={modelId} onChange={(e) => setModelId(e.target.value)}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
            <div>
              <FieldLabel htmlFor="moot-matter">Matter (for sharing)</FieldLabel>
              <select id="moot-matter" className={INPUT_CLASS} value={matterId} onChange={(e) => setMatterId(e.target.value)}>
                <option value="">No matter — private session</option>
                {matterOptions.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Preferred source: documents already in the matter's Vault */}
          {matterId && (
            <div>
              <FieldLabel htmlFor="moot-matter-docs">From the matter's Vault</FieldLabel>
              {!matterDocs && <p className="text-[12px] text-white/40">Loading documents…</p>}
              {matterDocs && matterDocs.length === 0 && (
                <p className="text-[12px] text-white/40">No documents in this matter yet — upload below or ingest them into the matter first.</p>
              )}
              {matterDocs && matterDocs.length > 0 && (
                <ul id="moot-matter-docs" className="max-h-48 overflow-y-auto rounded-md border border-[rgba(255,255,255,0.1)] divide-y divide-[rgba(255,255,255,0.05)]">
                  {matterDocs.map((d) => {
                    const ready = d.status === 'indexed';
                    return (
                      <li key={d.id}>
                        <label className={`flex items-center gap-2.5 px-3 py-2 text-[12.5px] ${ready ? 'text-white/80 hover:bg-white/5 cursor-pointer' : 'text-white/30'}`}>
                          <input
                            type="checkbox"
                            disabled={!ready}
                            checked={pickedDocIds.has(d.id)}
                            onChange={() => togglePickedDoc(d.id)}
                            className="accent-[#d4a054] shrink-0"
                          />
                          <span className="truncate flex-1">{d.name}</span>
                          {!ready && <span className="text-[10px] uppercase tracking-wider shrink-0">not indexed</span>}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          <div>
            <FieldLabel htmlFor="moot-files">{matterId ? 'Or upload from this device' : 'The briefs and record'}</FieldLabel>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={extracting}
              className="flex items-center justify-center gap-2 w-full p-4 rounded-md border border-dashed border-[rgba(255,255,255,0.14)] text-[13px] text-white/60 hover:border-[rgba(212,160,84,0.5)] hover:text-[#e8b84a] transition-colors disabled:opacity-50"
            >
              <Upload size={15} />
              {extracting ? 'Reading…' : 'Add briefs, orders, key authorities (PDF, DOCX, TXT)'}
            </button>
            <input
              ref={fileRef}
              id="moot-files"
              type="file"
              multiple
              accept=".pdf,.docx,.txt,.md"
              className="hidden"
              onChange={(e) => void handleFiles(e.target.files)}
            />
            {sources.length > 0 && (
              <ul className="mt-2.5 space-y-1.5">
                {sources.map((s, i) => (
                  <li key={`${s.name}-${i}`} className="flex items-center gap-2.5 text-[12.5px] text-white/70">
                    <span className="truncate flex-1">{s.name}</span>
                    <span className="text-white/30 shrink-0">{Math.round(s.content.length / 1000).toLocaleString()}k chars</span>
                    <button
                      type="button"
                      onClick={() => setSources((prev) => prev.filter((_, j) => j !== i))}
                      className="text-white/40 hover:text-white shrink-0"
                      aria-label={`Remove ${s.name}`}
                    >
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {formError && <Notice>{formError}</Notice>}

          <GoldButton
            onClick={start}
            disabled={!title.trim() || (sources.length === 0 && pickedDocIds.size === 0) || creating}
          >
            {creating
              ? 'Opening the room…'
              : mode === 'bench' ? 'Prepare the bench memo' : 'Sit down with your colleague'}
          </GoldButton>
        </div>
      </section>

      {/* ---- Past sessions ---- */}
      <section aria-label="Past sessions">
        <h2 className="text-[11px] uppercase tracking-wider text-white/50 mb-2.5">Your sessions</h2>
        {loadError && <Notice>{loadError}</Notice>}
        {!sessions && !loadError && <Working>Opening the docket…</Working>}
        {sessions && sessions.length === 0 && (
          <p className="text-[13px] text-white/40">No sessions yet — your first argument starts above.</p>
        )}
        {sessions && sessions.length > 0 && (
          <ol className="space-y-2">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                <Link
                  to={`/app/moot-bench/${s.id}`}
                  className="flex items-center justify-between gap-4 flex-1 min-w-0 rounded-lg border border-[rgba(255,255,255,0.07)] px-4 py-3 hover:border-[rgba(212,160,84,0.4)] transition-colors"
                  style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
                >
                  <span className="text-[13.5px] text-white truncate">{s.title}</span>
                  <span className="text-[11.5px] text-[#d4a054] shrink-0">
                    {s.status === 'memo'
                      ? 'Bench memo'
                      : s.status === 'prepping'
                        ? (s.mode === 'colleague' ? 'In prep' : 'In argument')
                        : 'Ended'}
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={() => void remove(s.id)}
                  className="p-2 rounded-md text-white/30 hover:text-[#f0b9b9] hover:bg-[rgba(240,120,120,0.08)] transition-colors shrink-0"
                  title="Delete session"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
