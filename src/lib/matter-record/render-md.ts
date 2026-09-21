// The Matter Record as markdown.
//
// A paralegal with no AI tool and no Contextspaces login must be able to read
// this file, so it is plain markdown with plain tables. The layout lives in
// layout.ts; this file only knows how to draw the blocks.
//
// Deterministic: same document model in, same bytes out.

import type { MatterRecordDoc } from './assemble';
import { matterRecordBlocks, type Block } from './layout';

/** Markdown-safe table cell: one line, pipes escaped, never empty. */
export function cell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim() || '—';
}

function table(headers: string[], rows: string[][]): string[] {
  const out: string[] = [`| ${headers.map(cell).join(' | ')} |`];
  out.push(`|${headers.map(() => '---').join('|')}|`);
  for (const row of rows) out.push(`| ${row.map(cell).join(' | ')} |`);
  return out;
}

function renderBlock(block: Block): string[] {
  switch (block.type) {
    case 'title':
      return [`# ${block.text}`];
    case 'h2':
      return [`## ${block.text}`];
    case 'h3':
      return [`### ${block.text}`];
    case 'legend':
      return [`**${block.text}**`];
    case 'p':
      return [block.text];
    case 'note':
      return [`> **${block.text}**`];
    case 'quote':
      return block.text.split(/\r?\n/).map((line) => `> ${line.trim()}`);
    case 'bullets':
      return block.items.map((item) => `- ${item}`);
    case 'pairs':
      return table(['Field', 'Value'], block.rows.map(([k, v]) => [k, v]));
    case 'table':
      return table(block.headers, block.rows);
    default:
      return [];
  }
}

/** The whole Matter Record as one markdown string, ending in a newline. */
export function renderMatterRecordMarkdown(doc: MatterRecordDoc): string {
  const lines: string[] = [];
  for (const block of matterRecordBlocks(doc)) {
    lines.push(...renderBlock(block));
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
