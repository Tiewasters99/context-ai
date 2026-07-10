import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { medApi, statusLabel, formatDateLong, mediatorMonogram } from '@/lib/mediation';
import type { MediatorModelInfo, DocketCase } from '@/lib/mediation';
import { GoldButton, QuietButton, Working, Notice, PageHead } from '@/components/mediation/ui';

// The Contextspaces Mediation Center hub — About / Mediators / Lawyers Panel,
// plus the signed-in visitor's docket of mediations. Ported from Grapheon
// Mediation and rebranded; the procedure is unchanged.

type TabKey = 'about' | 'mediators' | 'lawyers';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'about', label: 'About' },
  { key: 'mediators', label: 'Mediators' },
  { key: 'lawyers', label: 'Lawyers Panel' },
];

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/** The procedure, station by station — the path on the About tab. */
const JOURNEY: { title: string; body: string }[] = [
  {
    title: 'Registration',
    body: 'One party registers the matter and receives an invite code for the other side. Each side pays its own registration fee.',
  },
  {
    title: 'Initial summaries',
    body: 'Each party files a 500-word summary of the dispute — enough for the mediator to know the shape of the matter.',
  },
  {
    title: 'Fixing the day',
    body: 'Each side privately selects three days from a two-month calendar. Where the selections overlap, the mediation day is set.',
  },
  {
    title: 'Positions & demands',
    body: 'Each party files a position summary of up to five pages, together with its demand.',
  },
  {
    title: 'The legal framework',
    body: 'The mediator reads both positions and issues one neutral statement of the governing law and standard — the same document to both sides.',
  },
  {
    title: 'Written analyses',
    body: 'Each party responds with an analysis of up to ten pages, arguing its position under that shared framework.',
  },
  {
    title: 'Confidential assessment',
    body: 'Before the day, each party confers privately with the mediator — a frank conversation about strengths, weaknesses, and what a good outcome looks like.',
  },
  {
    title: 'Mediation day',
    body: 'The parties convene in the Mediation Center: a common room, then thirty-minute breakout caucuses. The mediator shuttles between the rooms, carrying only what each side has authorized.',
  },
  {
    title: 'Settlement draft',
    body: 'When terms are accepted, the mediator drafts the settlement agreement for both parties to review.',
  },
  {
    title: 'The human signature',
    body: 'A licensed attorney on the Contextspaces panel reviews and documents the final agreement. No settlement leaves the Center without a human lawyer’s hand on it.',
  },
];

export default function MediationCenter() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const tabParam = (searchParams.get('tab') || 'about') as TabKey;
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? tabParam : 'about';
  const selectTab = (key: TabKey) => {
    navigate(key === 'about' ? '/app/mediation' : `/app/mediation?tab=${key}`, { replace: true });
  };

  // The mediator panel.
  const [models, setModels] = useState<MediatorModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState('');
  useEffect(() => {
    let cancelled = false;
    medApi<{ models: MediatorModelInfo[] }>('models.list')
      .then((d) => { if (!cancelled) setModels(d.models); })
      .catch((e) => { if (!cancelled) setModelsError(e instanceof Error ? e.message : 'The panel could not be convened.'); });
    return () => { cancelled = true; };
  }, []);

  // Your mediations — the docket.
  const [docket, setDocket] = useState<DocketCase[]>([]);
  useEffect(() => {
    let cancelled = false;
    medApi<{ cases: DocketCase[] }>('cases.list')
      .then((d) => { if (!cancelled) setDocket(d.cases || []); })
      .catch(() => { /* the docket is a courtesy — the page stands without it */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="max-w-3xl mx-auto px-8 py-12">
      <PageHead
        kicker="Contextspaces"
        title="Mediation Center"
        lede="A dispute resolved in weeks, not years — conducted by an AI mediator, documented by a human attorney."
      />

      <div className="flex flex-wrap gap-3 mb-10">
        <Link to="/app/mediation/register">
          <GoldButton>Register a mediation</GoldButton>
        </Link>
        <Link to="/app/mediation/join">
          <QuietButton>Join with an invite code</QuietButton>
        </Link>
      </div>

      {/* Your mediations */}
      {docket.length > 0 && (
        <section className="mb-10" aria-label="Your mediations">
          <h2 className="text-[11px] uppercase tracking-wider text-white/50 mb-2.5">Your mediations</h2>
          <ol className="space-y-2">
            {docket.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/app/mediation/case/${c.id}`}
                  className="flex items-center justify-between gap-4 rounded-lg border border-[rgba(255,255,255,0.07)] px-4 py-3 hover:border-[rgba(212,160,84,0.4)] transition-colors"
                  style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
                >
                  <span className="text-[13.5px] text-white truncate">{c.title}</span>
                  <span className="flex items-center gap-3 shrink-0 text-[12px]">
                    <span className="text-[#d4a054]">{statusLabel(c.status)}</span>
                    {c.scheduled_date && <span className="text-white/40">{formatDateLong(c.scheduled_date)}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Tabs */}
      <nav className="flex gap-1 mb-8 border-b border-[rgba(255,255,255,0.08)]" aria-label="Mediation sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => selectTab(t.key)}
            aria-current={tab === t.key ? 'page' : undefined}
            className={`px-4 py-2.5 text-[13px] -mb-px border-b-2 transition-colors ${
              tab === t.key
                ? 'border-[#d4a054] text-white font-medium'
                : 'border-transparent text-white/50 hover:text-white/80'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* ================= ABOUT ================= */}
      {tab === 'about' && (
        <section>
          <p className="text-[14px] text-white/70 leading-relaxed max-w-xl">
            The Contextspaces Mediation Center puts a tireless, impartial mediator at the center
            of your dispute — an AI trained for the work, holding each side&rsquo;s confidences
            absolutely — and a licensed attorney at the end of it, reviewing and documenting
            whatever the parties agree. The procedure is fixed, the writings are short, and the
            whole matter moves at the speed the parties can write.
          </p>

          <h2 className="text-[11px] uppercase tracking-wider text-white/50 mt-9 mb-4">The path of a mediation</h2>
          <ol className="space-y-5">
            {JOURNEY.map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <span
                  className="shrink-0 w-9 text-right text-[15px] text-[#d4a054]"
                  style={{ fontFamily: '"Playfair Display Variable", serif' }}
                >
                  {ROMAN[i]}
                </span>
                <div>
                  <h3 className="text-[14px] font-medium text-white">{step.title}</h3>
                  <p className="text-[13px] text-white/50 leading-relaxed mt-0.5 max-w-lg">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-[rgba(255,255,255,0.07)] p-5" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
              <h3 className="text-[13.5px] font-semibold text-white mb-2">The registration fee</h3>
              <p className="text-[12.5px] text-white/50 leading-relaxed">
                Each side pays its own registration fee of $250 — two fees per mediation, and the
                whole of the cost. There are no hourly charges and no per-session billing.
              </p>
            </div>
            <div className="rounded-lg border border-[rgba(255,255,255,0.07)] p-5" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
              <h3 className="text-[13.5px] font-semibold text-white mb-2">The confidentiality promise</h3>
              <p className="text-[12.5px] text-white/50 leading-relaxed">
                What you tell the mediator privately is never shared with the other side without
                your consent. Not summarized, not hinted at, not &ldquo;factored in.&rdquo; The
                mediator carries across the corridor only what you have expressly authorized it
                to carry.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* ================= MEDIATORS ================= */}
      {tab === 'mediators' && (
        <section>
          <p className="text-[14px] text-white/70 leading-relaxed max-w-xl">
            Every mediator on the panel is trained on the same Contextspaces Mediation Skill —
            one professional playbook governing procedure, confidentiality, and the conduct of
            the day. In choosing a mediator you choose a temperament and a provider, never a
            different process.
          </p>
          {modelsError && <Notice>{modelsError}</Notice>}
          {!models && !modelsError && <div className="mt-6"><Working>Convening the panel…</Working></div>}
          {models && (
            <ul className="mt-7 space-y-3">
              {models.map((m) => (
                <li
                  key={m.id}
                  className={`flex items-start gap-4 rounded-lg border border-[rgba(255,255,255,0.07)] px-5 py-4 ${!m.available ? 'opacity-55' : ''}`}
                  style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
                >
                  <span
                    className="shrink-0 flex items-center justify-center w-10 h-10 rounded-full border border-[rgba(212,160,84,0.45)] text-[13px] text-[#d4a054]"
                    style={{ fontFamily: '"Playfair Display Variable", serif' }}
                    aria-hidden="true"
                  >
                    {mediatorMonogram(m.label)}
                  </span>
                  <div>
                    <h3 className="text-[14px] font-semibold text-white">{m.label}</h3>
                    <p className="text-[11.5px] text-white/40 mt-0.5">
                      {m.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                      {!m.available && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider text-[#d4a054] border border-[rgba(212,160,84,0.4)] rounded-full px-2 py-0.5">
                          joining the panel soon
                        </span>
                      )}
                    </p>
                    <p className="text-[12.5px] text-white/55 mt-1.5 leading-relaxed">{m.blurb}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ================= LAWYERS PANEL ================= */}
      {tab === 'lawyers' && (
        <section>
          <p className="text-[14px] text-white/70 leading-relaxed max-w-xl">
            The mediation is conducted by AI; the settlement is signed into the world by people.
            Every agreement reached in the Center is reviewed and documented by a licensed
            attorney of the Contextspaces panel — a practicing lawyer who reads the draft,
            confirms it says what the parties meant, and puts it in the form the courts expect.
          </p>
          <div className="mt-7 space-y-4">
            {[
              ['Review and documentation.', 'A panel attorney examines each settlement draft and prepares the final, executable agreement.'],
              ['Private consultation.', 'Panel attorneys are also available to either party for private consultations alongside the AI mediation — your own counsel, on your own side of the corridor.'],
              ['The human guarantee.', 'No settlement leaves the Mediation Center on the strength of a model alone.'],
            ].map(([head, text]) => (
              <div key={head} className="flex gap-3">
                <span className="text-[#d4a054] text-[11px] mt-1">◆</span>
                <p className="text-[13px] text-white/60 leading-relaxed max-w-lg">
                  <strong className="text-white/90 font-medium">{head}</strong> {text}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-8">
            <a href="mailto:mediation@contextspaces.ai">
              <GoldButton>Contact the panel</GoldButton>
            </a>
          </p>
        </section>
      )}
    </div>
  );
}
