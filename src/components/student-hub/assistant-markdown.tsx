import type { ReactNode } from 'react';
import { T } from './theme';
import { inlineMarkdown } from './assistant-inline';

// The assistant writes markdown, as models do. Rendering it is the courtesy
// every chat surface owes its reader: **bold** reads bold, a list reads as a
// list, and no asterisk survives to the page. Everything here builds React
// nodes — no HTML string ever touches the DOM. Inline marks come from
// assistant-inline; this file owns the block structure.

type Block =
  | { kind: 'p' | 'quote'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'pre'; text: string };

const UL_ITEM = /^\s{0,3}[-*•]\s+(.*)$/;
const OL_ITEM = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^(#{1,4})\s+(.*)$/;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (line.trim().startsWith('```')) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++]);
      i += 1; // past the closing fence, if it ever arrived
      blocks.push({ kind: 'pre', text: body.join('\n') });
      continue;
    }
    const h = line.match(HEADING);
    if (h) { blocks.push({ kind: 'h', level: h[1].length, text: h[2] }); i += 1; continue; }
    if (UL_ITEM.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL_ITEM.test(lines[i])) items.push(lines[i++].match(UL_ITEM)![1]);
      blocks.push({ kind: 'ul', items });
      continue;
    }
    if (OL_ITEM.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL_ITEM.test(lines[i])) items.push(lines[i++].match(OL_ITEM)![1]);
      blocks.push({ kind: 'ol', items });
      continue;
    }
    if (line.trimStart().startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
      }
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }
    // A paragraph runs to the next blank line or structural line; its own
    // line breaks are kept — the assistant quotes verse, and verse breaks.
    const para: string[] = [];
    while (
      i < lines.length && lines[i].trim()
      && !UL_ITEM.test(lines[i]) && !OL_ITEM.test(lines[i])
      && !HEADING.test(lines[i]) && !lines[i].trimStart().startsWith('>')
      && !lines[i].trim().startsWith('```')
    ) para.push(lines[i++]);
    blocks.push({ kind: 'p', lines: para });
  }
  return blocks;
}

function brokenLines(ls: string[], keyBase: string): ReactNode[] {
  return ls.flatMap((l, j) => {
    const parts = inlineMarkdown(l, `${keyBase}-${j}`);
    return j < ls.length - 1 ? [...parts, <br key={`${keyBase}-br${j}`} />] : parts;
  });
}

/** Assistant text as it should read — typeset, not annotated. Font and color
 *  come from the surrounding element, so every surface keeps its own voice. */
export function AssistantProse({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        const last = i === blocks.length - 1;
        const gap = last ? 0 : '0.6em';
        switch (b.kind) {
          case 'h':
            return (
              <div key={key} style={{ fontWeight: 700, fontSize: b.level <= 2 ? '1.05em' : '1em', margin: `0 0 ${last ? 0 : '0.35em'}` }}>
                {inlineMarkdown(b.text, key)}
              </div>
            );
          case 'ul':
            return (
              <ul key={key} style={{ margin: `0 0 ${gap}`, paddingLeft: '1.35em' }}>
                {b.items.map((it, j) => <li key={j} style={{ margin: '0.15em 0' }}>{inlineMarkdown(it, `${key}-${j}`)}</li>)}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key} style={{ margin: `0 0 ${gap}`, paddingLeft: '1.35em' }}>
                {b.items.map((it, j) => <li key={j} style={{ margin: '0.15em 0' }}>{inlineMarkdown(it, `${key}-${j}`)}</li>)}
              </ol>
            );
          case 'quote':
            return (
              <div key={key} style={{ borderLeft: `2px solid ${T.brass}`, padding: '1px 0 1px 10px', fontStyle: 'italic', margin: `0 0 ${gap}` }}>
                {brokenLines(b.lines, key)}
              </div>
            );
          case 'pre':
            return (
              <pre key={key} style={{
                fontFamily: T.mono, fontSize: '0.8em', lineHeight: 1.5, overflowX: 'auto',
                background: 'rgba(28,27,23,0.05)', padding: '8px 10px', borderRadius: 2, margin: `0 0 ${gap}`,
              }}>
                {b.text}
              </pre>
            );
          default:
            return <p key={key} style={{ margin: `0 0 ${gap}` }}>{brokenLines(b.lines, key)}</p>;
        }
      })}
    </div>
  );
}
