# The reporter's printed page

**What a citation to a transcript must name, and how to read what the index
recorded.**

Until 2026-09-21 a full-size transcript's `passages.page_start` was the PDF's
page **index**. Only a condensed 4-up sheet ever read the reporter's own
"Page N" marker (PR #140). The consequence, recorded 2026-09-19:

| The document | What a cite said | What it should have said |
| --- | --- | --- |
| a clean transcript PDF | p. 61 | p. 61 — right by luck |
| the same transcript behind an exhibit slip sheet | p. 16 | **p. 15** |
| volume 2 of a deposition | p. 1 | **p. 214** |
| a transcript printed to a text file | p. 1, for all 240 pages | anything at all |

An off-by-one citation is more dangerous than an obviously broken one. "Blake
Dep. 16:4" reads like a real cite, gets typed into a brief, and points at the
wrong answer.

## What the index now records

`lib/transcript-pages.mjs` reads the number the reporter printed on each page
and `chunkPages` writes the result in two places. **No column was added** —
both are existing structured fields.

### On each passage — `passages.metadata`

| Key | When | Meaning |
| --- | --- | --- |
| `page_source: 'printed'` | the detector read the printed page with **high** confidence | `printed_page` is the reporter's own number; cite it |
| `printed_page`, `printed_page_end` | with the above | the reporter's page |
| `pdf_page` | with the above | the PDF page the passage sits on — what the Reader needs to open it |
| `printed_page_method` | with the above | `sequence_fit` or `condensed_marker` |
| `page_source: 'pdf_index'` | the detector looked at a transcript and **would not claim** a printed page | `page_start` is the PDF index. Say so beside the cite. |
| `printed_page_confidence` | on every transcript passage | how much is known about **this page**: `high` / `medium` / `low` / `none`. A page that fell outside every fitted run — a slip sheet, the word index, the errata — reads `none` even in a document that scored `high`, so the word "high" never appears beside a caveat. |
| *(neither key)* | not a transcript, or indexed before 2026-09-21 | nothing is known. The standing "page may be the PDF index" note is the only honest thing to say. |

`line_numbers: 'inferred'` (PR #138) is unchanged and orthogonal: it is about
the **line** number, this is about the **page** number.

**2026-09-21, the line side of the same mistake.** The number the reporter
prints in the running header is a 1-2 digit token alone on its line — shaped
exactly like a line number, and read as one until now. On a page with no
numbers in the text layer that made the header text line 1 and put every
inferred cite one line low (recorded as finding 1 of PR #205 §8); on a numbered
page it made a phantom "line 35", and under the pre-2026-09-10 line regex it
also swallowed the first real line, producing the impossible cite `35:35-7`
whose text began `1  A. It did…`. `lineColumnBounds()` now says where the
column starts, and both readers use it: nothing above the column is a line.
Documents indexed before this date keep the old coordinates until they are
re-indexed — an inferred page's cites move by one line when they are.

### On the document — `documents.metadata.transcript_pages`

The verdict, so an audit can list every transcript still cited by index
without re-parsing a single file: `is_transcript`, `method`, `confidence`,
`claimed`, `reason` (one sentence, in words), `pages_total`,
`transcript_pages`, `evidence_pages`, `mapped_pages`, `segments`
(`from_pdf`, `to_pdf`, `offset`, `printed_from`, `printed_to`, `evidence`),
`conflicts`, `detected_at`. Written only for documents read as transcripts,
and dropped on a re-run that no longer reads one.

## For a citation builder

The three states are deliberately distinguishable, so a cite can say exactly
what is behind it. **One module decides, and both the app and the connector
read it: `lib/cite-page.mjs`.** Do not re-implement the tiers.

```js
import { citePage, pageBasis, hasPrintedLineNumbers } from './cite-page.mjs';

const where = citePage(passage);   // passage.metadata must be on the row
where.state        // 'printed' | 'pdf_index_declined' | 'unknown'
where.pageStart    // the page to CITE (printed_page where it is known)
where.pageEnd      // …through printed_page_end for a range
where.readerPage   // ALWAYS the PDF page — the only number that opens a file
where.caveat       // set ONLY in 'pdf_index_declined'
```

| state | means | the cite |
| --- | --- | --- |
| `printed` | `metadata.printed_page` is a number | the reporter's page, **no caveat** |
| `pdf_index_declined` | `metadata.page_source === 'pdf_index'` | `page_start`, **plus the caveat, on this cite** |
| `unknown` | neither key | `page_start`, and nothing new is said |

A **printed page never appears beside a caveat** — that is the invariant the
harness asserts over every metadata shape. `printed_page_confidence` is about
*that page*, so the word "high" cannot land next to a warning. And `unknown`
is not `pdf_index_declined`: "the detector looked and declined" is a fact
about the page, "the detector never ran" is the absence of one, and the
outline's standing note is the right thing only for the second.

`hasPrintedLineNumbers(passage)` is the same question for the **line** number:
false for prose, and false where `metadata.line_numbers === 'inferred'` (PR
#138) marked numbers the chunker counted by position rather than read.

### What is wired today

**`lib/mcp-core.mjs` — done.** Every connector citation path routes through
`citePage`:

* `formatCitation` substitutes the printed page and appends the caveat in
  words, inside the citation string an outside model is handed:
  `Blake Dep., 15:4-11` where the page was read, `Blake Dep., 16 (PDF page;
  the printed page was not confirmed)` where it was not.
* `handleSearch` and `handleGrep` fetch `id, metadata` for **exactly the
  passage ids they are returning**, in ONE query, through the same client and
  the same access path the handler already uses — so RLS, the SecureSpace seal
  and the AI pause are unchanged, and nothing takes a service-role shortcut.
  **No migration:** the hybrid-search RPC's return type stays exactly as
  074/078 left it. If that query fails or throws, the citation falls back to
  today's format; a search is never failed for a decoration.
* `handleGetPassage` simply adds `metadata` to the columns it already names —
  no extra round trip.
* Results carry `page_basis` (`cites`, `reader_page`, the confidence, the
  caveat) **only where something is known**, so a passage with none of the
  keys does not even change shape.
* `handleGetOutline` returns a `page_range`, not a citation, and is untouched.

**`src/lib/bucketizer/cite.ts` (PR #177) — not yet.** That file belongs to
another lane. The change is three branches, and it is exactly this:

```ts
import { citePage } from '../../../lib/cite-page.mjs';

// in buildCite, replacing `const pageStart = num(passage.page_start) ?? …`
const where = citePage(passage);
const pageStart = num(where.pageStart) ?? num(where.pageEnd);
const pageEnd = num(where.pageEnd) ?? pageStart;
// …and where the caveat is chosen, the page's caveat outranks the line's:
//   where.caveat ?? (inferred ? INFERRED_LINES_CAVEAT : PAGE_ONLY_CAVEAT)
// …and the Reader link opens the PDF page, not the cited one:
//   readerUrl(doc.id, where.readerPage ?? null)
// …and PDF_INDEX_PAGE_NOTE is emitted only when some cite is still 'unknown'.
```

`CitePassage.metadata` widens to `CitePageMetadata & { line_numbers?: string }`
(`lib/cite-page.d.mts`), and `outline.ts`'s passage select must name
`metadata` for any of it to arrive.

`src/lib/document-annotations.ts`'s `formatNoteCite` is **not** part of this:
its page is the page the Reader is physically on, which is a PDF page by
definition and is not a passage citation.

## How the detector works

1. **Candidates.** On each transcript page, look only where a page number is
   printed — above and below the reporter's line-number column — and take
   every 1–4 digit token there, scored by how page-number-shaped it is
   (`Page 15` > `15` alone on a line > digits at the end of a header line >
   an OCR-mangled `l5`). A PDF text layer carries no indentation and joins a
   baseline with no separator, so a right-set page number arrives at column 0
   (`15`) or welded to the running header (`DESMOND BLAKE15`); both are read.
   The line-number column is anchored on the first `1` or `2` whose successor
   follows it, so the bare `1` header on printed page 1 is not mistaken for
   line 1.
2. **Fit.** Reporter pages step by exactly +1, so `printed = pdf_index +
   offset` over a contiguous run. Offsets that many pages agree on outvote
   one-off noise; the document is cut into runs of constant offset, and only
   runs with real evidence behind them are kept. An exhibit slip sheet makes
   the offset −1 for the whole document; pages inserted mid-transcript change
   it once; volume 2 makes it +213.
3. **Verdict.** A page with no readable number *inside* a kept run is
   recovered from the run — that is how a page whose header OCR'd to nothing
   still cites correctly. A page outside every run (the caption, the word
   index, the errata, a slip sheet) gets nothing. Coverage, evidence count,
   the number of runs, and a check that the line numbers actually **reset at
   each page boundary** set the confidence. Only `high` claims a printed page.

Nothing here is a guess dressed as a fact: low confidence means the passage
keeps the PDF index and is marked as carrying the PDF index. A run must show
at least **six** pages of its own evidence before `high` is available, so an
excerpt of five transcript pages or fewer never claims a printed page.

**What this cannot tell you in advance:** whether a given reporter puts the
page number in the PDF's text layer at all. Veritext's Fleming exports carry
no *line* numbers there (PR #138 had to count lines by position); whether they
carry the *page* number is a per-export fact. Run
`audit-transcript-pages.mjs --fixture` over one document's extracted page text
before approving a batch re-index — a `pdf_index / none` verdict on such a
transcript is honest, and no worse than today, but also no better.

Condensed 4-up sheets are short-circuited, not re-fitted — `parseTranscriptPage`
has carried each panel's own printed page since PR #140. What is new for them
is `pdf_page`: the sheet's own PDF page, which used to be thrown away.

Plain-text transcript printouts ("the TXT FILE copy") are now paginated before
any of this: on form feeds, which is what a form feed means, or on a run of
page-marker lines (`00015`, `Page 15`) when at least five of them step by +1
**and** the file reads as testimony. Everything else stays one page, exactly as
before.

## The audit

```
node scripts/audit-transcript-pages.mjs --fixture <file.json>    page text, offline
node scripts/audit-transcript-pages.mjs --passages <file.json>   parsed passages, offline
node scripts/audit-transcript-pages.mjs --db [--matter <code>]   the live database, read-only
```

Per document: the mapping, the confidence, the reason, and how many of that
document's citations would change if it were re-indexed today. It prints ids,
page numbers and counts — never a word of transcript text — and writes
nothing. `--db` reads the recorded verdict and the passages' own coordinates;
it does not re-parse any file and does not select passage text.

## What this does NOT do

**It does not touch a single existing passage.** Every document in the corpus
keeps the citations it has until it is re-indexed. Re-indexing a deposition
rewrites its passages, which is a separate, separately approved step —
`node scripts/reingest.mjs <document ids>` — and it also invalidates any
Bucketizer `passage_ids` recorded against the old rows.

Proof lives in `scripts/_test-transcript-parse.mjs` (a CI step since this
change): one synthetic fixture per layout above.

`scripts/_verify-cite-printed-page.mjs` (also a CI step) proves the display
half: a snapshot of origin/main's own citations that a key-less passage must
still match character for character, the three states, the
never-a-printed-page-beside-a-caveat invariant, the corrected `grep`
citation, and that the extra metadata query is one query, scoped to the
returned ids, and never fatal.

### The grep citation was wrong, and is fixed here

`handleGrep` used to cite `Memo, p. 1-undefined:1`. Two faults: it never
selected `page_end`, so `formatCitation` compared a page to `undefined`,
decided the passage spanned a range, and printed the word; and it handed
`formatCitation` a line number for every hit, including hits in prose, where
the "line" was only a count of newlines inside the chunk. A grep hit now
cites the page alone on prose, and `page:line` on a transcript only where the
reporter's own line numbers were read off the page (`hasPrintedLineNumbers`).
`match.line` is `null` in every other case rather than a number that names
nothing.
