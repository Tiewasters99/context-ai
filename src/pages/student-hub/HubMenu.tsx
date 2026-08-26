// The hub's front door. Two ways in at the top — your texts, and the shelf
// where a new one arrives — and under them four drawers a student can open
// when they want to know what this room is and what else it reaches.
// Everything here is reading matter: no state, no fetches, no decisions.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { T } from '@/components/student-hub/theme';
import { HubStyles, CaseCaption } from '@/components/student-hub/ui';

type SectionId = 'features' | 'about' | 'resources' | 'integrations';

const FEATURES: { name: string; line: string }[] = [
  {
    name: 'The reading',
    line: 'your own scanned pages or pasted text, with highlights, notes, zoom, and find.',
  },
  {
    name: 'The cold call',
    line: 'a Socratic professor with a real voice; say “I don’t understand” and it teaches until you do.',
  },
  {
    name: 'Case briefs & outlines',
    line: 'prepared from your reading, editable and annotatable; outlines cross-reference your library.',
  },
  {
    name: 'Your assistant',
    line: 'direct answers, study materials, prep sessions; anything you can imagine from your texts.',
  },
  {
    name: 'Study groups',
    line: 'you and up to five classmates around a text, chat and video, within fair use.',
  },
  {
    name: 'Add texts',
    line: 'paste anything, upload a file, or scan a whole chapter; it takes its place on your shelf.',
  },
  {
    name: 'File to Contextspaces',
    line: 'any reading becomes a regular document in your own vault, searchable and reachable over MCP.',
  },
  {
    name: 'Delete for good',
    line: 'removing a text removes the copy itself, stored pages included.',
  },
];

interface ResourceItem {
  links: { label: string; url: string }[];
  note?: string;
}

const RESOURCES: { group: string; items: ResourceItem[] }[] = [
  {
    group: 'Public-domain libraries',
    items: [
      {
        links: [{ label: 'Project Gutenberg', url: 'https://www.gutenberg.org' }],
        note: '75,000+ public-domain books in clean text',
      },
      {
        links: [{ label: 'Standard Ebooks', url: 'https://standardebooks.org' }],
        note: 'beautifully typeset public-domain editions',
      },
      {
        links: [{ label: 'Wikisource', url: 'https://en.wikisource.org' }],
        note: 'transcribed sources and documents',
      },
      {
        links: [
          { label: 'Internet Archive', url: 'https://archive.org' },
          { label: 'Open Library', url: 'https://openlibrary.org' },
        ],
        note: 'scans and controlled lending',
      },
      {
        links: [{ label: 'Faded Page', url: 'https://www.fadedpage.com' }],
        note: 'Canadian public domain; check your own country’s law before downloading',
      },
    ],
  },
  {
    group: 'Law',
    items: [
      {
        links: [{ label: 'Cornell LII', url: 'https://www.law.cornell.edu' }],
        note: 'statutes, rules, and Wex definitions',
      },
      {
        links: [{ label: 'CourtListener', url: 'https://www.courtlistener.com' }],
        note: 'opinions and dockets, free',
      },
      {
        links: [{ label: 'Oyez', url: 'https://www.oyez.org' }],
        note: 'Supreme Court arguments, with audio',
      },
      { links: [{ label: 'Google Scholar case law', url: 'https://scholar.google.com' }] },
    ],
  },
  {
    group: 'Reference & language',
    items: [
      { links: [{ label: 'Merriam-Webster', url: 'https://www.merriam-webster.com' }] },
      {
        links: [{ label: 'Etymonline', url: 'https://www.etymonline.com' }],
        note: 'where words come from',
      },
      {
        links: [{ label: 'Stanford Encyclopedia of Philosophy', url: 'https://plato.stanford.edu' }],
        note: 'serious articles, free',
      },
      { links: [{ label: 'Wikipedia', url: 'https://www.wikipedia.org' }] },
    ],
  },
  {
    group: 'Test prep & standards',
    items: [
      {
        links: [{ label: 'College Board', url: 'https://www.collegeboard.org' }],
        note: 'the official AP and SAT material your assistant can prep against',
      },
      {
        links: [{ label: 'Khan Academy', url: 'https://www.khanacademy.org' }],
        note: 'free courses aligned to them',
      },
    ],
  },
  {
    group: 'Research',
    items: [
      { links: [{ label: 'Google Books', url: 'https://books.google.com' }] },
      { links: [{ label: 'Library of Congress', url: 'https://www.loc.gov' }] },
      { links: [{ label: 'National Archives', url: 'https://www.archives.gov' }] },
      {
        links: [{ label: 'JSTOR', url: 'https://www.jstor.org' }],
        note: 'through your school',
      },
    ],
  },
];

const INTEGRATIONS: { name: string; status: string; line: string }[] = [
  {
    name: 'Contextspaces',
    status: 'available now',
    line: 'File any reading into your vault as a real document — indexed, searchable, connected to any '
      + 'LLM over MCP. More coming: covers from the library, prep sessions on your calendar, briefs on '
      + 'your to-do list, your study playlist.',
  },
  {
    name: 'Miniverse™',
    status: 'coming',
    line: 'Build a small world from what you’re reading — a Fitzgerald Riviera, a Verona balcony — and '
      + 'walk through it with your study group, family and friends.',
  },
];

const groupLabel: React.CSSProperties = {
  fontFamily: T.sans, fontSize: 11, fontWeight: 700,
  letterSpacing: '0.12em', textTransform: 'uppercase', color: T.oxblood,
};

const passage: React.CSSProperties = {
  fontFamily: T.serif, fontSize: 15, lineHeight: 1.65, color: T.ink, margin: '8px 0 18px',
};

const fineprint: React.CSSProperties = {
  fontFamily: T.sans, fontSize: 11.5, color: T.faint, lineHeight: 1.5, margin: '4px 0 6px',
};

/** A prominent way in — the picker row from the texts view, one level up. */
function Doorway({ to, title, hint }: { to: string; title: string; hint?: string }) {
  return (
    <Link
      to={to}
      style={{
        display: 'flex', alignItems: 'baseline', gap: 12, width: '100%',
        padding: '16px 4px', borderBottom: `1px solid ${T.rule}`, textDecoration: 'none',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ color: T.brass, fontFamily: T.serif, flexShrink: 0 }}>§</span>
      <span style={{ fontFamily: T.serif, fontSize: 18, fontStyle: 'italic', color: T.green }}>
        {title}
      </span>
      {hint && (
        <span style={{ fontFamily: T.sans, fontSize: 12, color: T.faint }}>{hint}</span>
      )}
    </Link>
  );
}

/** A drawer of the menu: brass caret, serif green heading, closed to start. */
function Section({ title, isOpen, onToggle, children }: {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        style={{
          appearance: 'none', border: 'none', background: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
          padding: '15px 0 12px', borderBottom: `1px solid ${T.rule}`,
          fontFamily: T.serif, fontSize: 19, fontWeight: 700, color: T.green,
        }}
      >
        <span style={{ color: T.brass, fontSize: 13, width: 12, flexShrink: 0 }}>
          {isOpen ? '▾' : '▸'}
        </span>
        {title}
      </button>
      {isOpen && <div style={{ padding: '10px 0 22px' }}>{children}</div>}
    </section>
  );
}

export default function HubMenu() {
  const [open, setOpen] = useState<Set<SectionId>>(new Set());

  const toggle = (id: SectionId) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="student-hub-root" style={{ background: T.paper, minHeight: '100%' }}>
      <HubStyles />
      <CaseCaption
        kicker="Contextspaces · Student Hub"
        crumbs={[{ label: 'Contextspaces', to: '/app' }, { label: 'Student Hub' }]}
        title="Student Hub"
        citation="The menu."
      />

      <main style={{ maxWidth: 780, margin: '0 auto', padding: '26px 20px 56px' }}>
        {/* ---- The two ways in ---- */}
        <Doorway
          to="/app/student-hub/texts"
          title="Your texts"
          hint="your books and chapters, and every reading under them"
        />
        <Doorway
          to="/app/student-hub/shelf"
          title="The shelf"
          hint="— paste or upload a new text"
        />

        <div style={{ height: 26 }} />

        {/* ---- Features ---- */}
        <Section title="Features" isOpen={open.has('features')} onToggle={() => toggle('features')}>
          {FEATURES.map((f) => (
            <div
              key={f.name}
              style={{
                display: 'flex', gap: 14, flexWrap: 'wrap',
                padding: '11px 0 11px 20px', borderBottom: `1px solid ${T.rule}`,
              }}
            >
              <div style={{
                flex: '0 0 172px', fontFamily: T.serif, fontSize: 15.5,
                fontWeight: 700, color: T.ink,
              }}>
                {f.name}
              </div>
              <div style={{
                flex: '1 1 300px', fontFamily: T.serif, fontSize: 14.5,
                lineHeight: 1.55, color: T.faint,
              }}>
                {f.line}
              </div>
            </div>
          ))}
        </Section>

        {/* ---- About & Philosophy ---- */}
        <Section title="About & Philosophy" isOpen={open.has('about')} onToggle={() => toggle('about')}>
          <div style={{ paddingLeft: 20, maxWidth: 620 }}>
            <div style={groupLabel}>About</div>
            <p style={passage}>
              The Student Hub is a study companion built around your own books. You bring
              your own lawful copy — scanned or pasted — and the hub turns it into a seat
              in class: the reading, the brief, the outline, the cold call, your notes,
              your group. It is in beta.
            </p>
            <div style={groupLabel}>Philosophy</div>
            <p style={passage}>
              Three principles. <strong>Your copy:</strong> everything starts from a book
              you own; the hub never fetches content for you. <strong>Your account:</strong>{' '}
              texts are locked to you; sharing is limited to a small study group, the way
              you’d share a casebook across a library table. <strong>Yours to keep:</strong>{' '}
              the briefs, outlines, transcripts, and presentations you make are your work
              product — take them with you.
            </p>
            <p style={fineprint}>
              Beta — the fine print is still being worked out with actual lawyers.
              (One of them owns this hub.)
            </p>
          </div>
        </Section>

        {/* ---- Resources ---- */}
        <Section title="Resources" isOpen={open.has('resources')} onToggle={() => toggle('resources')}>
          <div style={{ paddingLeft: 20 }}>
            {RESOURCES.map((g) => (
              <div key={g.group} style={{ marginBottom: 20 }}>
                <div style={{ ...groupLabel, color: T.green, marginBottom: 2 }}>{g.group}</div>
                {g.items.map((it) => (
                  <div
                    key={it.links[0].url}
                    style={{
                      display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
                      borderBottom: `1px solid ${T.rule}`, padding: '8px 0',
                    }}
                  >
                    <span style={{ fontFamily: T.serif, fontSize: 15, color: T.ink }}>
                      {it.links.map((l, i) => (
                        <span key={l.url}>
                          {i > 0 && ' / '}
                          <a
                            href={l.url}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: T.green, textDecorationColor: T.rule }}
                          >
                            {l.label}
                          </a>
                        </span>
                      ))}
                    </span>
                    {it.note && (
                      <span style={{ fontFamily: T.serif, fontSize: 13.5, color: T.faint }}>
                        — {it.note}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
            <p style={fineprint}>
              These open in their own tabs. Bringing a text into the hub remains yours to
              do, from your own copy.
            </p>
          </div>
        </Section>

        {/* ---- Integrations ---- */}
        <Section title="Integrations" isOpen={open.has('integrations')} onToggle={() => toggle('integrations')}>
          <div style={{ paddingLeft: 20, maxWidth: 620 }}>
            {INTEGRATIONS.map((r) => (
              <div key={r.name} style={{ borderBottom: `1px solid ${T.rule}`, padding: '12px 0' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: T.serif, fontSize: 16, fontWeight: 700, color: T.ink }}>
                    {r.name}
                  </span>
                  <span style={{
                    fontFamily: T.sans, fontSize: 10.5, letterSpacing: '0.08em',
                    textTransform: 'uppercase', color: T.brass,
                  }}>
                    {r.status}
                  </span>
                </div>
                <p style={{ ...passage, fontSize: 14.5, margin: '5px 0 0' }}>{r.line}</p>
              </div>
            ))}
          </div>
        </Section>
      </main>
    </div>
  );
}
