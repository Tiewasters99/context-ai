import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OutlineSection, OutlineAnnotations, StudySession } from '@/lib/student-hub';
import { T } from './theme';
import { QuietControl } from './ui';

// The interactive outline — a general Student Hub surface. The generated
// outline is the skeleton; the student's layer (notes on a point, their own
// points, cross-references to other cases in their library) lives in
// `annotations`, keyed by position, so regenerating the outline never
// erases the student's work.

type LibraryReading = Pick<StudySession, 'id' | 'title' | 'kind' | 'citation'>;

export function InteractiveOutline({ outline, annotations, library, currentId, onChange }: {
  outline: OutlineSection[];
  annotations: OutlineAnnotations;
  /** Every reading in the library, for cross-references. */
  library: LibraryReading[];
  /** The reading this outline belongs to (excluded from cross-reference options). */
  currentId: string;
  onChange: (next: OutlineAnnotations) => void;
}) {
  const navigate = useNavigate();
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const [refOpen, setRefOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const marks = annotations.marks ?? {};
  const custom = annotations.custom ?? {};

  const setMark = (key: string, patch: { note?: string; refs?: { id: string; title: string }[] }) => {
    const next = { ...(marks[key] ?? {}), ...patch };
    if (!next.note && !next.refs?.length) {
      const rest = { ...marks };
      delete rest[key];
      onChange({ ...annotations, marks: rest });
    } else {
      onChange({ ...annotations, marks: { ...marks, [key]: next } });
    }
  };

  const addCustom = (sec: string) => {
    const text = draft.trim();
    if (!text) return;
    onChange({ ...annotations, custom: { ...custom, [sec]: [...(custom[sec] ?? []), text] } });
    setDraft('');
    setAdding(null);
  };

  const removeCustom = (sec: string, idx: number) => {
    const list = (custom[sec] ?? []).filter((_, i) => i !== idx);
    onChange({ ...annotations, custom: { ...custom, [sec]: list } });
  };

  const controls: React.CSSProperties = {
    appearance: 'none', border: 'none', background: 'none', cursor: 'pointer',
    fontFamily: T.sans, fontSize: 10.5, letterSpacing: '0.05em', textTransform: 'uppercase',
    color: T.faint, padding: '2px 4px',
  };

  const renderPoint = (key: string, text: string, removable?: () => void) => {
    const mark = marks[key];
    return (
      <div key={key} style={{ padding: '5px 0 5px 8px' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <div style={{ color: T.brass, fontFamily: T.serif, flexShrink: 0 }}>§</div>
          <div style={{ fontFamily: T.serif, fontSize: 15, lineHeight: 1.55, color: T.ink, flex: 1 }}>{text}</div>
          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
            <button type="button" style={controls} title="Note on this point"
              onClick={() => { setNoteOpen(noteOpen === key ? null : key); setRefOpen(null); }}>
              note
            </button>
            <button type="button" style={controls} title="Cross-reference a case from your library"
              onClick={() => { setRefOpen(refOpen === key ? null : key); setNoteOpen(null); }}>
              cite
            </button>
            {removable && (
              <button type="button" style={{ ...controls, color: T.oxblood }} title="Remove your point" onClick={removable}>
                ×
              </button>
            )}
          </div>
        </div>

        {/* cross-references already made */}
        {mark?.refs?.map((r) => (
          <div key={r.id} style={{ padding: '2px 0 0 42px' }}>
            <button
              type="button"
              onClick={() => navigate(`/app/student-hub/${r.id}`)}
              style={{
                appearance: 'none', border: 'none', background: 'none', cursor: 'pointer', padding: 0,
                fontFamily: T.serif, fontSize: 13.5, fontStyle: 'italic', color: T.green,
                textDecoration: 'underline', textDecorationColor: T.rule,
              }}
            >
              → {r.title}
            </button>
            <button type="button" style={{ ...controls, color: T.oxblood }} aria-label={`Remove reference to ${r.title}`}
              onClick={() => setMark(key, { refs: (mark.refs ?? []).filter((x) => x.id !== r.id) })}>
              ×
            </button>
          </div>
        ))}

        {/* the student's note on this point */}
        {mark?.note != null && noteOpen !== key && (
          <div style={{
            margin: '4px 0 2px 42px', padding: '4px 10px', borderLeft: `2px solid ${T.brass}`,
            fontFamily: T.serif, fontSize: 13.5, fontStyle: 'italic', color: T.faint, whiteSpace: 'pre-wrap',
          }}>
            {mark.note}
          </div>
        )}
        {noteOpen === key && (
          <textarea
            autoFocus
            defaultValue={mark?.note ?? ''}
            rows={2}
            placeholder="Your note on this point — saved when you click away"
            onBlur={(e) => { setMark(key, { note: e.target.value.trim() || undefined }); setNoteOpen(null); }}
            style={{
              width: '100%', boxSizing: 'border-box', margin: '4px 0 2px 42px', maxWidth: 'calc(100% - 42px)',
              padding: '6px 10px', border: `1px solid ${T.rule}`, borderLeft: `2px solid ${T.brass}`,
              borderRadius: 2, background: '#FFFFFF', outline: 'none', resize: 'vertical',
              fontFamily: T.serif, fontSize: 13.5, fontStyle: 'italic', color: T.ink,
            }}
          />
        )}
        {refOpen === key && (
          <select
            autoFocus
            defaultValue=""
            onChange={(e) => {
              const r = library.find((x) => x.id === e.target.value);
              if (r) setMark(key, { refs: [...(mark?.refs ?? []), { id: r.id, title: r.title }] });
              setRefOpen(null);
            }}
            onBlur={() => setRefOpen(null)}
            style={{
              margin: '4px 0 2px 42px', padding: '4px 8px', maxWidth: 'calc(100% - 42px)',
              border: `1px solid ${T.rule}`, borderRadius: 2, background: '#FFFFFF',
              fontFamily: T.serif, fontSize: 13, color: T.ink,
            }}
          >
            <option value="" disabled>Cross-reference a case…</option>
            {library.filter((r) => r.id !== currentId && r.kind === 'case').map((r) => (
              <option key={r.id} value={r.id}>{r.title}</option>
            ))}
          </select>
        )}
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 2 }}>
        <QuietControl disabled title="Study groups are coming — up to five classmates over one shared text">
          message your study group — soon
        </QuietControl>
      </div>
      {outline.map((sec, i) => (
        <div key={i} style={{ marginBottom: 26 }}>
          <div style={{ fontFamily: T.serif, fontSize: 18, fontWeight: 700, color: T.green, marginBottom: 10 }}>
            {sec.heading}
          </div>
          {sec.items.map((it, j) => renderPoint(`${i}.${j}`, it))}
          {(custom[String(i)] ?? []).map((text, j) =>
            renderPoint(`c${i}.${j}`, text, () => removeCustom(String(i), j)),
          )}
          {adding === String(i) ? (
            <div style={{ display: 'flex', gap: 8, padding: '5px 0 0 30px' }}>
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addCustom(String(i)); if (e.key === 'Escape') { setAdding(null); setDraft(''); } }}
                placeholder="Your own point — Enter to add"
                style={{
                  flex: 1, padding: '6px 10px', border: `1px solid ${T.rule}`, borderRadius: 2,
                  background: '#FFFFFF', outline: 'none', fontFamily: T.serif, fontSize: 14, color: T.ink,
                }}
              />
              <QuietControl onClick={() => addCustom(String(i))}>add</QuietControl>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { setAdding(String(i)); setDraft(''); }}
              style={{ ...controls, padding: '4px 0 0 30px' }}
            >
              + add your own point
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
