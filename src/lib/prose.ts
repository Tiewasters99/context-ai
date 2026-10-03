// A model's answer, as blocks a person reads: paragraphs, headings, bullet and
// numbered lists, with bold, italic and code runs inside them. The Orchestrator
// used to print the Markdown as typed — asterisks and all. Pure and small on
// purpose: no HTML is ever produced from the text, so nothing in an answer can
// inject markup (src/components/ai/Prose.tsx renders these as React elements).

export type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean };
export type Block =
  | { kind: 'p'; runs: Run[] }
  | { kind: 'h'; level: 1 | 2 | 3; runs: Run[] }
  | { kind: 'ul'; items: Run[][] }
  | { kind: 'ol'; items: Run[][]; start: number }
  | { kind: 'quote'; runs: Run[] };

/** Inline Markdown → runs: `code`, **bold**, *italic* / _italic_. Unclosed markers stay literal. */
export function runsOf(text: string): Run[] {
  const out: Run[] = [];
  const re = /`([^`]+)`|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|(?<![A-Za-z0-9])_([^_\s][^_]*?)_(?![A-Za-z0-9])/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], code: true });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ text: (m[2] ?? m[3])!, bold: true });
    else out.push({ text: (m[4] ?? m[5])!, italic: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** An answer's Markdown → blocks. Lines that are none of the special kinds join into paragraphs. */
export function blocksOf(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ kind: 'p', runs: runsOf(para.join(' ')) }); para = []; } };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flush(); blocks.push({ kind: 'h', level: h[1].length as 1 | 2 | 3, runs: runsOf(h[2]) }); continue; }
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (ul) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'ul') last.items.push(runsOf(ul[1])); else blocks.push({ kind: 'ul', items: [runsOf(ul[1])] });
      continue;
    }
    const ol = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'ol') last.items.push(runsOf(ol[2])); else blocks.push({ kind: 'ol', items: [runsOf(ol[2])], start: Number(ol[1]) });
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { flush(); blocks.push({ kind: 'quote', runs: runsOf(q[1]) }); continue; }
    para.push(line.trim());
  }
  flush();
  return blocks;
}
