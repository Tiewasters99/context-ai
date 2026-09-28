// A case cited by its docket or index number rather than a reporter —
// "Matter of DiSanto v. N.Y.C. Dep't of Health & Mental Hygiene, Index No.
// 508835/2024 (Sup. Ct., Kings County)", "No. 1:23-cv-04567 (S.D.N.Y.)" — to
// the numbers that find it in the record. A court download is filed under
// the court's own filename ("508835_2024_PETRINA_DISANTO_et_al_v_…pdf"), with
// no Westlaw header, so the reporter index and the name match both miss it
// (Eden, 09-28: "I could have sworn I included this in the corpus"). The
// index number is on that filename and on the decision's first page. Pure.

export interface IndexCite {
  /** "508835" (the year-less part), or a federal docket "1:23-cv-04567" as written. */
  number: string;
  /** The year of an "Index No. 508835/2024"; null for a federal docket. */
  year: string | null;
  /** Strings to look for in a title or filename, most specific first. */
  titleNeedles: string[];
  /** Strings to look for in a document's text (its first page carries the caption). */
  textNeedles: string[];
  /** The first party's surname ("DiSanto"), for a second look at titles when the number is not in the name. */
  surname: string | null;
}

/**
 * A caption highlighted WITHOUT its number ("Matter of DiSanto v. N.Y.C.
 * Dep't of Health & Mental Hygiene"): the index or docket number the brief
 * itself gives right after that caption, anywhere it appears. The brief is
 * the source; nothing is guessed.
 */
export function indexCiteFromBrief(caption: string, briefText: string): IndexCite | null {
  const flat = (s: string) => s.replace(/[*_]/g, '').replace(/\s+/g, ' ').trim();
  const cap = flat(caption).replace(/[,.;:]+$/, '');
  if (cap.length < 6) return null;
  const text = flat(briefText);
  for (let at = text.indexOf(cap); at >= 0; at = text.indexOf(cap, at + 1)) {
    const c = parseIndexCite(text.slice(at, at + cap.length + 200));
    if (c) return c;
  }
  // the caption's first party alone ("DiSanto v." … when the brief abbreviates differently later)
  const first = /^(?:(?:In\s+re|Matter\s+of|In\s+the\s+Matter\s+of)\s+)?([A-Z][\w'’.-]+)/.exec(cap)?.[1];
  if (first && first.length >= 4) {
    const re = new RegExp(`(?:Matter of |In re )?${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^.]{0,200}`, 'g');
    for (const m of text.matchAll(re)) {
      const c = parseIndexCite(m[0]);
      if (c) return c;
    }
  }
  return null;
}

export function parseIndexCite(text: string): IndexCite | null {
  const s = text.replace(/\s+/g, ' ').trim();
  const idx = /\b(?:Index|Ind\.|Idx\.)\s*(?:No\.?|Number|#)\s*:?\s*(\d{3,7})\s*[/-]\s*(\d{2,4})\b/i.exec(s);
  const dkt = /\b(?:Docket|Dkt\.?|Case|Civ\.?|Civil Action)?\s*No\.?\s*:?\s*((?:\d{1,2}:)?\d{2,4}-(?:cv|cr|mc|md|bk|ap|civ|CV|CR)-\d{3,6}(?:-[A-Z]{2,4})*)/i.exec(s);
  const cap = /^(?:(?:In\s+re|Matter\s+of|In\s+the\s+Matter\s+of|Ex\s+parte)\s+)?(?:the\s+)?([A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*)*?)(?:,|\s+v\.?\s|\s+ex\s+rel\.|\s*$)/.exec(s.replace(/^[*_]+|[*_]+$/g, ''));
  const surnameOf = (party: string | undefined): string | null => {
    if (!party) return null;
    const words = party.replace(/[,.]/g, '').split(/\s+/).filter((w) => w.length >= 4 && !/^(Inc|LLC|Corp|Co|Ltd|City|County|State|Dept|Dep|Board|Bd|York|New|United|States|Department|Commissioner|Comm)$/i.test(w));
    return words.length ? words[words.length - 1] : null;
  };
  const surname = surnameOf(cap?.[1]);
  if (idx) {
    const number = idx[1];
    const year = idx[2].length === 2 ? `20${idx[2]}` : idx[2];
    return {
      number, year,
      titleNeedles: [`${number}_${year}`, `${number}-${year}`, `${number}/${year}`, number],
      textNeedles: [`${number}/${year}`, `${number}/${year.slice(-2)}`, `No. ${number}`],
      surname,
    };
  }
  if (dkt) {
    const number = dkt[1];
    const core = number.replace(/^\d{1,2}:/, '').replace(/-[A-Z]{2,4}$/i, '');   // "23-cv-04567"
    return {
      number, year: null,
      titleNeedles: [number, core, core.replace(/-/g, '_')],
      textNeedles: [number, core],
      surname,
    };
  }
  return null;
}
