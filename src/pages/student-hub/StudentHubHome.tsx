import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { allModels } from '@/lib/llm';
import {
  listSessions, createSession, deleteSession, extractCaption, listTexts,
  DEFAULT_MODEL_ID, type StudySession, type StudyText,
} from '@/lib/student-hub';
import { readUploadedText, type StageProgress } from '@/lib/student-hub-upload';
import {
  SAMPLE_TITLE, SAMPLE_CITATION, SAMPLE_SOURCE_LABEL, SAMPLE_READING,
} from '@/lib/student-hub-sample';
import { T } from '@/components/student-hub/theme';
import {
  HubStyles, CaseCaption, GreenButton, QuietControl, ErrorNote,
} from '@/components/student-hub/ui';

// The Student Hub shelf: every loose text, rendered like a casebook's
// Table of Cases, plus the intake desk — paste a text or upload one.

const UPLOAD_STAGE: Record<StageProgress['stage'], string> = {
  pages: 'receiving the pages',
  ocr: 'reading the pages',
  map: 'reading',
  segment: 'reading',
  seed: 'filing the text',
};

export default function StudentHubHome() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<StudySession[] | null>(null);
  const [loadError, setLoadError] = useState('');

  const [reading, setReading] = useState('');
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [filing, setFiling] = useState<'reading' | 'sample' | 'upload' | null>(null);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [shelfOpen, setShelfOpen] = useState(false);
  const [texts, setTexts] = useState<StudyText[] | null>(null);

  const uploadInput = useRef<HTMLInputElement>(null);
  const [upFiles, setUpFiles] = useState<File[]>([]);
  const [upAttested, setUpAttested] = useState(false);
  const [upProgress, setUpProgress] = useState<StageProgress | null>(null);

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Could not load your texts.'));
  }, []);

  const toggleShelf = useCallback(() => {
    setShelfOpen((open) => !open);
    if (!texts) listTexts().then(setTexts).catch(() => setTexts([]));
  }, [texts]);

  const fileReading = useCallback(async () => {
    const text = reading.trim();
    if (!text || filing) return;
    setFiling('reading');
    setError('');
    try {
      // Best-effort caption; a failed extraction never blocks the filing.
      let caption = { title: '', citation: '', source_label: '' };
      try {
        caption = await extractCaption(modelId, text);
      } catch { /* fall through to the first line */ }
      const title = caption.title.trim() || text.split('\n').find((l) => l.trim())?.slice(0, 80) || 'Untitled text';
      const s = await createSession({
        title,
        citation: caption.citation.trim(),
        sourceLabel: caption.source_label.trim() || 'your own text',
        reading: text,
        modelId,
      });
      navigate(`/app/student-hub/${s.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The text could not be filed.');
      setFiling(null);
    }
  }, [reading, filing, modelId, navigate]);

  const pickUpload = useCallback((picked: File[]) => {
    setError('');
    if (picked.length > 1 && picked.some((f) => !f.type.startsWith('image/'))) {
      setError('Pick one document — or a set of page images.');
      return;
    }
    setUpFiles(picked);
  }, []);

  const fileUpload = useCallback(async () => {
    if (!upFiles.length || filing) return;
    setFiling('upload');
    setError('');
    setUpProgress(null);
    try {
      const { text, pages } = await readUploadedText(upFiles, setUpProgress);
      if (!text) throw new Error('Nothing readable came out of that file.');
      setUpProgress({ stage: 'seed', done: 0, total: 1 });
      let caption = { title: '', citation: '', source_label: '' };
      try {
        caption = await extractCaption(modelId, text);
      } catch { /* fall through to the file name */ }
      const named = upFiles.length === 1 ? upFiles[0].name.replace(/\.[a-z0-9]+$/i, '').trim() : '';
      const title = caption.title.trim() || named
        || text.split('\n').find((l) => l.trim())?.slice(0, 80) || 'Untitled text';
      const s = await createSession({
        title,
        citation: caption.citation.trim(),
        sourceLabel: caption.source_label.trim() || 'your own text',
        reading: text,
        modelId,
        pages: pages ?? undefined,
      });
      navigate(`/app/student-hub/${s.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The upload could not be filed.');
      setFiling(null);
      setUpProgress(null);
    }
  }, [upFiles, filing, modelId, navigate]);

  const takeSampleSeat = useCallback(async () => {
    if (filing) return;
    setFiling('sample');
    setError('');
    try {
      const s = await createSession({
        title: SAMPLE_TITLE,
        citation: SAMPLE_CITATION,
        sourceLabel: SAMPLE_SOURCE_LABEL,
        reading: SAMPLE_READING,
        modelId,
      });
      navigate(`/app/student-hub/${s.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The sample could not be filed.');
      setFiling(null);
    }
  }, [filing, modelId, navigate]);

  const remove = useCallback(async (id: string) => {
    try {
      await deleteSession(id);
      setSessions((prev) => prev?.filter((s) => s.id !== id) ?? prev);
      setConfirmDelete(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The text could not be removed.');
    }
  }, []);

  const label: React.CSSProperties = {
    fontFamily: T.sans, fontSize: 12, fontWeight: 700,
    letterSpacing: '0.05em', textTransform: 'uppercase', color: T.oxblood,
  };
  const spineColors = [T.greenDark, T.oxblood, T.green];

  return (
    <div className="student-hub-root" style={{ background: T.paper, minHeight: '100%' }}>
      <HubStyles />
      <CaseCaption
        backTo="/app/student-hub"
        kicker="Contextspaces · Student Hub · The shelf"
        title="The shelf"
        citation="Your texts."
        onTitleClick={toggleShelf}
      />

      <main style={{ maxWidth: 780, margin: '0 auto', padding: '26px 20px 48px' }}>
        {loadError && <ErrorNote>{loadError}</ErrorNote>}

        {/* ---- The shelf itself: your texts as spines ---- */}
        {shelfOpen && (
          <section aria-label="Your texts" style={{ marginBottom: 34 }}>
            <div style={{
              display: 'flex', alignItems: 'flex-end', gap: 6, overflowX: 'auto',
              minHeight: 128, padding: '6px 2px 0', borderBottom: `3px solid ${T.brass}`,
            }}>
              {texts === null && (
                <span style={{ fontFamily: T.mono, fontSize: 12, color: T.faint, paddingBottom: 10 }}>
                  fetching the shelf…
                </span>
              )}
              {texts && texts.length === 0 && (
                <span style={{
                  fontFamily: T.serif, fontSize: 14, fontStyle: 'italic',
                  color: T.faint, paddingBottom: 10,
                }}>
                  Nothing shelved as a text yet — add one below.
                </span>
              )}
              {texts?.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  title={t.title}
                  onClick={() => navigate(`/app/student-hub?text=${t.id}`)}
                  style={{
                    appearance: 'none', border: 'none', cursor: 'pointer', flexShrink: 0,
                    writingMode: 'vertical-rl', height: 108 + ((i * 7) % 3) * 11,
                    padding: '12px 7px', borderRadius: '2px 2px 0 0',
                    borderTop: `2px solid ${T.brass}`,
                    background: spineColors[i % spineColors.length], color: T.paper,
                    fontFamily: T.serif, fontStyle: 'italic', fontSize: 12.5, textAlign: 'left',
                  }}
                >
                  {t.title.length > 42 ? `${t.title.slice(0, 40)}…` : t.title}
                </button>
              ))}
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              gap: 14, flexWrap: 'wrap', marginTop: 8,
            }}>
              <Link
                to="/app/student-hub"
                style={{ fontFamily: T.sans, fontSize: 12, color: T.green, textDecoration: 'none' }}
              >
                Open your texts →
              </Link>
              <span style={{ fontFamily: T.sans, fontSize: 12, color: T.green }}>
                Connect to Grapheon.ai <span style={{ color: T.faint }}>(coming)</span>
              </span>
            </div>
          </section>
        )}

        {/* ---- Table of loose texts ---- */}
        {sessions && sessions.length > 0 && (
          <section style={{ marginBottom: 40 }}>
            <div style={{ ...label, color: T.green, marginBottom: 4 }}>Table of readings</div>
            {sessions.map((s) => (
              <div
                key={s.id}
                style={{
                  display: 'flex', alignItems: 'baseline', gap: 12,
                  borderBottom: `1px solid ${T.rule}`, padding: '12px 0',
                }}
              >
                <span style={{ color: T.brass, fontFamily: T.serif, flexShrink: 0 }}>§</span>
                <button
                  type="button"
                  onClick={() => navigate(`/app/student-hub/${s.id}`)}
                  style={{
                    appearance: 'none', border: 'none', background: 'none', cursor: 'pointer',
                    textAlign: 'left', padding: 0, flex: 1, minWidth: 0,
                  }}
                >
                  <span style={{ fontFamily: T.serif, fontSize: 17, fontStyle: 'italic', color: T.ink }}>
                    {s.title}
                  </span>
                  {s.citation && (
                    <span style={{ fontFamily: T.serif, fontSize: 13.5, color: T.faint, marginLeft: 10 }}>
                      {s.citation}
                    </span>
                  )}
                </button>
                <span style={{ fontFamily: T.sans, fontSize: 11, color: T.faint, flexShrink: 0 }}>
                  {new Date(s.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
                {confirmDelete === s.id ? (
                  <QuietControl
                    onClick={() => void remove(s.id)}
                    style={{ color: T.paper, background: T.oxblood, borderColor: T.oxblood }}
                  >
                    remove?
                  </QuietControl>
                ) : (
                  <QuietControl onClick={() => setConfirmDelete(s.id)}>×</QuietControl>
                )}
              </div>
            ))}
          </section>
        )}

        {sessions && sessions.length === 0 && (
          <p style={{
            fontFamily: T.serif, fontSize: 15, color: T.faint,
            lineHeight: 1.6, margin: '0 0 32px', maxWidth: 460,
          }}>
            Nothing filed yet. Paste or upload your first text below — or take the
            sample seat and let the professor start with the hairy hand.
          </p>
        )}

        <p style={{ fontFamily: T.sans, fontSize: 12, color: T.ink, margin: '0 0 26px' }}>
          Paste your text below, or{' '}
          <button
            type="button"
            onClick={() => uploadInput.current?.click()}
            style={{
              appearance: 'none', border: 'none', background: 'none', padding: 0,
              cursor: 'pointer', font: 'inherit', color: T.green, textDecoration: 'underline',
            }}
          >
            upload it here
          </button>
          .
        </p>

        {/* ---- Intake desk ---- */}
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {/* Paste */}
          <section style={{ flex: '1 1 340px', minWidth: 280 }}>
            <label htmlFor="hub-reading" style={label}>Paste your text</label>
            <textarea
              id="hub-reading"
              value={reading}
              onChange={(e) => setReading(e.target.value)}
              rows={9}
              placeholder="Your text…"
              style={{
                width: '100%', boxSizing: 'border-box', margin: '8px 0 10px',
                padding: '12px 14px', border: `1px solid ${T.rule}`, borderRadius: 2,
                background: '#FFFFFF', color: T.ink, outline: 'none', resize: 'vertical',
                fontFamily: T.serif, fontSize: 15, lineHeight: 1.55,
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <GreenButton onClick={() => void fileReading()} disabled={!reading.trim() || !!filing}>
                {filing === 'reading' ? 'Filing your text…' : 'File your text'}
              </GreenButton>
              <QuietControl onClick={() => void takeSampleSeat()} disabled={!!filing}>
                {filing === 'sample' ? 'seating…' : 'or take the sample seat — Hawkins v. McGee'}
              </QuietControl>
              <span style={{ flex: 1 }} />
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                aria-label="Professor model"
                style={{
                  fontFamily: T.sans, fontSize: 12, color: T.faint,
                  border: `1px solid ${T.rule}`, borderRadius: 2, background: 'transparent',
                  padding: '6px 8px',
                }}
              >
                {allModels().map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          </section>

          {/* Upload */}
          <section style={{ flex: '1 1 260px', minWidth: 250 }}>
            <div style={label}>Upload your text</div>
            <p style={{ fontFamily: T.sans, fontSize: 13, color: T.faint, lineHeight: 1.5, margin: '8px 0 12px' }}>
              A PDF, a plain-text file, or scanned page images. Scans are read
              page by page and filed with their pages.
            </p>
            <input
              ref={uploadInput}
              type="file"
              multiple
              accept=".txt,.md,.markdown,text/plain,application/pdf,image/jpeg,image/png,image/webp"
              style={{ display: 'none' }}
              onChange={(e) => pickUpload(Array.from(e.target.files ?? []))}
            />
            <GreenButton onClick={() => uploadInput.current?.click()} disabled={!!filing}>
              Choose a file…
            </GreenButton>
            {upFiles.length > 0 && (
              <div style={{ fontFamily: T.mono, fontSize: 12, color: T.green, margin: '10px 0 2px' }}>
                {upFiles.length === 1
                  ? upFiles[0].name
                  : `${upFiles.length} page images, in page order`}
              </div>
            )}
            {upFiles.length > 0 && (
              <>
                <label style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start',
                  margin: '12px 0 6px', cursor: 'pointer',
                }}>
                  <input
                    type="checkbox"
                    checked={upAttested}
                    onChange={(e) => setUpAttested(e.target.checked)}
                    style={{ marginTop: 3, accentColor: T.green }}
                  />
                  <span style={{ fontFamily: T.serif, fontSize: 13.5, color: T.ink, lineHeight: 1.5 }}>
                    This is my own lawful copy, uploaded for my personal study.
                  </span>
                </label>
                <div style={{ marginTop: 10 }}>
                  <GreenButton onClick={() => void fileUpload()} disabled={!upAttested || !!filing}>
                    {filing === 'upload' ? 'Reading…' : 'File the upload'}
                  </GreenButton>
                </div>
              </>
            )}
            {filing === 'upload' && upProgress && (
              <div style={{ fontFamily: T.mono, fontSize: 12, color: T.faint, marginTop: 10 }}>
                {UPLOAD_STAGE[upProgress.stage]}
                {upProgress.total > 1 ? ` ${upProgress.done}/${upProgress.total}` : '…'}
              </div>
            )}
            <p style={{ margin: '16px 0 0' }}>
              <Link
                to="/app/student-hub/add"
                style={{ fontFamily: T.sans, fontSize: 12, color: T.green, textDecoration: 'none' }}
              >
                A whole casebook chapter, scanned? Hand over the pages →
              </Link>
            </p>
          </section>
        </div>

        <p style={{ fontFamily: T.sans, fontSize: 13, color: T.faint, lineHeight: 1.5, margin: '22px 0 0' }}>
          The text is locked to your account — you can allow up to five people to
          access your texts. The briefs, outlines, summaries, and transcripts you
          generate are yours to keep.
        </p>
        {error && <div style={{ marginTop: 12 }}><ErrorNote>{error}</ErrorNote></div>}
      </main>
    </div>
  );
}
