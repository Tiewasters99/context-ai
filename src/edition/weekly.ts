// The weekly letter ("New Acquisitions"): one Markdown file per week under
// public/weekly/<date>.md, listed in public/weekly/index.json. The Reader
// renders the small Markdown the letters use (headings, paragraphs, lists,
// rules, bold, italics, links) without a library.

export type Week = { date: string; from: string; to: string; title?: string };

export type Inline =
  | { t: 'text'; s: string; b?: boolean; i?: boolean }
  | { t: 'link'; href: string; kids: Inline[] };

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; kids: Inline[] }
  | { t: 'p'; kids: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'hr' };

/** Paths are root-absolute: the letters live beside the app, under /weekly,
 *  whatever path the Reader itself is served from. */
export async function loadWeeklyIndex(): Promise<Week[]> {
  const res = await fetch('/weekly/index.json', { cache: 'no-cache' });
  if (!res.ok) return [];
  const data = (await res.json()) as { weeks?: Week[] };
  return (data.weeks ?? []).slice().sort((a, b) => b.date.localeCompare(a.date));
}

export async function loadWeekly(date: string): Promise<string | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const res = await fetch(`/weekly/${date}.md`, { cache: 'no-cache' });
  return res.ok ? res.text() : null;
}

// ---------------------------------------------------------------------------
// Inline: **bold**, *italic*, ***both***, [text](url). A `*` or `**` toggles;
// the letters never use a literal asterisk.

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let b = false, i = false, buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', s: buf, b: b || undefined, i: i || undefined }); buf = ''; } };
  let k = 0;
  while (k < src.length) {
    const c = src[k];
    if (c === '[') {
      const close = src.indexOf('](', k);
      const end = close >= 0 ? src.indexOf(')', close + 2) : -1;
      if (close > k && end > close) {
        flush();
        const kids = parseInline(src.slice(k + 1, close));
        const href = src.slice(close + 2, end).trim();
        out.push({ t: 'link', href, kids: kids.map((x) => (x.t === 'text' ? { ...x, b: x.b || b || undefined, i: x.i || i || undefined } : x)) });
        k = end + 1;
        continue;
      }
    }
    if (c === '*') {
      flush();
      if (src[k + 1] === '*') { b = !b; k += 2; } else { i = !i; k += 1; }
      continue;
    }
    buf += c;
    k += 1;
  }
  flush();
  return out;
}

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const endPara = () => { if (para.length) { blocks.push({ t: 'p', kids: parseInline(para.join(' ')) }); para = []; } };
  const endList = () => { if (list) { blocks.push({ t: 'ul', items: list.map(parseInline) }); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { endPara(); endList(); blocks.push({ t: 'h', level: h[1].length as 1 | 2 | 3, kids: parseInline(h[2]) }); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { endPara(); endList(); blocks.push({ t: 'hr' }); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { endPara(); (list ??= []).push(li[1]); continue; }
    if (line.trim() === '') { endPara(); endList(); continue; }
    endList();
    para.push(line.trim());
  }
  endPara(); endList();
  return blocks;
}

/** The salutation paragraph: the first paragraph after "Dear Reader," — the
 *  card on the Library page shows it. Falls back to the first paragraph. */
export function teaserOf(md: string): { title: string | null; byline: string | null; teaser: string | null } {
  const blocks = parseMarkdown(md);
  const text = (k: Inline[]): string => k.map((x) => (x.t === 'text' ? x.s : text(x.kids))).join('');
  const h1 = blocks.find((x): x is Extract<Block, { t: 'h' }> => x.t === 'h' && x.level === 1);
  const paras = blocks.filter((x): x is Extract<Block, { t: 'p' }> => x.t === 'p').map((p) => text(p.kids));
  const byline = paras.find((p) => /compliments|from the library/i.test(p)) ?? null;
  const dear = paras.findIndex((p) => /^dear reader/i.test(p));
  const teaser = dear >= 0 ? paras[dear + 1] ?? null : paras.find((p) => p.length > 80) ?? null;
  return { title: h1 ? text(h1.kids) : null, byline, teaser };
}

/** "filed in the Library (Law) on 2026-10-27." → 2026-10-27 */
export function filedOn(rightsNote: string | null | undefined): string | null {
  const m = /\bon (\d{4}-\d{2}-\d{2})\b/.exec(rightsNote ?? '');
  return m?.[1] ?? null;
}
