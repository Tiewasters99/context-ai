import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Upload, X, Trash2 } from 'lucide-react';
import { useServerspaces } from '@/hooks/useServerspaces';
import { allModels } from '@/lib/llm';
import { extractText } from '@/lib/extract';
import {
  listSessions, createSession, deleteSession,
  type PrepSession, type PrepSource,
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
  const [matterId, setMatterId] = useState('');
  const [sources, setSources] = useState<PrepSource[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: serverspaces = [] } = useServerspaces();
  const matterOptions = useMemo(
    () =>
      serverspaces.flatMap((s) =>
        s.matterspaces.map((m) => ({ id: m.id, label: `${s.name} / ${m.name}` })),
      ),
    [serverspaces],
  );

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
    if (!cleanTitle || sources.length === 0 || creating) return;
    setCreating(true);
    setFormError('');
    try {
      const s = await createSession({
        title: cleanTitle,
        modelId,
        matterspaceId: matterId || null,
        sources,
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
        lede="Argue before a hot bench before you argue before the real one. Hand up the briefs, take a bench memo, then stand for questioning — by the model of your choice."
      />

      {/* ---- New session ---- */}
      <section
        className="rounded-xl border border-[rgba(255,255,255,0.08)] p-5 sm:p-6 mb-10"
        style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
      >
        <h2 className="text-[11px] uppercase tracking-wider text-white/50 mb-4">New session</h2>

        <div className="space-y-4">
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

          <div>
            <FieldLabel htmlFor="moot-files">The briefs and record</FieldLabel>
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

          <GoldButton onClick={start} disabled={!title.trim() || sources.length === 0 || creating}>
            {creating ? 'Opening the courtroom…' : 'Prepare the bench memo'}
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
                    {s.status === 'memo' ? 'Bench memo' : s.status === 'prepping' ? 'In argument' : 'Ended'}
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
