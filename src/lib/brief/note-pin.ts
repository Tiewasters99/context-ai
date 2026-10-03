// The footnote a cite pins to: "…, OATH Index No. 1467/24, at 2 n.1 (Dec. 24,
// 2024)" → 1. Find in corpus opens the authority at that note instead of at
// its top, where a footnote at the end of a decision was easy to miss (Eden,
// 10-02: "still returns a document with no footnotes").
//
// Bluebook 3.2(b): "n." or "nn." then the number, usually after the page
// ("373 n.3", "373 & n.3", "373 nn.3–4"); a spacer is tolerated ("n. 3").
// For "nn.3–4" the first note is the one to open. Pure, for the harness.

/** The note number a cite pins to, or null. */
export function noteNumberOf(cite: string | null | undefined): number | null {
  if (!cite) return null;
  // The LAST pin wins: a parallel cite or a "quoting" clause can carry an
  // earlier one, and the pin a reader means comes at the end of the cite.
  const re = /(?:^|[\s,(&])nn?\.\s?(\d{1,3})(?=$|[^\d])/g;
  let last: number | null = null;
  for (let m = re.exec(cite); m; m = re.exec(cite)) last = Number(m[1]);
  return last && last > 0 ? last : null;
}
