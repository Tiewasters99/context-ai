import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  listTexts, listReadings, sessionsWithTranscripts, updateSession, generateOutline,
  type StudyText, type StudySession, type OutlineAnnotations,
} from '@/lib/student-hub';
import { T } from '@/components/student-hub/theme';
import { HubStyles, Kicker, HubTab, ErrorNote, GreenButton } from '@/components/student-hub/ui';
import { InteractiveOutline } from '@/components/student-hub/InteractiveOutline';
import StudentHubHome from './StudentHubHome';

// The hub flows from the library down: My texts (dropdown) -> one text ->
// four drawers (Readings / Outlines / Case briefs / Cold calls) -> the
// chapter's cases and materials -> one reading's own page. As the student
// scans more chapters and books, the dropdown and the tree grow.

type Drawer = 'readings' | 'outlines' | 'briefs' | 'coldcalls';

const DRAWER_TAB: Record<Drawer, string> = {
  readings: '',
  outlines: '?tab=outline',
  briefs: '?tab=brief',
  coldcalls: '?tab=coldcall',
};

export default function TextView() {
  const navigate = useNavigate();
  const [texts, setTexts] = useState<StudyText[] | null>(null);
  const [textId, setTextId] = useState<string>('');
  const [readings, setReadings] = useState<StudySession[]>([]);
  const [inProgress, setInProgress] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<Drawer>('readings');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [outlining, setOutlining] = useState<string | null>(null);

  useEffect(() => {
    listTexts()
      .then((ts) => {
        setTexts(ts);
        if (ts.length) setTextId(ts[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not open your library.'));
  }, []);

  useEffect(() => {
    if (!textId) return;
    let stale = false;
    listReadings(textId)
      .then(async (rs) => {
        if (stale) return;
        setReadings(rs);
        const withCalls = await sessionsWithTranscripts(rs.map((r) => r.id));
        if (!stale) setInProgress(withCalls);
      })
      .catch((e) => { if (!stale) setError(e instanceof Error ? e.message : 'Could not load the readings.'); });
    return () => { stale = true; };
  }, [textId]);

  // chapter -> section -> items, preserving sort order.
  const tree = useMemo(() => {
    const chapters: { chapter: string; sections: { section: string; items: StudySession[] }[] }[] = [];
    for (const r of readings) {
      let ch = chapters[chapters.length - 1];
      if (!ch || ch.chapter !== r.chapter) {
        ch = { chapter: r.chapter, sections: [] };
        chapters.push(ch);
      }
      let sec = ch.sections[ch.sections.length - 1];
      if (!sec || sec.section !== r.section) {
        sec = { section: r.section, items: [] };
        ch.sections.push(sec);
      }
      sec.items.push(r);
    }
    return chapters;
  }, [readings]);

  if (texts && texts.length === 0) return <StudentHubHome />;

  const selected = texts?.find((t) => t.id === textId) ?? null;
  const sectionCount = new Set(readings.map((r) => `${r.chapter}//${r.section}`)).size;

  const toggleSection = (key: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const patchReading = (id: string, patch: Partial<StudySession>) =>
    setReadings((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const saveAnnotations = async (r: StudySession, annotations: OutlineAnnotations) => {
    patchReading(r.id, { annotations });
    try {
      await updateSession(r.id, { annotations });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Your marks could not be saved.');
    }
  };

  const outlineInPlace = async (r: StudySession) => {
    if (outlining) return;
    setOutlining(r.id);
    setError('');
    try {
      const sections = await generateOutline(r);
      await updateSession(r.id, { outline: sections });
      patchReading(r.id, { outline: sections });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The outline could not be prepared.');
    } finally {
      setOutlining(null);
    }
  };

  const rightNote = (r: StudySession): { text: string; there: boolean } => {
    if (drawer === 'outlines') return r.outline ? { text: 'outlined', there: true } : { text: 'not yet', there: false };
    if (drawer === 'briefs') return r.brief ? { text: 'briefed', there: true } : { text: 'not yet', there: false };
    if (drawer === 'coldcalls') return inProgress.has(r.id) ? { text: 'in progress', there: true } : { text: 'not yet called', there: false };
    return { text: r.pages?.length ? `${r.pages.length} pp.` : 'text', there: true };
  };

  return (
    <div className="student-hub-root" style={{ background: T.paper, minHeight: '100%' }}>
      <HubStyles />

      {/* ---- My texts caption band: click the title to open the library ---- */}
      <header style={{ background: T.greenDark, borderBottom: `3px solid ${T.brass}`, padding: '24px 24px 18px' }}>
        <div style={{ maxWidth: 780, margin: '0 auto', position: 'relative' }}>
          <Kicker>
            Contextspaces · Student Hub ·{' '}
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              style={{
                appearance: 'none', border: 'none', background: 'none', cursor: 'pointer', padding: 0,
                font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit', color: 'inherit',
                textDecoration: 'underline', textUnderlineOffset: 3,
                textDecorationColor: 'rgba(169,139,69,0.6)',
              }}
            >
              My texts {menuOpen ? '▴' : '▾'}
            </button>
          </Kicker>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-label="My texts — choose a text"
            style={{
              appearance: 'none', border: 'none', background: 'transparent', cursor: 'pointer',
              display: 'flex', alignItems: 'baseline', gap: 10, padding: 0, margin: '0.2em 0 0',
              textAlign: 'left', maxWidth: '100%',
            }}
          >
            <span style={{
              fontFamily: T.serif, fontSize: 'clamp(20px, 3.5vw, 27px)', color: T.paper,
              fontStyle: 'italic', fontWeight: 400,
            }}>
              {selected ? selected.title : 'Opening your library…'}
            </span>
            <span style={{ color: T.brass, fontSize: 13, flexShrink: 0 }}>{menuOpen ? '▴' : '▾'}</span>
          </button>
          {menuOpen && texts && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 10,
              background: T.paper, border: `1px solid ${T.rule}`, borderTop: `3px solid ${T.brass}`,
              borderRadius: 2, maxHeight: 320, overflowY: 'auto',
            }}>
              {texts.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => { setTextId(t.id); setMenuOpen(false); setExpanded(new Set()); }}
                  style={{
                    appearance: 'none', border: 'none', cursor: 'pointer', display: 'block',
                    width: '100%', textAlign: 'left', padding: '12px 16px',
                    background: t.id === textId ? 'rgba(31,77,58,0.07)' : 'transparent',
                    borderBottom: `1px solid ${T.rule}`,
                    fontFamily: T.serif, fontSize: 16, fontStyle: 'italic', color: T.ink,
                  }}
                >
                  {t.title}
                </button>
              ))}
              <div style={{ padding: '10px 16px', fontFamily: T.sans, fontSize: 11.5, color: T.faint }}>
                Scan more chapters and they take their place here.
              </div>
            </div>
          )}
          {readings.length > 0 && (
            <div style={{ fontFamily: T.serif, fontSize: 13, color: 'rgba(250,248,242,0.65)', marginTop: 4 }}>
              {sectionCount} section{sectionCount === 1 ? '' : 's'} · {readings.length} reading{readings.length === 1 ? '' : 's'}
            </div>
          )}
        </div>
      </header>

      {/* ---- Drawers ---- */}
      <nav style={{ borderBottom: `1px solid ${T.rule}`, position: 'sticky', top: 0, zIndex: 5, background: T.paper }}>
        <div style={{ maxWidth: 780, margin: '0 auto', display: 'flex', gap: 4, padding: '8px 16px', flexWrap: 'wrap' }}>
          <HubTab label="Readings" active={drawer === 'readings'} onClick={() => setDrawer('readings')} />
          <HubTab label="Outlines" active={drawer === 'outlines'} onClick={() => setDrawer('outlines')} />
          <HubTab label="Case briefs" active={drawer === 'briefs'} onClick={() => setDrawer('briefs')} />
          <HubTab label="Cold calls" active={drawer === 'coldcalls'} onClick={() => setDrawer('coldcalls')} />
        </div>
      </nav>

      <main style={{ maxWidth: 780, margin: '0 auto', padding: '20px 20px 48px' }}>
        {error && <ErrorNote>{error}</ErrorNote>}

        {tree.map((ch) => (
          <section key={ch.chapter} style={{ marginBottom: 10 }}>
            {ch.chapter && (
              <h2 style={{
                fontFamily: T.serif, fontSize: 19, fontWeight: 700, color: T.green,
                margin: '14px 0 4px',
              }}>
                {ch.chapter}
              </h2>
            )}
            {ch.sections.map((sec) => {
              const key = `${ch.chapter}//${sec.section}`;
              const open = !closed.has(key);
              const items = drawer === 'briefs' ? sec.items.filter((i) => i.kind === 'case') : sec.items;
              if (!items.length) return null;
              return (
                <div key={key} style={{ margin: '10px 0 4px' }}>
                  {sec.section && (
                    <button
                      type="button"
                      onClick={() => toggleSection(key)}
                      aria-expanded={open}
                      style={{
                        appearance: 'none', border: 'none', background: 'none', cursor: 'pointer',
                        display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 0',
                        fontFamily: T.serif, fontSize: 16, color: T.green, width: '100%', textAlign: 'left',
                      }}
                    >
                      <span style={{ color: T.brass, fontSize: 13, width: 12 }}>{open ? '▾' : '▸'}</span>
                      {sec.section}
                    </button>
                  )}
                  {open && items.map((r) => {
                    const note = rightNote(r);
                    const isExpanded = drawer === 'outlines' && expanded.has(r.id);
                    return (
                      <div key={r.id} style={{ borderBottom: `1px solid ${T.rule}` }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '10px 0 10px 20px' }}>
                          <span style={{ color: T.brass, fontFamily: T.serif, flexShrink: 0 }}>§</span>
                          <button
                            type="button"
                            onClick={() =>
                              drawer === 'outlines'
                                ? toggleExpand(r.id)
                                : navigate(`/app/student-hub/${r.id}${DRAWER_TAB[drawer]}`)}
                            style={{
                              appearance: 'none', border: 'none', background: 'none', cursor: 'pointer',
                              textAlign: 'left', padding: 0, flex: 1, minWidth: 0,
                            }}
                          >
                            <span style={{
                              fontFamily: T.serif, fontSize: 15.5, color: T.ink,
                              fontStyle: r.kind === 'case' ? 'italic' : 'normal',
                            }}>
                              {r.title}
                            </span>
                            {r.citation && (
                              <span style={{ fontFamily: T.serif, fontSize: 13, color: T.faint, marginLeft: 10 }}>
                                {r.citation}
                              </span>
                            )}
                          </button>
                          <span style={{
                            fontFamily: T.sans, fontSize: 10.5, letterSpacing: '0.05em',
                            textTransform: 'uppercase', flexShrink: 0,
                            color: note.there ? T.brass : T.rule,
                          }}>
                            {drawer === 'outlines' ? `${note.text} ${isExpanded ? '▴' : '▾'}` : note.text}
                          </span>
                        </div>

                        {/* The outline, studied in place */}
                        {isExpanded && (
                          <div style={{ padding: '4px 0 16px 40px' }}>
                            {r.outline ? (
                              <>
                                <InteractiveOutline
                                  outline={r.outline}
                                  annotations={r.annotations ?? {}}
                                  library={readings}
                                  currentId={r.id}
                                  onChange={(a) => void saveAnnotations(r, a)}
                                />
                                <button
                                  type="button"
                                  onClick={() => navigate(`/app/student-hub/${r.id}?tab=outline`)}
                                  style={{
                                    appearance: 'none', border: 'none', background: 'none', cursor: 'pointer',
                                    fontFamily: T.sans, fontSize: 11, color: T.faint, padding: 0,
                                  }}
                                >
                                  open the reading →
                                </button>
                              </>
                            ) : outlining === r.id ? (
                              <p style={{ fontFamily: T.mono, fontSize: 12, color: T.faint, margin: '8px 0' }}>
                                Outlining the reading…
                              </p>
                            ) : (
                              <GreenButton onClick={() => void outlineInPlace(r)} disabled={!!outlining}
                                style={{ fontSize: 12, padding: '8px 16px' }}>
                                Prepare the outline
                              </GreenButton>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </section>
        ))}

        {texts && textId && readings.length === 0 && !error && (
          <p style={{ fontFamily: T.mono, fontSize: 12, color: T.faint, padding: '24px 0' }}>
            Opening the table of contents…
          </p>
        )}

        <div style={{ marginTop: 28 }}>
          <Link
            to="/app/student-hub/shelf"
            style={{ fontFamily: T.sans, fontSize: 12, color: T.faint, textDecoration: 'none' }}
          >
            The shelf — loose readings &amp; paste a new one →
          </Link>
        </div>
      </main>
    </div>
  );
}
