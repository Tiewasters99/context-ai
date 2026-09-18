# Handoff 2026-09-18: scanned PDFs marked "ready" without OCR

Branch `fix/stamp-only-scans-reingest` (worktree `C:\Users\equai\context-ai-wt-stampocr`), off `origin/main` b97d6c6.
Every factual claim below is tagged **[verified]** (I ran the query, read the code, or executed the path) or
**[inferred]** (a reasoned conclusion I could not check directly). **[not verified]** marks a gap I am leaving open.

## 0. In one paragraph

The two DeCamara orders (ECF 53 `8fec0254…`, ECF 58 `a5c71dd8…`) were ingested on **2026-05-25**, two weeks before the
pipeline had any OCR at all, and four days before it extracted PDFs page by page. They were never re-run. Every later
fix to the OCR trigger (08-10, 09-04) applied to new uploads only, and every health check that came after (the 08-22
audit, `ready_but_empty()`, the monitor, the nightly suite) looks for documents with **zero** passages. A stamp-only
document has one passage per page, the stamp, so it read as healthy to all of them. On today's `main` a CM/ECF-stamped
scan does route to OCR. But one path still produces exactly the ECF 53 state: OCR that returns nothing (an answer
without the page markers) makes the merge keep each stamp, and the document goes `ready` with no record. That path,
`page_count`, the refusal to re-run a ready document, and the missing record are fixed on this branch. Both named
orders were repaired in place. The audit then found a larger, separate problem: **346 PDFs whose every passage cites
"p. 1"** (section 5.3), which should be the next thing fixed.

## 1. What the prior hardening phases actually delivered

**The July 31 "seven-prompt hardening series (Phases 0–6)" and the July 28 black-box audit (F1–F11) are not in the
repository and not on this machine. [verified: absent]** Searched: `docs/handoffs/` on every branch and every worktree
(14 worktrees, all refs after `git fetch --all`; the directory did not exist anywhere until this file created it);
`git log --all` for 2026-07-29..08-03; Downloads, Desktop, Documents, OneDrive, `context-ai-scratch` for "golden
corpus", "audit ledger", "OCR ghost" and for files named phase/prompt/harden/handoff/golden/audit dated 07-30..08-01;
the session memory. A Contextspaces-wide search timed out on 20 of 25 matter groups, so that search is **[not
verified]**. If those prompts exist, they live in a chat that never became commits. So the phase-by-phase question is
answered by capability, against what actually landed:

| Capability the July series named | What exists in code | Where / when |
|---|---|---|
| Golden corpus (Phase 0) | Yes, under a different plan: the nightly fixture suite, ~25 fixtures through the **deployed** pipeline, gates G0–G10 | `scripts/ingest-suite.mjs` + `_fixtures-suite.mjs`, PRs #123–#125, 2026-09-06 [verified]. It had **no CM/ECF-stamped fixture**; the stamp case was only in the offline unit test `_test-ingest-ocr.mjs` (routing only, no body text, no page count) [verified] |
| Status model fixes | Yes: `metadata.text_status` (image_only / no_text / ocr_pending / …), `ocr_pending` with retry schedule, `held` for sealed matters | Sept plan P1 (#114), P2 (#117), migration 060 [verified]. But `ready` still means "the pipeline finished", not "the text is right" |
| Idempotent re-ingest (Phase 1) | **Partly.** `scripts/reingest.mjs` (05-29) and the worker's `ingest_document` job both delete a document's passages and re-run it | `reingest.mjs:87`, `worker/discovery-worker.mjs:638` [verified]. Not reachable through the API for a `ready` document: `lib/mcp-core.mjs:2189` short-circuits, the worker skips ready rows at `:627`, and there is no force parameter (`additionalProperties: false`) [verified]. Both paths delete **before** re-running, so a failed re-run empties a good document [verified by reading] |
| Audit ledger (Phase 2) | **No.** No ingestion event table. `042_matter_state_ledger` is the Knowledge Map / docket ledger, unrelated. The only "ledgers" are `bulk-import.mjs`'s local JSONL and the suite's in-memory gate tally | [verified] |

Name collision to be aware of: the **September** ingestion plan also has phases P1–P6 (P1 truth & feedback, P2 per-page
OCR, P3 containers, P4 capacity, P5 suite, P6 data repair), all merged 09-04..09-08. They are not the July phases.

## 2. The true trigger condition, quoted from the code

| Era | Condition (quoted) | A CM/ECF-stamped scan |
|---|---|---|
| until 2026-06-09 (ECF 53/58 ingested 05-25 at `900898c`) | none: `// Vision-model captioning / OCR is a future opt-in` (ingest-core line 26); `extractPdfPages` split pdf-parse output on form feeds, else `[raw]` as page 1 | never OCR'd; both pages on "page 1" [verified] |
| 06-09 → 08-10 (`7502b1c`) | `const looksScanned = lowerExt === '.pdf' && extractedChars < Math.max(40, pages.length * 2);` | 2 chars/page, effectively "is there any text at all". **Hypothesis 1 is exactly right for this era** [verified] |
| 08-10 → 09-04 (`1a514aa`) | `extractedChars < Math.max(40, pages.length * 200)`, the whole document at once | pure scans fixed; scanned pages inside mostly-typed files still lost [verified] |
| 09-04 → today (`6bf68d4`, P2) | `pagesNeedingOcr`: a page is short if `text.trim().length < PAGE_TEXT_MIN_CHARS` (200); every short page if `total < Math.max(40, pages.length * PAGE_TEXT_MIN_CHARS)`, else only short pages carrying a ≥250k-pixel image | routes to OCR. Run on the stored ECF 53 and ECF 58 bytes: `pagesNeedingOcr → [1, 2]`, `planPdfOcr → {pageCount: 2, ocrPages: [1, 2]}` [verified] |

**Hypotheses, as briefed:**
1. *Trigger = "any text"*: **confirmed for the code that ingested these documents** (there was no trigger at all on
   05-25; 2 chars/page until 08-10), **refuted for today's routing** [verified]. The residual on `main` is downstream of
   routing: `ocrPdfPages` → `mergeOcrPages` keeps a page's own text when OCR returns nothing ("never trade text for
   nothing"), and `parseDelimited` (`lib/ocr-protocol.mjs:68`) returns `''` for every page when the model's answer has no
   `<<<PAGE n>>>` markers. Stamps then count as content, the document goes `ready` as stamps, and nothing is recorded.
   Reproduced on `main` with the real ECF 53 bytes (section 4) [verified].
2. *page_count from extraction, not the PDF*: **confirmed** [verified]. In May, `page_count = pages.length` of the
   form-feed split (pdf-parse 1.1.1 joins pages with `\n\n`, so no split, one page; the stored passage is literally both
   stamps joined by a blank line). Today it is still `pageCount = pages.length` of the extractor's output
   (`ingest-core.mjs`, `pageCount = pages.length` before chunking). The per-page `pagerender` extractor (05-29) usually
   agrees with the PDF, but its fallback at the end of `extractPdfPages` still used the form-feed split.
3. *"ready" is terminal*: **confirmed** at `lib/mcp-core.mjs:2189` and `worker/discovery-worker.mjs:627` [verified].
4. *OCR works when it runs*: **confirmed**. ECF 73 (`7ca31518…`) was re-ingested 2026-08-10 21:51Z, 13 minutes after
   `1a514aa` landed, and carries OCR text [verified]. The commit message names a Benavides verdict form repaired
   "out-of-band" that day. The ECF 73 repair is not recorded anywhere; that it was part of the same session is [inferred].
   Whoever did it fixed the documents in front of them and did not sweep for the rest.

## 3. Was the defect addressed and regressed, or never fixed?

**Addressed in code twice, never regressed in code, and never backfilled in data** [verified]. The damage is data
ingested before 08-10 (stamp-only) and before 09-04 (scanned pages inside mixed files), plus the one live path in
section 2(1). No finding in the audit was produced by today's routing: the single document ingested after the P2 worker
deploy (`26-2098_Documents`, 09-16) has only blank stamp-only pages, and its screenshot pages each carry a ~3,000-char
text layer plus a separate stamp passage [verified]. That the P2 code reached the worker at the 09-04 21:46Z deploy, not
at the 07:38Z merge, is [inferred] from the P4 deploy record; five documents ingested in between show only blank pages.

## 4. The fix: before and after

Commit `deb0b66`. Offline tests: `node scripts/_test-stamp-scans.mjs` (14 checks) plus the eleven existing ingestion
unit suites and the offline `_verify-seal-pipes`, `_verify-embed-hold`, `_verify-ocr-routes`, all exit 0 [verified].

1. **Stamps are not content** (`lib/court-stamps.mjs`, new). One definition of a filing stamp: district CM/ECF (with
   PageID), appellate (`Case: 26-2098 Document: 20-4 Page: 144 Date Filed: …`), USCA, 10th Cir., NYSCEF. In
   `processDocument` the PDF decisions (`extractedChars`, `afterOcrChars`) now count `contentChars(pages)`: a page that
   is stamps and nothing else counts zero, a typed page counts in full. **Routing is unchanged**: `PAGE_TEXT_MIN_CHARS`
   and `pagesNeedingOcr` are untouched, so no document with a genuine text layer is sent to OCR that was not before.
2. **OCR that reads nothing on a stamped filing is a failure, not an image.** If OCR returns no text for every target
   page, and every target page's own text is a stamp or blank (a blank back page does not count against it; at least
   one must be a stamp), the run throws into the existing OCR-failure branch: the pages are
   recorded in `ocr_pending` with the reason, the worker's sweep retries on the P2 schedule, and an exhausted record
   triages as `ocr_exhausted` (a person looks). An **unstamped** scan OCR reads nothing on is still `image_only`.
3. **`page_count` is the PDF's.** `extractPdfPages` reads pdf.js's `numpages` and `fitToPageCount` pads missing pages
   (empty, so they route to OCR), folds overflow text into the last page, and never drops text. A form-feed fallback
   that disagrees with the page tree is re-read page by page with modern pdfjs first.
4. **Re-run a ready document** (`ingest_document` `force: true`). The job carries `force`, the row stays `ready` and
   searchable while queued, and the worker swaps instead of wiping (`lib/reprocess.mjs`, new): note the newest existing
   passage, run, then delete the old passages on success, or delete this run's passages and restore the row on
   failure, recording the result in `metadata.reprocess`. Both worker failure recorders already skip `ready` rows
   (`:254`, `:302`), so a forced run that fails with an error leaves the document as it was [verified: unit test]. The
   worker swaps **every** forced job, not only one that finds the row `ready`. A forced run whose worker died mid-way
   (watchdog, OOM on a large re-run) is reclaimed with the row at `embedding`, and wiping there would take the
   originals with it. The swap handles that case: success removes originals and the crashed run's partials; failure
   keeps the originals (the partials stay until the next success) [verified: unit test with the crash state seeded; a
   real worker crash was **not** exercised]. `scripts/reingest.mjs` uses the same swap (it used to delete first). The
   unforced refusal now names `force`. Unforced jobs and non-ready documents behave exactly as before.
5. **The record** (item 7; the Phase 2 ledger does not exist, so this is the no-migration version):
   `documents.metadata.ingest_outcome = { at, pdf_pages, ocr: not_needed|read|failed|held|not_configured, text_source:
   text_layer|ocr|mixed|none, ocr_pages: "1-2", ocr_no_text: "7" }`, written on every PDF outcome. `check_ingest_status`
   shows it, and for a ready PDF without one says it predates the record and how to re-run it.
6. **Golden corpus**: G1 gains a CM/ECF-stamped 2-page scan through the deployed pipeline (body word on each page,
   `page_count === 2`, no stamp-only passage, `ingest_outcome` = OCR/ocr). New in-process gate **GR** seeds the exact
   May state (ready, page_count 1, one passage of both stamps), checks the plain refusal names `force`, re-runs in place
   with real OCR, and asserts the swap.

**Before/after on identical inputs** (real ECF 53 bytes, in-memory database, stubbed OCR and embeddings; `main` =
the `context-ai` clone, ingest-core and mcp-core byte-identical to `origin/main`) [verified]:

| Input | `main` | this branch |
|---|---|---|
| OCR reads both pages | ready, 2 passages, page_count 2, no record | same, plus `ingest_outcome` read/ocr |
| OCR answers with no page markers | **ready, 2 passages that are the stamps, `metadata: {}`** (silent) | ocr_pending, 0 passages, retried |
| OCR provider down (503) | ready, the 2 stamps indexed as "typed pages", `ocr_pending` recorded | ocr_pending, 0 passages |
| `ingest_document` on the May state | "nothing to do", with or without `force` | refuses and names `force`; `force` queues `{document_id, force: true}` and leaves the row `ready` |

**The two named orders, repaired** 2026-09-18 16:34Z with this branch's `scripts/reingest.mjs` (Tier A matter, Gemini
OCR, swap path; originals untouched) [verified]: each went from 1 stamp passage and page_count 1 to 2 OCR'd passages and
page_count 2, with `reprocess.replaced_passages: 1` and `ingest_outcome {ocr: read, text_source: ocr, ocr_pages: "1-2"}`.
The production MCP now returns `page_count: 2` and the body text (ECF 53 p.1 begins "IN THE UNITED STATES DISTRICT
COURT…"; p.2 "Preclude Plaintiffs from further deposing…"). Log: `context-ai-scratch\ingestion-diagnostics\
reingest-ecf53-ecf58-2026-09-18.log`. No other document was reprocessed.

**Suite run from this branch**, 2026-09-18 16:37Z, `test-box`, `--skip-heavy --no-g9` (run `9c95f7f7`, cleaned up)
[verified]: G0, G2–G6, G8 and the new **GR pass**. GR seeded the May state, got the refusal naming `force`, re-ran in
place with real OCR (page_count 1 → 2, both body words found, 1 stamp passage replaced, 0 left, outcome read/ocr). In
G1, the mixed PDF and the new CM/ECF-stamped scan **pass through the deployed pipeline**: OCR'd, body on each page,
page_count 2, no stamp-only passage. That is independent confirmation that today's routing handles a fresh stamped
scan. One check fails, as designed: `ingest_outcome` is absent because the deployed worker predates this branch.

**Not live yet** [verified]: the API's `force`, the outcome record, and the stamped-OCR-empty rule need the merge
(Vercel) **and a worker deploy** (Fly, through the IPv4 proxy). Until the worker is deployed, that G1 check stays red;
that is the intended signal.

## 5. Backfill audit results (read-only, 2026-09-18, 46,219 documents across 254 matters)

Tool: `node scripts/audit-stamp-only.mjs` (committed; service-role GETs only, server-side regex prefilter, pages past
PostgREST's 1,000-row cap). Each finding was then checked against the stored PDF itself (page tree, and whether each
stamp-only page carries a page-sized image) [verified]. Lists are **outside the repo** (document titles are client
data): `C:\Users\equai\context-ai-scratch\ingestion-diagnostics\stamp-only-audit-2026-09-18{.csv,.json,.verified.json,
.summary.txt}` and `page-count-one-audit-2026-09-18.json`. The two repaired orders are counted below as they were
before repair.

### 5.1 Stamp-only documents: all text is stamps, all pages are unread scans (14 documents, 232 pages)

| Matter | Docs | Pages | Ingested |
|---|---|---|---|
| withdrawal-motion | 6 | 102 | 08-02 (four "515-1" and two "Teman medical records", 17 pp each; likely duplicate filings [inferred]) |
| decamara-v-bryn-mawr | 4 | 7 | 05-25 (ECF 53, ECF 58 now repaired; "Order re Motion to Amend" `27d99f7b`; "United States District Court Eastern District of Pennsylvania" `055b97ec`) |
| atkinson-foia | 1 | 86 | 06-25 ("2022.07.25 MSJ Exh. E") |
| rute-recusal | 1 | 17 | 07-20 |
| budow | 1 | 17 | 08-05 |
| yaacov | 1 | 3 | **08-20**, after the 08-10 fix: the job finished in 2 s with no OCR record. The 08-10 rule should have fired (267 stamp chars < 600), so OCR most likely returned nothing and the stamps were kept [inferred; logs from that day not checked, **not verified**] |

### 5.2 Partial: scanned pages lost inside otherwise indexed documents (38 documents, 454 pages)

Per page, a page is counted only if **every** passage covering it is a stamp and the PDF page carries a scanned image.
13 further documents (147 pages) have stamp-only pages that are all **blank** (no image): harmless, not counted.

| Matter | Docs | Lost pages | Worst |
|---|---|---|---|
| huddleston | 7 | 173 | "2022.02.07 Exhibit 1 (stamped)": 131 of 167 pages (08-27) |
| awan-foia | 4 | 142 | NSA declaration exhibit: 73 of 75; NSD declaration: 51 of 123 |
| atkinson-foia | 5 | 52 | MSJ Exh. D: 24 of 25 |
| rute-recusal | 3 | 22 | Exhibit 2 (stamped): 19 of 20 |
| privilege-issues | 2 | 34 | "Privilege log as filed": 33 of 34 |
| withdrawal-motion | 6 | 16 | |
| decamara-v-bryn-mawr | 1 | 2 | (a first, per-passage pass also flagged three appendix volumes; per page, those pages carry text in another passage) |
| budow | 1 | 1 | |
| fleming 1 · amazon-docket 2 · depositions-aamazon 2 · benavides-appeal-documents 1 · ed-henry-jams 1 · remote-depositions 1 · teman 1 | 9 | 12 | |

By ingest era (stamp-only + partial with lost pages): before 06-09: 5 · 06-09..08-10: 35 · 08-10..09-04: 12 · after
the P2 worker: **0** [verified].

### 5.3 A second, larger defect found on the way: 346 PDFs whose every passage cites "p. 1"

Hypothesis 2 generalised. Ready PDFs stored with `page_count = 1` whose PDF has more pages, checked by downloading each
candidate and reading its page tree [verified]: **346 documents, 16,326 real pages, 11,411 passages that all cite page
1**, ingested 2026-05-05..05-29, the window before `1e9b4cc` (per-page extraction, 05-29 13:52 −04:00). None ingested
after it [verified]. The count is a **lower bound**: only candidates with more than 3 passages or over 400 KB were
downloaded (2,018 checked).

| Matter | Docs | Real pages | Passages citing p.1 |
|---|---|---|---|
| decamara-v-bryn-mawr | 225 | 10,259 | 6,747 |
| webster | 46 | 1,949 | 2,002 |
| coleman | 48 | 1,124 | 768 |
| history | 7 | 1,704 | 1,198 |
| depositions | 5 | 579 | 368 |
| insurance 5 · labib-steris-mediation 4 · ukc 2 · labib 1 · tik-tok 1 · cadillac 1 · complaints 1 | 15 | 711 | 327 |

26 of them are deposition transcripts or roughs (2,465 pages), 20+ of those in DeCamara. `reingest.mjs`'s own header
says it was written for this bug on 05-29; the rows show it was not run on these [verified: `page_count` still 1,
`ingested_at` unchanged].

## 6. Verification backlog, most dangerous first

1. **The 346 "p. 1" documents (5.3).** A citation pulled from Contextspaces into a brief would carry the wrong page:
   the DeCamara depositions, the 814-page DECMAYO production, "Appendix Vol. 2" (698 pp, stored as 1 page) in a case now
   on appeal. The page is the damage, not the text. Fix = re-run through the swap: `node scripts/reingest.mjs <ids>` in
   batches, **after Eden approves**, DeCamara transcripts first. Cost is mostly embedding (cents) plus OCR only where
   pages are scanned. Also widen the probe to the small files it skipped.
2. **The 52 documents / 686 scanned pages never read (5.1, 5.2).** Invisible to search: court exhibits, FOIA
   declarations, a filed privilege log. Re-run the same way after approval. Budget: Gemini Flash ≈ $0.002/page → ≈ $1.40
   for the lost pages (P4 memo's rate, [inferred] current).
3. **Deploy what this branch built, or the live residual stays open.** Until the worker runs this code, an OCR answer
   without page markers still indexes a stamped scan as its stamps, silently. Merge → worker deploy → `git pull` in
   `C:\Users\equai\context-ai` (the nightly suite runs from there) → confirm G1 and GR green at 03:00.
4. **`grep` citations are wrong for prose** (`lib/mcp-core.mjs:1521`, `handleGrep`). It omits `page_end`, so every
   prose hit reads "p. 1-undefined:1" (seen live on ECF 53 today). It also invents a line number (newlines within the
   passage) for documents that have no line numbers. This is the tool the MCP describes "for verification work". Fix:
   pass `page_end`, and emit a line only when `line_start` is real.
5. **OCR text is not verbatim.** ECF 58 p.2's stamp came back as "Payt 2012"; ECF 73's as "2:25 ev 02287 MAK" and a
   signature as "Way". Anything quoted from an OCR'd page (`ingest_outcome.text_source` ocr or mixed) needs checking
   against the image before filing. Deposition-fidelity rule.
6. **The model-protocol gap underneath** (`lib/ocr-protocol.mjs:68`). A window answer with no page markers becomes ''
   on every page. This branch catches it only when every target page is stamped. An **unstamped** scan whose OCR answer
   loses its markers is still filed `image_only`, which the monitor calls benign. Fix at the source: a non-empty window
   answer with zero markers should throw, so the route's fallback and retry engage.
7. **Stamp-only is a health-check class now; make the monitor see it.** `ready_but_empty()` / `ingest-monitor.mjs` only
   see zero passages. Either schedule `audit-stamp-only.mjs` beside the monitor, or add a second RPC (service-role, like
   059) returning ready PDFs whose passages are all stamp-only. Also consider flagging `ingest_outcome.ocr_no_text`
   pages on court filings.
8. **A durable ingestion ledger** (the Phase 2 idea). The row-level `ingest_outcome` is overwritten by each run. An
   append-only `ingest_events` table (document, run, route, pages, OCR pages, outcome, error) needs a migration Eden
   pastes. Worth doing before the next backfill so the backfill itself leaves a trail.
9. **Double stamps on appellate appendix pages.** A JA page can carry the district stamp (~70–90 chars with PageID) and
   the circuit stamp (~65). With a JA page label, that is ~160 chars, under the 200-char routing floor but not by much.
   Measure on a real appendix before relying on it [not verified].
10. **The UI has no forced re-run.** The Vault's Re-run covers stored-without-text documents. A ready document can be
    forced only through MCP or the script. Add the control where `ingest_outcome` is absent or `text_source` is `none`.
11. **Force has a cost and no limit.** Any user with matter access can force re-runs (OCR + embedding each time).
    Fine for a solo practice; revisit before multi-seat tenants.

## 7. To land this

1. Review and merge the PR: `! gh pr merge 153 --merge --repo Tiewasters99/context-ai` (PR #153). Vercel deploys the MCP
   (`force`, `check_ingest_status`); verify in a **new** claude.ai chat, since the tool list is cached.
2. Deploy the worker (the swap path, `ingest_outcome`, the stamp rule), through the local IPv4 proxy if flyctl
   fails over IPv6 (see the dev-environment cautions memo).
3. `git pull` in `C:\Users\equai\context-ai` so the 03:00 suite runs the new G1 check and GR.
4. Approve (or not) the two backfills in section 6, items 1 and 2. The lists are in `context-ai-scratch\ingestion-diagnostics\`.
   Re-run `node scripts/audit-stamp-only.mjs` afterwards; it should report only the 13 blank-page documents.

## 8. Files

- `lib/court-stamps.mjs` (new): stamp recognition, `contentChars`
- `lib/reprocess.mjs` (new): the swap
- `lib/ingest-core.mjs`: `fitToPageCount`, content-not-stamps, stamped-OCR-empty rule, `ingestOutcome`, `compactPages`
- `lib/mcp-core.mjs`: `ingest_document` `force`, forced enqueue, `check_ingest_status` outcome
- `worker/discovery-worker.mjs`: forced jobs on ready rows take the swap
- `scripts/reingest.mjs`: swap instead of delete-first
- `scripts/audit-stamp-only.mjs` (new): the read-only audit
- `scripts/_test-stamp-scans.mjs`, `scripts/_fake-supabase.mjs` (new), `scripts/_fixtures-ingest.mjs` (`stampedScanPdf`)
- `scripts/ingest-suite.mjs`: G1 stamped scan, gate GR
