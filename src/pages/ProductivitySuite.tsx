import { useNavigate } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';

// The Productivity Suite — a launcher that gathers Grapheon's products in one
// place inside Contextspaces. Each product is ALSO a fully standalone app at its
// own address; this is just a second front door, not a fork. To add a product,
// add one entry to PRODUCTS — `to` for an in-app route, `href` for an external
// standalone app.
interface Product {
  name: string;
  tagline: string;
  accent: string;
  to?: string;
  href?: string;
  status?: string;
}

const PRODUCTS: Product[] = [
  {
    name: 'Discovery',
    tagline: 'Intake, review, tag, Bates-stamp, and produce documents — incoming and outgoing.',
    accent: '#d4a054',
    to: '/discovery',
    status: 'Beta',
  },
  {
    name: 'Connect',
    tagline: 'Live meeting transcription, summarized and filed to the right matter.',
    accent: '#a78bfa',
    to: '/connect',
  },
  {
    name: 'FileSaver',
    tagline: 'Capture files and chats from anywhere and route them into your workspace.',
    accent: '#7dd3fc',
    href: 'https://filesaver-app.vercel.app',
  },
];

export default function ProductivitySuite() {
  const navigate = useNavigate();
  const open = (p: Product) => {
    if (p.to) navigate(p.to);
    else if (p.href) window.open(p.href, '_blank', 'noopener');
  };

  return (
    <div className="max-w-3xl mx-auto px-8 py-12">
      <h1 className="font-display text-[28px] tracking-tight text-white">Productivity Suite</h1>
      <p className="text-[13px] text-white/45 mt-1.5 mb-9">
        Grapheon's tools, gathered in one place. Each is also a standalone product at its own address.
      </p>
      <div className="space-y-3">
        {PRODUCTS.map((p) => (
          <button
            key={p.name}
            onClick={() => open(p)}
            className="group relative flex items-center gap-4 w-full text-left rounded-xl border border-[rgba(255,255,255,0.07)] px-5 py-4 transition-colors hover:border-[rgba(255,255,255,0.16)]"
            style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
          >
            <span
              className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full"
              style={{ backgroundColor: p.accent }}
            />
            <div className="min-w-0 flex-1 pl-2">
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold text-white">{p.name}</span>
                {p.status && (
                  <span
                    className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                    style={{ color: p.accent, backgroundColor: `${p.accent}1a`, border: `1px solid ${p.accent}40` }}
                  >
                    {p.status}
                  </span>
                )}
                {p.href && <span className="text-[10px] text-white/30">standalone&nbsp;↗</span>}
              </div>
              <div className="text-[12.5px] text-white/45 mt-1 leading-snug">{p.tagline}</div>
            </div>
            <ArrowUpRight size={18} className="shrink-0 text-white/25 group-hover:text-white/70 transition-colors" />
          </button>
        ))}
      </div>
    </div>
  );
}
