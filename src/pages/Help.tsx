// /help — the field guide, for a person to read.
//
// The same entries the Orchestrator looks up (lib/orchestrator-guide.mjs),
// drawn as one page: a search box, then every entry under its room. One
// source, two readers, so the help a person reads and the help the
// Orchestrator gives never disagree (Eden, 2026-11-04: "we should also
// build in a human help"). Public, like /support, so a link to it works
// from a Word pane, an email or a search result without signing in; a few
// rooms depend on the plan, and the page says so once.
//
// Same chrome and voice as Support, Privacy and Terms.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Search } from 'lucide-react';
import { GUIDE, ROOMS, guideTokens, lookupGuide } from '../../lib/orchestrator-guide.mjs';

const serif = { fontFamily: '"Playfair Display Variable", serif' } as const;

export default function Help() {
  const [q, setQ] = useState('');
  const typed = q.trim();
  // A question narrows the page to its best answers; otherwise every entry, by
  // room. The first keystrokes are not a question yet — the whole page stays
  // until a word is there, so "s", "se", "sel" never flash "nothing answers that".
  const query = guideTokens(typed).length > 0 && typed.length >= 3 ? typed : '';
  const shown = useMemo(() => (query ? lookupGuide(query, undefined, 12) : GUIDE), [query]);
  const rooms = ROOMS.filter((r) => shown.some((e) => e.room === r));

  return (
    <div className="min-h-screen bg-black text-[#e8e4de]">
      <div className="max-w-2xl mx-auto px-5 sm:px-8 py-10">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] text-[#8a8694] hover:text-[#e8e4de] transition-colors mb-10">
          <ArrowLeft size={14} /> Equazia.ai
        </Link>

        <header className="mb-8">
          <h1 className="text-[34px] sm:text-[42px] leading-[1.05] font-semibold tracking-tight text-white" style={serif}>Help</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-[#b8b4be]">
            How Equazia.ai works, room by room. The Orchestrator — the round button in the corner of every
            screen — answers from these same pages, so ask it there, or read here. A few rooms depend on your plan.
          </p>
        </header>

        <label className="relative block mb-10">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8a8694]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ask a question — “how do I move documents into a folder”"
            aria-label="Search the help"
            className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.03)] text-[14px] text-white placeholder-[#5a5665] focus:outline-none focus:ring-1 focus:ring-[#e8b84a]"
          />
        </label>

        {query && shown.length === 0 && (
          <p className="text-[15px] text-[#b8b4be] mb-10">
            Nothing here answers that yet. Ask the Orchestrator inside the app — it passes the gap to the team — or
            write to{' '}
            <a href="mailto:info@equazia.ai?subject=Help" className="text-[#e8e4de] underline underline-offset-2">info@equazia.ai</a>.
          </p>
        )}

        {query ? (
          // A question's answers in the order they match, best first, each
          // saying which room it belongs to — not regrouped by room, which
          // would put the best answer wherever its room happens to fall.
          <section className="mb-10 space-y-6">
            {shown.map((e) => (
              <article key={e.id} id={e.id} className="scroll-mt-6">
                <div className="text-[11px] uppercase tracking-[0.08em] text-[#5a5665] mb-1">{e.room}</div>
                <h3 className="text-[16px] font-medium text-[#e8e4de] mb-1.5">
                  <a href={`#${e.id}`} className="hover:text-[#e8b84a] transition-colors">{e.title}</a>
                </h3>
                <p className="text-[15px] leading-relaxed text-[#b8b4be]">{e.text}</p>
              </article>
            ))}
          </section>
        ) : rooms.map((room) => (
          <section key={room} className="mb-10">
            <h2 className="text-[20px] font-semibold text-white mb-4" style={serif}>{room}</h2>
            <div className="space-y-6">
              {shown.filter((e) => e.room === room).map((e) => (
                <article key={e.id} id={e.id} className="scroll-mt-6">
                  <h3 className="text-[16px] font-medium text-[#e8e4de] mb-1.5">
                    <a href={`#${e.id}`} className="hover:text-[#e8b84a] transition-colors">{e.title}</a>
                  </h3>
                  <p className="text-[15px] leading-relaxed text-[#b8b4be]">{e.text}</p>
                </article>
              ))}
            </div>
          </section>
        ))}

        <p className="mt-12 text-[12px] text-[#5a5665]">
          See also: <Link to="/support" className="text-[#8a8694] underline underline-offset-2">Support</Link> ·{' '}
          <Link to="/privacy" className="text-[#8a8694] underline underline-offset-2">Privacy</Link> ·{' '}
          <Link to="/terms" className="text-[#8a8694] underline underline-offset-2">Terms of Service</Link>.
        </p>
      </div>
    </div>
  );
}
