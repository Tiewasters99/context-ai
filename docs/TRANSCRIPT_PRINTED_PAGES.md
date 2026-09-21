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
what is behind it. In tier order:

```js
const printed = passage.metadata?.printed_page;
if (typeof printed === 'number') {
  // Tier: the reporter's own page. No PDF-index caveat belongs on this cite.
  // Open the Reader at passage.metadata.pdf_page ?? passage.page_start.
} else if (passage.metadata?.page_source === 'pdf_index') {
  // Tier: the detector looked and declined. Cite page_start AND print the
  // caveat — passage.metadata.printed_page_confidence says how close it got.
} else {
  // Tier: nothing is recorded. Today's unconditional standing note.
}
```

`src/lib/bucketizer/cite.ts` (PR #177) already has the tiers and the caveat
text; wiring the first two branches into it is a separate, small change in
that lane. Nothing is wired yet because **no passage carries these keys until
its document is re-indexed** — see below.

`lib/mcp-core.mjs` is likewise unchanged. Its citation paths never select
`passages.metadata` (the search RPC's return type is fixed in migration 002
and `handleGetPassage` names its columns), so a change there today would
change nothing. The follow-up, when the corpus has been re-indexed, is: add
`metadata` to `handleGetPassage`'s select, add it to the hybrid-search RPC's
return type in a migration, and have `formatCitation` prefer
`row.metadata.printed_page`.

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
