// A model's answer, set as prose (src/lib/prose.ts parses; this renders React
// elements only — never HTML from the text).

import { blocksOf, type Run } from '@/lib/prose';

// A link is clickable only to this site or its own storage (a download link the
// app minted). Anything else stays text, so a document cannot plant a link in an answer.
const LINK_HOSTS = new Set([
  typeof window !== 'undefined' ? window.location.host : '',
  (() => { try { return new URL(import.meta.env.VITE_SUPABASE_URL).host; } catch { return ''; } })(),
].filter(Boolean));
const linkable = (href: string) => { try { return LINK_HOSTS.has(new URL(href).host); } catch { return false; } };

function Runs({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((r, i) => {
        if (r.href && linkable(r.href)) {
          return <a key={i} href={r.href} target="_blank" rel="noopener noreferrer" className="text-[#e8b84a] underline underline-offset-2 hover:text-[#f3cf75]">{r.text}</a>;
        }
        if (r.href) return <span key={i}>{r.text}</span>;
        if (r.code) return <code key={i} className="px-1 py-px rounded bg-white/[0.08] text-[0.92em]">{r.text}</code>;
        if (r.bold && r.italic) return <strong key={i}><em>{r.text}</em></strong>;
        if (r.bold) return <strong key={i} className="font-semibold text-white">{r.text}</strong>;
        if (r.italic) return <em key={i}>{r.text}</em>;
        return <span key={i}>{r.text}</span>;
      })}
    </>
  );
}

export default function Prose({ text }: { text: string }) {
  const blocks = blocksOf(text);
  return (
    <div className="space-y-2.5">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h':
            return <p key={i} className={`font-semibold text-white ${b.level === 1 ? 'text-[1.08em]' : ''}`}><Runs runs={b.runs} /></p>;
          case 'ul':
            return <ul key={i} className="list-disc pl-5 space-y-1 marker:text-white/35">{b.items.map((it, j) => <li key={j}><Runs runs={it} /></li>)}</ul>;
          case 'ol':
            return <ol key={i} start={b.start} className="list-decimal pl-5 space-y-1 marker:text-white/45">{b.items.map((it, j) => <li key={j}><Runs runs={it} /></li>)}</ol>;
          case 'quote':
            return <blockquote key={i} className="border-l-2 border-[#e8b84a]/40 pl-3 text-white/75 italic"><Runs runs={b.runs} /></blockquote>;
          default:
            return <p key={i}><Runs runs={b.runs} /></p>;
        }
      })}
    </div>
  );
}
