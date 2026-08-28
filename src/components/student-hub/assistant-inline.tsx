import type { CSSProperties, ReactNode } from 'react';
import { T } from './theme';

// Inline markdown only — bold, italics, code, links — shared by the block
// renderer (assistant-markdown) and the cold-call transcript, whose numbered
// gutter owns the block structure. Kept apart from any component so React
// fast refresh keeps working on the files that have one.

const codeStyle: CSSProperties = {
  fontFamily: T.mono, fontSize: '0.85em',
  background: 'rgba(28,27,23,0.07)', padding: '1px 4px', borderRadius: 2,
};

/** One line's inline marks: bold, italics, code, links. */
export function inlineMarkdown(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Bold-italic first so ***both*** never reads as bold-with-stray-stars;
  // emphasis spans must not open or close on whitespace.
  const token = new RegExp(
    '\\*\\*\\*([^\\s*](?:[^*]*[^\\s*])?)\\*\\*\\*'
    + '|\\*\\*([^\\s*](?:[^*]*[^\\s*])?)\\*\\*'
    + '|\\*([^\\s*](?:[^*]*[^\\s*])?)\\*'
    + '|\\b_([^_\\n]+)_\\b'
    + '|`([^`\\n]+)`'
    + '|\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)',
    'g',
  );
  let cursor = 0;
  let k = 0;
  for (let m = token.exec(text); m; m = token.exec(text)) {
    if (m.index > cursor) out.push(text.slice(cursor, m.index));
    const key = `${keyBase}-${k++}`;
    if (m[1] !== undefined) {
      out.push(<strong key={key}><em>{inlineMarkdown(m[1], key)}</em></strong>);
    } else if (m[2] !== undefined) {
      out.push(<strong key={key}>{inlineMarkdown(m[2], key)}</strong>);
    } else if (m[3] !== undefined) {
      out.push(<em key={key}>{inlineMarkdown(m[3], key)}</em>);
    } else if (m[4] !== undefined) {
      out.push(<em key={key}>{m[4]}</em>);
    } else if (m[5] !== undefined) {
      out.push(<code key={key} style={codeStyle}>{m[5]}</code>);
    } else {
      out.push(
        <a key={key} href={m[7]} target="_blank" rel="noreferrer noopener" style={{ color: 'inherit' }}>
          {m[6]}
        </a>,
      );
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
