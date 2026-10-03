// A deposition cite — "De Camara Dep. Vol. I 63:21–64:2", "Alder Dep. 135:1–10",
// "Gebauer Dep. 61:14–16", "Walters Dep. 124–25" — to the page of the appendix
// that carries that transcript page (Eden, 09-28: 32 such cites in the
// DeCamara brief name no A-page, and "the system doesn't pick it up").
//
// The appendix's indexed text knows a sheet's TRANSCRIPT page numbers (a
// condensed transcript files four printed pages per sheet) but not whose
// deposition the sheet belongs to; the header that says so is a picture. The
// map from deponent to sheet is the appendix builder's PAGE MAP, a CSV it
// writes when it stamps the volumes (columns: a_page, volume, pdf_page_in_volume,
// deponent, version, tr_pages). Filed in the appendix's matter, the desk reads
// it. No map, and the desk says what to file. Deterministic: no model.

export interface DepoCite {
  /** The deponent as the brief names them: "De Camara", "Richards-Cordell", "Zaparzynski 30(b)(6)". */
  deponent: string;
  /** "I" → 1; null when the cite names none. */
  volume: number | null;
  page: number;
  line: number | null;
  endPage: number | null;
  endLine: number | null;
  /** A date in the cite, "(Mar. 4, 2026)", kept for the caveat. */
  date: string | null;
}

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50 };
export function romanToInt(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  const t = s.toLowerCase();
  if (!/^[ivxl]+$/.test(t)) return null;
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const v = ROMAN[t[i]];
    const next = ROMAN[t[i + 1]] ?? 0;
    n += v < next ? -v : v;
  }
  return n;
}

/**
 * The cite's parts, or null when the text is not a deposition cite. Accepts a
 * leading "(citing " / "see ", a 30(b)(6) tag, "Dep." / "Depo." / "Deposition"
 * / "Dep. Tr.", a date in parentheses, "Vol. I" / "Volume 2", "at", and a
 * page, page:line, page–page or page:line–page:line span.
 */
export function parseDepoCite(text: string): DepoCite | null {
  const re = /^\s*\(?\s*(?:(?:citing|see|see also|quoting|cf\.|accord)\s+)?(?<name>[A-Z][\w'’.\-]*(?:\s+(?:de|De|van|Van|von|Von|La|Le|Di|Da|Mc|O')?\s*[A-Z][\w'’.\-]*)*?)(?<rule>\s+30\(b\)\(6\))?\s+(?:Dep(?:o|osition)?\.?|Tr\.)(?:\s+Tr\.)?\s*(?:\((?<date>[^)]{4,40})\)\s*)?(?:,?\s*Vol(?:ume)?\.?\s*(?<vol>[IVXLivxl]+|\d+)\s*[,:.]?\s*)?(?:at\s+)?(?<page>\d{1,4})(?::(?<line>\d{1,3}))?(?:\s*[–—-]+\s*(?:(?<page2>\d{1,4}):)?(?<tail>\d{1,4}))?\s*[.,;)]*\s*(?:\([^)]*\)\s*)?$/u;
  const m = re.exec(text);
  if (!m?.groups) return null;
  const g = m.groups;
  const page = Number(g.page);
  const line = g.line ? Number(g.line) : null;
  let endPage: number | null = null;
  let endLine: number | null = null;
  if (g.tail) {
    if (g.page2) { endPage = Number(g.page2); endLine = Number(g.tail); }
    else if (line !== null) { endLine = Number(g.tail); }
    else {
      // "124–25" is pages 124 to 125: the short form borrows the leading digits.
      const a = g.page; const b = g.tail;
      endPage = b.length < a.length ? Number(a.slice(0, a.length - b.length) + b) : Number(b);
      if (endPage < page) endPage = null;
    }
  }
  const vol = g.vol ? romanToInt(g.vol) : null;
  return {
    deponent: (g.name + (g.rule ? ' 30(b)(6)' : '')).replace(/\s+/g, ' ').trim(),
    volume: vol,
    page, line, endPage, endLine,
    date: g.date?.trim() ?? null,
  };
}

/** One sheet of the appendix, from the builder's page map. */
export interface PageMapRow {
  a_page: number;
  volume: string;        // "VI"
  pdf_page: number | null;
  deponent: string;      // "Lauren De Camara, Vol. I"
  version: string;       // "certified" | "rough" | "final" | ""
  tr_pages: string;      // "62-65" | "63" | ""
}

/** The page map's CSV → rows. Columns by header name; quoted fields honoured. */
export function parsePageMap(csv: string): PageMapRow[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (names: string[]) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const iA = col(['a_page', 'a', 'page', 'ja']);
  const iVol = col(['volume', 'vol']);
  const iPdf = col(['pdf_page_in_volume', 'pdf_page', 'pdf']);
  const iDep = col(['deponent', 'witness', 'source']);
  const iVer = col(['version']);
  const iTr = col(['tr_pages', 'transcript_pages', 'tr']);
  if (iA < 0 || iDep < 0 || iTr < 0) return [];
  const rows: PageMapRow[] = [];
  for (const line of lines.slice(1)) {
    const f = split(line);
    const a = Number(f[iA]);
    if (!Number.isFinite(a) || a <= 0) continue;
    const pdf = iPdf >= 0 ? Number(f[iPdf]) : NaN;
    rows.push({
      a_page: a,
      volume: iVol >= 0 ? (f[iVol] ?? '').trim() : '',
      pdf_page: Number.isFinite(pdf) && pdf > 0 ? pdf : null,
      deponent: (f[iDep] ?? '').trim(),
      version: iVer >= 0 ? (f[iVer] ?? '').trim() : '',
      tr_pages: (f[iTr] ?? '').trim(),
    });
  }
  return rows;
}

/** "62-65" / "63" / "62, 64-65" covers `n`? */
export function coversPage(tr: string, n: number): boolean {
  for (const part of tr.split(/[;,]/)) {
    const m = /^\s*(\d+)\s*(?:[-–—]\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
    if (n >= Math.min(a, b) && n <= Math.max(a, b)) return true;
  }
  return false;
}

const letters = (s: string) => s.toLowerCase().replace(/30\(b\)\(6\)/g, '30b6').replace(/[^a-z0-9]+/g, '');
const volumeOfLabel = (label: string): number | null => {
  const m = /\bVol(?:ume)?\.?\s*([IVXLivxl]+|\d+)\b/.exec(label);
  return m ? romanToInt(m[1]) : null;
};

export interface DepoHit extends PageMapRow { volumeNo: number | null }

/**
 * The sheets that carry the cite's page for its deponent. Matching is by the
 * surname's letters inside the map's label ("De Camara" in "Lauren De Camara,
 * Vol. I"); a volume in the cite must match the label's; a 30(b)(6) cite takes
 * the 30(b)(6) label and a plain one the other, when the map has both. Ordered
 * certified/final before rough, then by A-page.
 */
export function findDepoPage(map: PageMapRow[], cite: DepoCite): DepoHit[] {
  const who = letters(cite.deponent.replace(/\s*30\(b\)\(6\)\s*/g, ''));
  const wantsRule = /30\(b\)\(6\)/.test(cite.deponent);
  if (!who) return [];
  const rank = (v: string) => (/certif|final/i.test(v) ? 0 : /rough/i.test(v) ? 2 : 1);
  let hits: DepoHit[] = map
    .filter((r) => r.deponent && letters(r.deponent).includes(who) && coversPage(r.tr_pages, cite.page))
    .map((r) => ({ ...r, volumeNo: volumeOfLabel(r.deponent) }));
  if (cite.volume !== null) hits = hits.filter((h) => h.volumeNo === null || h.volumeNo === cite.volume);
  const ruled = hits.filter((h) => /30b6/.test(letters(h.deponent)));
  if (wantsRule && ruled.length) hits = ruled;
  else if (!wantsRule && ruled.length && ruled.length < hits.length) hits = hits.filter((h) => !ruled.includes(h));
  return hits.sort((a, b) => rank(a.version) - rank(b.version) || a.a_page - b.a_page);
}

/** "De Camara Dep. Vol. I 63:21–64:2" the way the caveat names it. */
export function depoLabel(c: DepoCite): string {
  const span = c.endPage !== null ? `${c.page}${c.line !== null ? `:${c.line}` : ''}–${c.endPage}${c.endLine !== null ? `:${c.endLine}` : ''}`
    : c.line !== null ? `${c.page}:${c.line}${c.endLine !== null ? `–${c.endLine}` : ''}` : `${c.page}`;
  return `${c.deponent} Dep.${c.volume !== null ? ` Vol. ${c.volume}` : ''} ${span}`;
}
