import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { surfacePresentation, type SurfaceId } from '@/lib/plan';

// The Productivity Suite — a launcher that gathers Grapheon's products in one
// place inside Contextspaces. Each product is ALSO a fully standalone app at its
// own address; this is just a second front door, not a fork. To add a product,
// add one entry to PRODUCTS — `to` for an in-app route, `href` for an external
// standalone app.
//
// `surface` names the entry in lib/plan.ts that decides who sees the tile.
// Core products show for everyone; frozen ones are absent unless the account
// is on the workshop plan; beta ones are listed but not enterable. Nothing
// about that decision lives in this file — change the tier in lib/plan.ts.
interface Product {
  name: string;
  tagline: string;
  accent: string;
  surface: SurfaceId;
  to?: string;
  href?: string;
  status?: string;
}

const PRODUCTS: Product[] = [
  {
    name: 'Calendar',
    tagline: 'Deadlines, entries and list due dates across every matter, in one view — with Google Calendar imports. Pin it to the canvas to keep the day\u2019s shape up beside your work.',
    accent: '#8fd3c8',
    to: '/app/calendar',
    surface: 'calendar',
  },
  {
    name: 'The Office',
    tagline: 'The public face of your workspace: a walkable, photoreal office. Drag documents onto its shelves and practice areas — visitors browse the library; nothing leaves the vault.',
    accent: '#d8b87a',
    to: '/app/office',
    surface: 'office',
    status: 'New',
  },
  {
    name: 'The Contextspaces Editor',
    tagline: 'Hand over any AI draft — brief, memo, letter. The Editor improves, clarifies and polishes until the writing is clear, direct and logical, and every change returns as a redline.',
    accent: '#c96852',
    to: '/app/editor',
    surface: 'editor',
    status: 'The desk is open',
  },
  {
    name: 'Agents',
    tagline: 'A team of agents you write. A charter says what the job is, a toolset says exactly what it may touch, and a trigger says when it runs — every run recorded in the matter’s ledger.',
    accent: '#8fb8de',
    to: '/app/agents',
    surface: 'agents',
    status: 'New',
  },
  {
    name: 'Bucketizer',
    tagline: 'Your case theory as a living tree — every document classified against the elements you must prove. AI-proposed, attorney-confirmed.',
    accent: '#34d399',
    to: '/app/bucketizer',
    surface: 'bucketizer',
    status: 'New',
  },
  {
    name: 'Moot Bench',
    tagline: 'Oral-argument prep: hand up the briefs, take a bench memo, then stand for questioning by a hot AI bench. Share the transcript with the team.',
    accent: '#e8b84a',
    to: '/app/moot-bench',
    surface: 'mootBench',
    status: 'New',
  },
  {
    name: 'Student Hub',
    tagline: 'Scan your casebook, take the brief and the outline, then sit for a spoken Socratic cold call — before your professor gets the chance.',
    accent: '#A98B45',
    to: '/app/student-hub',
    surface: 'studentHub',
    status: 'New',
  },
  {
    name: 'Mediation Center',
    tagline: 'A tireless, impartial AI mediator at the center of your dispute, holding each side\u2019s confidences — and a licensed attorney at the end, reviewing and documenting what the parties agree.',
    accent: '#c9a0dc',
    to: '/app/mediation',
    surface: 'mediation',
  },
  {
    name: 'Discovery',
    tagline: 'Intake, review, tag, Bates-stamp, and produce documents — incoming and outgoing.',
    accent: '#d4a054',
    to: '/discovery',
    surface: 'discovery',
    status: 'Beta',
  },
  {
    name: 'Connect',
    tagline: 'Live meeting transcription, summarized and filed to the right matter.',
    accent: '#a78bfa',
    to: '/connect',
    surface: 'connect',
  },
  {
    name: 'FileSaver',
    tagline: 'Capture files and chats from anywhere and route them into your workspace.',
    accent: '#7dd3fc',
    href: 'https://filesaver.ai',
    surface: 'fileSaver',
  },
];

export default function ProductivitySuite() {
  const navigate = useNavigate();
  const { plan, planLoading } = useAuth();

  const open = (p: Product) => {
    if (p.to) navigate(p.to);
    else if (p.href) window.open(p.href, '_blank', 'noopener');
  };

  // Frozen products drop out of the list entirely; beta ones stay, labelled.
  // Nothing renders until the plan is known, so a tile never appears and then
  // disappears under the cursor.
  const shown = useMemo(
    () =>
      PRODUCTS.map((p) => ({ product: p, show: surfacePresentation(p.surface, plan) })).filter(
        (row) => row.show !== 'hidden',
      ),
    [plan],
  );

  return (
    <div className="max-w-3xl mx-auto px-8 py-12">
      <h1 className="font-display text-[28px] tracking-tight text-white">Productivity Suite</h1>
      <p className="text-[13px] text-white/45 mt-1.5 mb-9">
        Every room in Contextspaces, gathered in one place. Several are also standalone products at their own address.
      </p>
      <div className="space-y-3">
        {planLoading
          ? null
          : shown.map(({ product: p, show }) => {
              const body = (
                <>
                  <span
                    className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full"
                    style={{ backgroundColor: p.accent }}
                  />
                  <div className="min-w-0 flex-1 pl-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[15px] font-semibold text-white">{p.name}</span>
                      {show === 'beta' ? (
                        <span
                          className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                          style={{ color: p.accent, backgroundColor: `${p.accent}1a`, border: `1px solid ${p.accent}40` }}
                        >
                          Beta — coming
                        </span>
                      ) : (
                        p.status && (
                          <span
                            className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                            style={{ color: p.accent, backgroundColor: `${p.accent}1a`, border: `1px solid ${p.accent}40` }}
                          >
                            {p.status}
                          </span>
                        )
                      )}
                      {show === 'open' && p.href && (
                        <span className="text-[10px] text-white/30">standalone&nbsp;↗</span>
                      )}
                    </div>
                    <div className="text-[12.5px] text-white/45 mt-1 leading-snug">{p.tagline}</div>
                  </div>
                </>
              );

              // A beta tile is a name on the list, not a door: no click, no
              // hover lift, no arrow, and the route redirects anyway.
              if (show === 'beta') {
                return (
                  <div
                    key={p.name}
                    aria-disabled="true"
                    title={`${p.name} is in beta — not open yet.`}
                    className="relative flex items-center gap-4 w-full text-left rounded-xl border border-[rgba(255,255,255,0.05)] px-5 py-4 opacity-55"
                    style={{ backgroundColor: 'rgba(8,8,14,0.55)' }}
                  >
                    {body}
                  </div>
                );
              }

              return (
                <button
                  key={p.name}
                  onClick={() => open(p)}
                  className="group relative flex items-center gap-4 w-full text-left rounded-xl border border-[rgba(255,255,255,0.07)] px-5 py-4 transition-colors hover:border-[rgba(255,255,255,0.16)]"
                  style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
                >
                  {body}
                  <ArrowUpRight size={18} className="shrink-0 text-white/25 group-hover:text-white/70 transition-colors" />
                </button>
              );
            })}
      </div>
    </div>
  );
}
