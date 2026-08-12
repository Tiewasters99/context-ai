import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileCheck2 } from 'lucide-react';
import { QuietButton } from '@/components/mediation/ui';
import type { ReactNode } from 'react';

// The Rehearsal Report, rendered as what it is: a clean, linear, lawyerly
// document. The renderer below covers exactly the markdown subset that
// report.ts emits (h1/h2, blockquote, lists, tables, hr, bold/italic) — it is
// a display of our own work product, not a general markdown engine.

/* ------------------------- inline formatting ------------------------- */

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // **bold** and _italic_ (non-nested — all this report uses).
  const re = /\*\*([^*]+)\*\*|_([^_]+)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={`${keyBase}-b${i}`} className="text-white">{m[1]}</strong>);
    else out.push(<em key={`${keyBase}-i${i}`} className="text-white/80">{m[2]}</em>);
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* --------------------------- block parsing --------------------------- */

function renderMarkdown(md: string): ReactNode[] {
  const lines = md.split('\n');
  const blocks: ReactNode[] = [];
  let k = 0;
  let i = 0;

  const key = () => `blk-${k++}`;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    if (line.startsWith('# ')) {
      blocks.push(
        <h1 key={key()} className="text-[24px] sm:text-[28px] font-semibold tracking-tight text-white" style={{ fontFamily: '"Playfair Display Variable", serif' }}>
          {inline(line.slice(2), key())}
        </h1>,
      );
      i += 1; continue;
    }
    if (line.startsWith('## ')) {
      blocks.push(
        <h2 key={key()} className="text-[17px] font-semibold text-[#e8b84a] mt-8 mb-1 pb-1 border-b border-[rgba(212,160,84,0.25)]" style={{ fontFamily: '"Playfair Display Variable", serif' }}>
          {inline(line.slice(3), key())}
        </h2>,
      );
      i += 1; continue;
    }
    if (line.startsWith('> ')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) { quote.push(lines[i].slice(2)); i += 1; }
      blocks.push(
        <blockquote key={key()} className="border-l-2 border-[#d4a054] pl-3.5 py-1 text-[12.5px] text-white/55 leading-relaxed my-3">
          {inline(quote.join(' '), key())}
        </blockquote>,
      );
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
        if (!cells.every((c) => /^-{2,}$/.test(c))) rows.push(cells);
        i += 1;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={key()} className="overflow-x-auto my-3">
          <table className="w-full text-[12px] text-white/75 border-collapse">
            <thead>
              <tr>
                {head?.map((c, ci) => (
                  <th key={ci} className="text-left font-semibold text-[#d4a054] border-b border-[rgba(212,160,84,0.3)] px-2 py-1.5 whitespace-nowrap">{inline(c, `${k}-h${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri} className="border-b border-[rgba(255,255,255,0.05)]">
                  {r.map((c, ci) => <td key={ci} className="px-2 py-1.5 align-top">{inline(c, `${k}-c${ri}-${ci}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\d+\. /.test(line) || line.startsWith('- ')) {
      const ordered = /^\d+\. /.test(line);
      const items: string[] = [];
      while (i < lines.length && (/^\d+\. /.test(lines[i]) || lines[i].startsWith('- ') || lines[i].startsWith('    '))) {
        if (lines[i].startsWith('    ')) {
          items[items.length - 1] = `${items[items.length - 1]}\n${lines[i].trim()}`;
        } else {
          items.push(lines[i].replace(/^\d+\. |^- /, ''));
        }
        i += 1;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      blocks.push(
        <ListTag key={key()} className={`${ordered ? 'list-decimal' : 'list-disc'} pl-5 space-y-1.5 my-2 text-[13px] text-white/75 leading-relaxed`}>
          {items.map((item, ii) => (
            <li key={ii}>
              {item.split('\n').map((part, pi) => (
                <span key={pi} className={pi > 0 ? 'block pl-3 text-white/55 text-[12.5px]' : undefined}>
                  {inline(part, `${k}-li${ii}-${pi}`)}
                </span>
              ))}
            </li>
          ))}
        </ListTag>,
      );
      continue;
    }
    if (line.startsWith('---')) {
      blocks.push(<div key={key()} className="my-5 h-px bg-gradient-to-r from-[rgba(212,160,84,0.4)] to-transparent" />);
      i += 1; continue;
    }

    // Paragraph: gather until blank line.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#|>|\||- |\d+\. |---)/.test(lines[i])) {
      para.push(lines[i]); i += 1;
    }
    blocks.push(
      <p key={key()} className="text-[13.5px] text-white/80 leading-relaxed my-2">
        {inline(para.join(' '), key())}
      </p>,
    );
  }
  return blocks;
}

export default function ReportView({
  markdown, documentId, trialTitle,
}: {
  markdown: string;
  documentId: string | null;
  trialTitle: string;
}) {
  const rendered = useMemo(() => renderMarkdown(markdown), [markdown]);

  const download = () => {
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Rehearsal Report — ${trialTitle}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section aria-label="Rehearsal report">
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {documentId ? (
          <Link
            to={`/app/document/${documentId}`}
            className="inline-flex items-center gap-1.5 text-[12px] text-[#8fd4a0] border border-[rgba(120,210,150,0.3)] rounded-md px-2.5 py-1.5 hover:border-[rgba(120,210,150,0.6)] transition-colors"
          >
            <FileCheck2 size={13} /> Filed into the matter — searchable record
          </Link>
        ) : (
          <span className="text-[12px] text-white/40">Report saved with the rehearsal (matter filing pending).</span>
        )}
        <QuietButton onClick={download}><Download size={13} /> Download .md</QuietButton>
      </div>

      <article
        className="rounded-xl border border-[rgba(212,160,84,0.25)] px-6 py-6 sm:px-8 sm:py-8"
        style={{ backgroundColor: 'rgba(12,11,9,0.9)' }}
      >
        {rendered}
      </article>
    </section>
  );
}
