import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { allModels } from '@/lib/llm';
import {
  listSessions, createSession, deleteSession, extractCaption,
  DEFAULT_MODEL_ID, type StudySession,
} from '@/lib/student-hub';
import {
  SAMPLE_TITLE, SAMPLE_CITATION, SAMPLE_SOURCE_LABEL, SAMPLE_READING,
} from '@/lib/student-hub-sample';
import { T } from '@/components/student-hub/theme';
import {
  HubStyles, CaseCaption, GreenButton, QuietControl, ErrorNote,
} from '@/components/student-hub/ui';

// The Student Hub shelf: every filed reading, rendered like a casebook's
// Table of Cases, plus the intake desk for the next assignment.

export default function StudentHubHome() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<StudySession[] | null>(null);
  const [loadError, setLoadError] = useState('');

  const [reading, setReading] = useState('');
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [filing, setFiling] = useState<'reading' | 'sample' | null>(null);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Could not load your readings.'));
  }, []);

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
      const title = caption.title.trim() || text.split('\n').find((l) => l.trim())?.slice(0, 80) || 'Untitled reading';
      const s = await createSession({
        title,
        citation: caption.citation.trim(),
        sourceLabel: caption.source_label.trim() || 'scanned from your casebook',
        reading: text,
        modelId,
      });
      navigate(`/app/student-hub/${s.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The reading could not be filed.');
      setFiling(null);
    }
  }, [reading, filing, modelId, navigate]);

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
      setError(e instanceof Error ? e.message : 'The reading could not be removed.');
    }
  }, []);

  const label: React.CSSProperties = {
    fontFamily: T.sans, fontSize: 12, fontWeight: 700,
    letterSpacing: '0.05em', textTransform: 'uppercase', color: T.oxblood,
  };

  return (
    <div className="student-hub-root" style={{ background: T.paper, minHeight: '100%' }}>
      <HubStyles />
      <CaseCaption
        kicker="Contextspaces · Student Hub · The shelf"
        title="The shelf"
        citation="Loose readings and the intake desk. Your texts live in the hub."
      />

      <main style={{ maxWidth: 780, margin: '0 auto', padding: '26px 20px 48px' }}>
        {loadError && <ErrorNote>{loadError}</ErrorNote>}

        {/* ---- Table of readings ---- */}
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
            Nothing filed yet. Paste tonight's assignment below — or take the sample
            seat and let the professor start with the hairy hand.
          </p>
        )}

        {/* ---- Intake desk ---- */}
        <section>
          <label htmlFor="hub-reading" style={label}>Paste the reading</label>
          <textarea
            id="hub-reading"
            value={reading}
            onChange={(e) => setReading(e.target.value)}
            rows={9}
            placeholder="The assignment, from your own scanned casebook…"
            style={{
              width: '100%', boxSizing: 'border-box', margin: '8px 0 4px',
              padding: '12px 14px', border: `1px solid ${T.rule}`, borderRadius: 2,
              background: '#FFFFFF', color: T.ink, outline: 'none', resize: 'vertical',
              fontFamily: T.serif, fontSize: 15, lineHeight: 1.55,
            }}
          />
          <p style={{ fontFamily: T.sans, fontSize: 13, color: T.faint, lineHeight: 1.5, margin: '2px 0 14px' }}>
            From your own copy of the casebook. The text is locked to your account —
            the briefs, outlines, and cold-call transcripts it produces are yours to keep and share.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <GreenButton onClick={() => void fileReading()} disabled={!reading.trim() || !!filing}>
              {filing === 'reading' ? 'Filing the reading…' : 'File the reading'}
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
          {error && <div style={{ marginTop: 10 }}><ErrorNote>{error}</ErrorNote></div>}
        </section>
      </main>
    </div>
  );
}
