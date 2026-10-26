# Trademark Clearance — Equazia recipe spec v0.1

Written 2026-10-18 by Fable (design session) from Opus's "Trademark Agent — Claude Code Build Prompt"
(Oct. 18, 2026) and Fable's review of it (`C:\Users\equai\TRADEMARK-AGENT-SPEC-REVIEW-2026-10-18.txt`).
Builder: Opus, worktree-isolated. Eden reviews the PR. The build handoff next to this file adds the
repo facts; where the two differ, the handoff wins.

Markers: **[V 10-18]** verified against the named source on 2026-10-18. **[M]** medium confidence,
verify before relying. **[L]** assumption. **[H]** high confidence, not re-verified.

---

## 0. What this is

A matter-scoped recipe that runs a U.S. federal trademark **knockout search** for a proposed mark,
keeps a reconstructible record of every query and every reviewer decision, and files a knockout
report into the matter. Later slices add the TSDR deep check, the web screen, the intent-to-use
application draft, and the docket. **The lawyer decides at every judgment point; the recipe prepares.**

It is the first of the "D12 recipes" on the agents platform, and the stage / record / review-gate
skeleton it introduces is meant to be reused by the next ones (intake, cite-check, contract review).
Build this one concretely; keep the skeleton separable; do not abstract it before a second recipe exists.

### 0.1 Design principles (binding)

1. **Human decides.** The product never says a mark is "clear", "cleared" or "registrable". It says
   "N hits flagged for review" or "no conflicts identified for review". This is enforced in code
   (§6, the forbidden-phrase lint), not by prompt discipline.
2. **Every step leaves a record.** Each query, each run, each proposed and each decided bin, each
   filed document writes to the matter Record (`events`) with who/when; reviewer decisions carry
   the Equazia user id, initials and time.
3. **No silent gaps.** A query that was not run, failed, or whose captured rows differ from the
   reported count is reported as a gap. Duplicate serials inside one query's rows = pagination
   overlap = a gap. A failed query is never "no results".
4. **Procedure is data.** The substitution table, endings, exclusion defaults, class notes and the
   self-test live in readable JSON under `lib/trademark/procedure/` with a `why` on every row, are
   shown read-only in the Method panel, and their content hash is printed in the report.
5. **Deterministic first, model at judgment points.** See §4 for the split.
6. **Cite sources.** Any statement of law, fee or USPTO practice the product prints carries its
   source and verification date. Slice 1 prints none except the search-syntax table.
7. **Search classes are not filing classes.** Searching is broad (coordinated classes). Filing is
   only where the applicant has dated evidence of bona fide intent per identification (*M.Z. Berger
   & Co. v. Swatch AG*, 787 F.3d 1368 (Fed. Cir. 2015)). The data model keeps two lists with a
   reason per class.
8. **Brand-neutral copy.** New UI text says "this matter" / "the workspace", never Contextspaces.
   Equazia.ai only where a product name is unavoidable (there is no brand constant; see handoff).

### 0.2 Answers to Opus's open questions (decided 10-18)

- Q1 Where: inside the Equazia repo as a module (`lib/trademark/`, `src/components/trademark/`,
  `api/trademark.mjs`), not a standalone repo. No Python.
- Q2 Reviewer identity: the signed-in Equazia account (`auth.uid()`) **and** typed initials on each
  decision, the Brief Desk / grade-card pattern.
- Q3 Foreign-filing reminders: yes, Paris Convention 6-month priority computed by default (slice 2).
- Q4 Report: an internal work file, with a letterhead/work-product export later (slice 2).

---

## 1. Where it lives, how it is reached

- **Front door: the Agents page** (`/app/agent-tasks`, surface `agentTasks`, core). Add a
  **Recipes** section with one card, "Trademark clearance — knockout search, reviewed by you".
  Pick a matter (reuse `MatterSelect`), create a clearance, navigate to the matter with
  `?tab=Trademark` (follow how the existing tabs read `?tab=`).
- **The matter: a "Trademark" tab** in `MatterspaceView.tsx`, shown only when the matter has at
  least one clearance (so every other matter's tab bar is unchanged). A matter may hold several
  clearances (several marks); the tab lists them, one open at a time.
- No new surface and no `plan_can_open` change: a tab inside a matter needs no surface, and the
  Agents page is already core.
- Sealed (SecureSpace) matters: the recipe's model calls go through the same gate as every server
  call (`gateMatterForUser` / sealed route); the deterministic parts work in any matter. A sealed
  matter never falls back to another provider; if the sealed route refuses, the stage says so and
  the reviewer can still do that step by hand.

---

## 2. The work surface (a docket, not a spectacle)

Lawyerly, linear. Plain tables. No animation. Cards that the app already makes draggable/resizable
stay so; nothing new of that kind is required.

**Header line:** MARK (as typed), applicant name, matter, created by/when, procedure version hash.

**Stage list** (the docket), one row per stage, in order:

| # | Stage | Status | Done by (initials, date) | Output |
|---|---|---|---|---|
| 1 | Intake | | | none |
| 2 | Classes | | | none |
| 3 | Search terms | | | queries table |
| 4 | Register search | | | per-query run log |
| 5 | Triage | | | hits table |
| 6 | Deep check (TSDR) | slice 2 | | |
| 7 | Web screen | slice 2 | | |
| 8 | Knockout report | | | filed document link |
| 9 | Application draft | slice 2 | | |
| 10 | Docket | slice 2 | | |

Status values: `pending`, `in_progress`, `awaiting_review`, `done`, `skipped`. A stage is marked
done by the reviewer (initials required), never by the model. Stages open in order; a later stage
may be viewed but not completed before the earlier one is done (8 needs 5 done; 5 needs 4 to have
at least one run query; 4 needs 3; 3 needs 2; 2 needs 1). Stages 6, 7, 9, 10 render as
"Not in this version" rows and may be `skipped`.

Below the docket, **one panel per stage**, rendered in order, each with its own table/form:

**Stage 1 — Intake form.** Mark (exact), mark format (standard characters | stylized), goods and
services in plain language (incl. planned), intended users, applicant block (legal name, entity
type, state, formation status: `formed` | `pending` | `individual`, formation/effective date,
domicile address, mailing address, "address is a PMB / mail drop / P.O. box?" yes/no/unknown),
known marks (name, owner, note; repeatable). Save writes Record `tm.clearance.created` (first
save) / `tm.intake.updated`.

**Stage 2 — Classes.** Two lists side by side: **Search classes** and **Filing classes**, each row
= 3-digit Nice class + one-line reason. Button "Propose classes" (model, §4) fills suggestions the
reviewer accepts/edits. Rule shown in the panel: *filing classes must be a subset of search
classes, and every filing class needs a reason that names the dated evidence of intent*. Save
writes Record `tm.classes.set` {search, filing}.

**Stage 3 — Search terms.**
- Step A, decomposition (judgment): the panel shows the mark and asks for `opening`, `hinge`,
  `ending` (lowercase; concatenation must equal the mark without spaces; multi-word marks: one
  decomposition per word, and exact/embedded queries use quotes). "Propose decomposition" (model)
  fills it with a reason and lists foreign-word resemblances (EQUAZIA resembles Italian
  *equazione*); the reviewer confirms. Also a free list of **foreign equivalents** to search.
- Step B, generation (deterministic, §3): "Generate queries" fills the queries table (seq, purpose,
  query string, class filter, live-only, Copy button). Regeneration replaces only queries not yet
  run; run queries are kept with their results. Record `tm.queries.generated` {count, procedure_hash}.
- A reviewer may add a hand-written query (purpose `manual`) at any time.

**Stage 4 — Register search (human-in-the-loop in v1).** For each query row: the string with a Copy
button, a link to the USPTO search page (`https://tmsearch.uspto.gov/search/search-information`),
and a **Record run** control with two input paths:
  1. **Manual** (primary, always works): reported count (integer, as shown by tmsearch), then rows
     keyed or pasted one per line as `serial | mark | owner | status | classes | goods/services`
     (a small parser; serial required, the rest optional). Zero rows with reported count 0 is a
     valid "no results" run only if the self-test (§3 Q0) has passed in this clearance.
  2. **Export upload**: a CSV or XLSX from tmsearch (parsed with the repo's `xlsx` package through a
     header-name mapper; see the handoff for the fixture caveat). The file itself is filed into the
     matter (`file_document`) and linked from the run (export_document_id).
  Each run computes `captured_count`, `gap` (captured differs from reported, or duplicate serials
  within the run, or the run was marked failed) and `gap_note`. Record `tm.query.run` {seq,
  reported, captured, gap, source}. A query may be re-run; the latest run is current, earlier runs
  stay.
- The **self-test** (Q0) is the first row and must be recorded before any other run counts as
  valid: a query that must return exactly one known record (`SN:<serial>` from procedure config).
  If the reviewer records anything but 1 captured row, every later run in this clearance shows the
  warning "self-test failed; syntax or system change suspected" and the report says so.

**Stage 5 — Triage.** Deduplicate across runs by serial. Dead records (status says dead, abandoned,
cancelled or expired, or `live=false`) are dropped from the scoring set but kept in the table under
"Dead (kept in the log)". The hits table: serial, mark, owner, status, classes, G/S (truncated,
expand on click), found by (query seqs), **proposed bin + two scores with reasons** (model, §4),
**decision** (Flag for review | Note | Dismiss), reason, initials, date. "Propose triage" runs the
model over the live set (batched); the reviewer decides each row (bulk-accept for a page is fine
but every row still gets its own event). Moving a hit between bins later is logged. Record
`tm.hit.proposed` {serial, bin, model} and `tm.hit.decided` {serial, bin, initials}.
Also shown: a **crowded-field count** (deterministic: how many live hits in the search classes
start with the opening), and the **exclusion check** of §3 Step Q8 (which excluded words swallowed
a known mark).

**Stage 8 — Knockout report.** "Assemble report" builds the Markdown deterministically (§5), runs
the forbidden-phrase lint, shows a preview, then "File into matter" files it via `file_document`
as `Trademark knockout report — <MARK> — <YYYY-MM-DD>.md`, marks stage 8 done with initials, and
records `tm.report.filed` {document_id, hash}. A later assembly files a new document; the old one
stays.

**Method panel** (a side panel or a sub-tab): renders the procedure JSON tables (substitutions,
endings, exclusion defaults, class notes, self-test, forbidden phrases, syntax reference)
read-only with their hash and a one-line "how to change this: a pull request to
lib/trademark/procedure".

---

## 3. Search-term generation (deterministic; the asset)

Input: confirmed decomposition `{opening, hinge, ending}` (lowercase), search classes, known marks
(name + owner), foreign equivalents, the procedure config. Output: an ordered query list. Pure
function `generateQueries()` in `lib/trademark/queries.mjs`, fully covered by the golden test (§7).

Syntax **[V 10-18, USPTO "Federal trademark searching: Field tag searching" handout]**: field tags
upper-case + colon, search terms lower-case; `CM:` combines word mark, pseudo mark, translation and
transliteration; `LD:true|false`; `IC:` 3-digit class, grouped `IC:(009 042 045 a b 200)`; `CC:`
coordinated class; `GS:` goods/services; `SN:`, `RN:`; `ON:` owner name (`ON:"world wide"`); `OW:`
owner name/address/entity; `AT:` attorney; `FD:[20230701 TO *]` filing-date range. Wildcards `?`
(one character) and `*` (any number), anywhere in a term, any field, **never inside quotes**.
Operators `AND`, `OR` or a space inside parentheses, `AND NOT`, parentheses. Combined line
searches (`1 AND 2`) need expert mode; this recipe generates single-line queries only.

Let `S = opening + hinge` (the stem, e.g. `equaz`), `E = hinge + ending` (e.g. `zia`), `Cls` =
`IC:(<search classes> a b 200)`.

```
Q0  self-test            SN:<procedure.selfTest.serial>                 expect exactly 1
Q1  exact                CM:<mark>                                      no filters
Q2  embedded stem        CM:*<S>*                                       no filters
Q3  hinge wildcard       CM:<opening>?<ending> AND LD:true
Q4  whole-word variants  CM:(<v1> <v2> ...) AND LD:true                 substitutions applied to
                                                                        hinge and ending; cap 12
Q5  substituted stems    CM:(<S'1>* <S'2>* ...) AND LD:true AND <Cls>   each substitution of the
                                                                        hinge, and of the opening's
                                                                        substitutable sounds
Q6  endings              CM:(*<E'1> *<E'2> ...) AND LD:true AND <Cls>   E with substitutions
Q7  prefix sweep         CM:<opening>* AND LD:true AND <Cls>
Q8  prefix narrowed      Q7 AND NOT CM:(<excl1>* <excl2>* ...)          built after Q7 is run (below)
Q9+ known names          CM:<name>  and  ON:"<owner>"                   one pair per known mark;
                                                                        no LD, no class filter
Q*  foreign equivalents  CM:(<w1> <w2> ...) AND LD:true AND <Cls>
```

Substitution table (procedure/substitutions.json; each row has `why`): Z to S, ZZ, X; QU to KW, Q,
K, CU; A to AH; IA to IYA, YA, EA; initial E to AE, I; doubled consonant to single and back.
Variants are generated by applying one substitution at a time, then pairs, until the cap;
duplicates and the mark itself are removed.

**Q8 narrowing (after Q7's run exists):** count the distinct words beginning with `opening` among
Q7's captured marks; propose as exclusions the dictionary-looking words above a frequency floor
(procedure/exclusions.json carries defaults per common prefix, e.g. equa: equal*, equat*,
equator*, equit*); **check each proposed exclusion against the known-marks list and against every
flagged or noted hit**: any known mark that an exclusion would swallow (EQUALL under `equal*`) gets
its own `CM:<name>` query (it already has one if it was a known mark; otherwise it is added with
purpose `rescued`). The reviewer confirms the exclusion list; Q8 is then generated. Threshold for
"too many to review" = procedure.reviewThreshold (default 75).

Class filter rule (Opus Step 8): rare strings (Q1, Q2, Q4) no class filter; broad strings (Q5 to
Q8, foreign) class-filtered; known names no filters at all so abandoned filings by the same owner
appear.

The EQUAZIA golden set this must reproduce (opening `equa`, hinge `z`, ending `ia`, classes
009/042/045, known mark EQUALL / Equall Inc., foreign `equazione equacion`):

```
Q0  SN:90562533
Q1  CM:equazia
Q2  CM:*equaz*
Q3  CM:equa?ia AND LD:true
Q4  CM:(equasia ekwazia equazzia equaxia ekwasia ...) AND LD:true
Q5  CM:(equas* ekwaz* equax* ...) AND LD:true AND IC:(009 042 045 a b 200)
Q6  CM:(*azia *azya *asia ...) AND LD:true AND IC:(009 042 045 a b 200)
Q7  CM:equa* AND LD:true AND IC:(009 042 045 a b 200)
Q8  CM:equa* AND LD:true AND IC:(009 042 045 a b 200) AND NOT CM:(equal* equat* equator* equit*)
Q9  CM:equall
Q10 ON:"equall inc"
Q11 CM:(equazione equacion) AND LD:true AND IC:(009 042 045 a b 200)
```
("..." = whatever else the table produces within the cap; the test asserts the listed members are
present and the strings are well-formed: lower-case terms, no wildcard inside quotes, balanced
parentheses, 3-digit classes.) Lesson encoded: EQUASITE (serial 90562533, Class 42, registered)
is caught by Q5 (`equas*`) and by nothing earlier, which is why Q5 is never optional.

---

## 4. Deterministic vs. model (who does what)

**Code (no model):** query generation; export and manual-row parsing; dedup; dead-record drop; gap
and overlap detection; crowded-field counts; exclusion-vs-known-marks check; report assembly; the
forbidden-phrase lint; stage gating; Record writes; (slice 2) fee math, deadline math, entity and
domicile checks, the §1060(a)(1) options text.

**Model (judgment points; each a separate labeled call, recorded as completion.requested /
completion.received with its feature label; each output a proposal the reviewer accepts or edits):**
- `trademark.decompose`: opening/hinge/ending + foreign-word resemblance, with reasons.
- `trademark.classes`: search and filing class proposals with reasons, from the intake text.
- `trademark.triage`: per live hit, mark-similarity score 1 to 5 + reason (appearance, sound,
  meaning, commercial impression; note a crowded shared element), relatedness score 1 to 5 + reason
  (against the applicant's draft identifications, not only the current product), proposed bin.
  Structured output (JSON schema), batched at most 25 hits per call.
- (slice 2) `trademark.report_prose` for optional narrative paragraphs; slice 1 prints none.

Server-side only (`api/trademark.mjs` calling `serverLlmCall`), provider anthropic, default model
`claude-opus-5-5` (one constant per call site; never Haiku or Sonnet). Sealed matters take the
sealed route or refuse. Every model output passes the forbidden-phrase lint before it is stored.

---

## 5. The knockout report (deterministic Markdown)

Filed as `.md` (the reader shows it as plain text and offers "Open in the Brief Desk"; a `.docx`
export is slice 2). The live, formatted view is the Trademark tab itself.

1. **Header**: mark, format, applicant, matter, prepared by (account + initials of the stage-8
   signer), date, procedure version hash, self-test result.
2. **Scope**: search classes with reasons; filing classes with reasons; identifications as drafted.
3. **Queries run**: table of seq, purpose, query, run date, reported count, captured, gap (Y/N +
   note), source (manual, or export + document link). Un-run queries listed under "Not run".
4. **Flagged for review**: table of serial, mark, owner, status, classes, G/S (full), similarity
   score + reason, relatedness score + reason, found by, **decision, initials, date**.
5. **Notes**: same columns, compact.
6. **Dismissed**: serial, mark, one-line reason, initials.
7. **Dead records seen**: serial, mark, status (kept for the log).
8. **Limits of this search**: fixed text: federal register only; no state registrations; no
   common-law or web screen in this version; recent filings may not yet appear; plus every gap
   from §3 verbatim; plus "self-test failed" if it did.
9. **Method**: the procedure tables as printed in the Method panel, with hash.
10. **AI assistance**: which model proposals were used (feature, model, count) and the sentence
    "Every bin and every stage sign-off was decided by the named reviewer."
11. **No conclusion line.** The template ends after §10. The reviewer writes the conclusion elsewhere.

---

## 6. Forbidden-phrase lint (code)

`lib/trademark/lint.mjs` exports `forbiddenPhrases(text)` returning `[{phrase, index, sentence}]`.
Case-insensitive; applied to every model output before storage and to the assembled report before
preview and filing. The list lives in procedure/forbidden.json with `why` per entry. Defaults:
"is clear", "are clear", "cleared", "registrable", "available for registration", "safe to file",
"will register", and "no conflicts" unless followed within 40 characters by "identified for
review". A hit blocks filing and shows the offending sentence; the reviewer edits the source (a
decision reason) or the model proposal is discarded.

---

## 7. Tests (CI steps; conventions in the handoff)

- `scripts/_test-trademark-queries.mjs` (node --test): the EQUAZIA golden set of §3; well-formedness
  rules; the EQUASITE-via-Q5 assertion; multi-word mark quoting; cap behaviour; the Q8 exclusion
  check rescues a known mark.
- `scripts/_test-trademark-triage.mjs`: fixture rows (from Opus's Part 3, serials **[M]**): dedup,
  dead drop, duplicate-serial overlap flagged, captured differs from reported flagged; the assembled
  report contains EQUALL 98137428 and EQUASITE 90562533 in the flagged table when so decided,
  EQUARA 99922464 in notes, YUEQUAZELL 99887921 dismissed, a gap line for the 392-result Q7
  overlap; the lint catches "the mark is clear" and passes "no conflicts identified for review".
- `scripts/_verify-trademark-121.mjs` (PGlite, real migration chain, real RLS): tables exist; a
  member of the matter reads/writes, a non-member reads nothing; `decided_by` is stamped from
  auth.uid(); unique (clearance_id, serial); stage rows seeded 1 to 10; stage 8 cannot be `done`
  while stage 5 is not; the events kind check accepts every `tm.*` kind and `_verify-ledger.mjs`
  still passes.

---

## 8. Slice plan

**Slice 1 (this build):** migration 121; Agents-page Recipes card; Trademark tab with stages 1 to 5
and 8; procedure JSON + Method panel; `api/trademark.mjs` with the three model actions; report
assembly + lint + filing; Record events; the three test harnesses in CI; this spec copied to
`docs/specs/TRADEMARK-CLEARANCE-2026-10-18.md`.

**Slice 2 (built 2026-10-21 except stages 7 and 10; see §10 for what was built and the corrected citations):**
- Stage 6 TSDR deep check (official API, key in env, per-serial status and prosecution history
  filed as a document per flagged hit) **[M endpoints]**.
- Stage 7 web screen (labelled as such; domains .com/.ai + misspellings; handles).
- Stage 9 application draft: entity existence on the filing date (void if not formed, TMEP
  §1201.02(b) **[M]**); domicile vs. PMB/P.O. box (37 C.F.R. §2.189, TMEP §803.05(a) **[M]**);
  **15 U.S.C. §1060(a)(1) [V 10-18, Cornell LII]**: an intent-to-use application is not assignable
  before an amendment to allege use or a statement of use "except for an assignment to a successor
  to the business of the applicant ... if that business is ongoing and existing"; when formation is
  pending, print the three options (wait; file as the individual and hold until use; successor
  exception, with care) and "do not file before <effective date>" when the applicant chose to wait;
  ID Manual template identifications only, free-form flagged with its surcharge; fees **[V 10-18,
  uspto.gov/trademarks/trademark-fee-information]**: $350/class base, $100/class insufficient
  information, $200/class free-form ID, $150/class AAU/SOU, $125/class SOU extension; bona-fide-
  intent evidence list per identification; cautions annex stripped from the filing copy.
- Stage 10 docket writes `matter_events` rows (type deadline), never without confirmation: office
  action response 3 months + optional 3-month paid extension **[V 10-18, uspto.gov/trademarks/
  maintain/responding-office-actions]** (Madrid 66(a): 6 months, no extension); SOU 6 months from
  NOA, up to five 6-month extensions **[H]**; Paris priority 6 months from filing; §8 (years 5 to
  6), §9 (year 10), §15.
- `.docx` report export with letterhead and a work-product legend; MCP tools so a connected
  assistant can propose stages 2/3/5 (Phase 2 of Opus's prompt).

---

## 9. Verification backlog carried from Opus (ordered by damage)

1. Programmatic access to tmsearch: terms of use unconfirmed, so **human-in-the-loop only** in v1 [L].
2. Malformed query = silent zero: the self-test Q0 (built in slice 1).
3. TMEP §1201.02(b) void-applicant rule [M]. 4. §2.189 / §803.05(a) domicile [M].
5. ID Manual template wording [M]. 6. Fees verified 10-18 [V]; re-verify each release.
7. TSDR API endpoints and limits [M]. 8. Bulk register data availability: see §11 (a key is required; 2026-10-21).
9. tmsearch export format ("Export, first 500 results", sign-in required) [M]: one real export from
   Eden turns the mapper fixture from hand-built to real.

---

## 10. Slice 2 as built (2026-10-21)

Built from the slice-2 build brief of 2026-10-21 and Eden's decisions of 10-20/21: stage 9 with BOTH
bases (use-based Section 1(a) and intent-to-use Section 1(b)); stage 6 in the same PR; the applicant
(Grapheon.ai, LLC for the Quorium marks) is data on the clearance; a person types the names and one
sentence and the recipe stops only at the human steps; a bot runs the same flow to the DRAFT
application. Stages 7 (web screen) and 10 (docket) remain later. Migration
`122_trademark_slice2.sql` (NOT applied until Eden approves it by name).

### 10.1 The one-box start
- Browser: the Trademark tab (and the Agents-page card) has one box: marks, one per line, and one
  sentence. One clearance per mark; the sentence is its goods and services; the model's class and
  decomposition proposals are SAVED PROPOSED (`tm_clearances.proposals`, `tm.proposal.saved`), never
  as the confirmed value.
- ONE review screen across the marks: proposals, the queries they would generate (preview), accept
  or edit, and one confirmation per mark with initials, which saves classes and decomposition,
  generates the queries and signs stages 1–3 (each sign-off its own `tm.stage.done` row). "Accept all"
  confirms each mark in turn, separately.
- ONE search sheet: every unrun query of every confirmed mark, with Copy, the tmsearch link and a
  paste/upload slot. When a mark's last query is recorded and Q0 passed, triage is proposed on its own;
  the stage-8 report preview assembles on its own. Bins and sign-offs remain the reviewer's.
- Connector: `tm_start_batch` (up to 10 marks; proposals in parallel across marks, the two steps of
  one mark in turn, inside a 40 s budget of the endpoint's 60 s), `tm_confirm` step `"proposals"`
  (both as saved, then the queries), and `next_step` at every stage through stage 9.

### 10.2 Stage 6 — the TSDR deep check
Targets: every hit triage proposed to flag (undecided) or the reviewer flagged, or marked
`tm_hits.deep_check`. Server side only: the key is `USPTO_TSDR_API_KEY` in the server env, sent only in
the request header. Stored on the hit (`tm_hits.tsdr`, `tsdr_checked_at`); one status record filed in
the matter per hit (`TSDR status — <serial> — <MARK> — <date>.md`, `tsdr_document_id`); `tm.hit.status`
and `tm.deep_check.run`. A dead record is noted, never dropped or re-binned. No key: the stage says so
and the reviewer may skip it; nothing is invented. Prerequisite: stage 6 is signed after stage 5.

TSDR API facts **[V 10-21]** — developer.uspto.gov now redirects to data.uspto.gov (a script app with
no readable text), so the documentation was read from Wayback snapshots of the developer.uspto.gov
TSDR FAQ (2024-12-25), the Enterprise API User Guide v2 (Sept. 2020) and `swagger_v1.json` (2023-03),
and the live API was probed without a key (it answers 401 and names
`https://account.uspto.gov/api-manager/`):
- host `https://tsdrapi.uspto.gov`, base `/ts/cd/`; JSON is documented only for
  `GET /ts/cd/caseMultiStatus/sn?ids=78787878,76767676` ("Returns case details for multiple cases as a
  JSON"); `casestatus/sn{serial}/info` is ST96 XML. The client uses caseMultiStatus, one request per
  batch of up to 10 serials (the batch size is **[M]**).
- auth header `USPTO-API-KEY` ("You must enter "USPTO-API-KEY" exactly"); key from the API Key Manager,
  "Select TSDR".
- "All requests are rate limited at 60 requests per API key per minute. PDF, ZIP, and multi-case
  downloads are rate limited at four requests per API key per minute"; over the limit → HTTP 429.
  Whether caseMultiStatus JSON counts as a "multi-case download" is not stated, so the client assumes
  4/minute (one request per 15 s per process). Retry-After is not documented: honoured if present,
  else 15/30/60 s backoff, then a plain failure.
- Response fields from the swagger schema, NOT from a real response (no key) **[M until Eden's key
  returns one]**: `transactionList[].trademarks[]` with `status{serialNumber, markElement, status,
  statusDate, extStatusDesc, tm5StatusDesc, usRegistrationNumber, usRegistrationDate, filingDate,
  dateAbandoned, dateCancelled}`, `parties.currentOwners[].name`, `gsList[]{description,
  internationalClasses[].code}`, `prosecutionHistory[]{entryDate, entryCode, entryDesc}`. There is no
  live/dead field: `live` is read from the TM5 / extended status text and the abandoned / cancelled
  dates, and is null when they say nothing. Unmapped top-level keys are kept (`raw_keys`).

### 10.3 Stage 9 — the application draft
Inputs: the applicant (`tm_clearances.applicant`), the filing classes, and per class
(`tm_clearances.application`): identification (ID Manual entry or free-form), in use now?, if yes the
dates of first use anywhere and in commerce and a specimen (a document in the same matter, its kind,
description, URL and access date, and a short checklist); if no, the dated bona-fide-intent evidence;
the basis (recommended by the recipe; chosen by the person; confirmed by the reviewer's sign-off); and
the transfer plan. Output: a DRAFT in TEAS order (applicant, mark, classes and identifications, basis
and dates, specimens, what the declaration verifies, fees) and a SEPARATE cautions annex, both filed in
the matter (`tm.application.drafted`); stage 9 `awaiting_review`. The reviewer's sign-off in the browser
files the reviewed copy and signs stage 9 (`tm.application.reviewed`). Prerequisites (migration 122):
stage 9 needs stage 8 done, stage 6 done or skipped, and its document. Nothing is filed with the USPTO.

The rules the draft prints live in `lib/trademark/filing/rules.json`, each with its source and
verification date; the draft prints `[V date, source]` or `[M]`. Verified 2026-10-21 (Cornell LII for
the statute and the C.F.R.; the TMEP May 2026 edition at tmep.uspto.gov):
- **15 U.S.C. § 1051(a), (b)** [V 10-21]: use-based application with verified statement and specimens;
  intent-to-use on "a bona fide intention, under circumstances showing the good faith of such person";
  the verified statements of (a)(3) and (b)(3) (paraphrased in the draft's §6).
- **15 U.S.C. § 1127** [V 10-21]: "use in commerce" is "the bona fide use of a mark in the ordinary
  course of trade, and not made merely to reserve a right in a mark"; goods: placed on the goods,
  containers, displays, tags or labels, and sold or transported in commerce; services: "used or
  displayed in the sale or advertising of services and the services are rendered in commerce".
- **15 U.S.C. § 1060(a)(1)** [V 10-21]: assignable with the goodwill; no § 1051(b) application
  assignable before an allegation of use "except for an assignment to a successor to the business of
  the applicant, or portion thereof, to which the mark pertains, if that business is ongoing and
  existing."
- **37 C.F.R. § 2.34(a)(1)–(2)** [V 10-21]: dates of first use anywhere and in commerce, one specimen;
  the bona fide intention verified.
- **37 C.F.R. § 2.56(b)(1)–(2), (c)** [V 10-21]: goods and service-mark specimens; "A web page must
  include the URL and access or print date"; renderings, proofs, illustrations, digital images or
  similar mockups are not proper specimens. **TMEP § 904.04(a)** [V 10-21]: digitally created / altered
  or mocked-up images. **TMEP § 904.03(i)** [V 10-21]: a web page is a display associated with the goods
  when it shows the goods, the mark with them, and a means of ordering. **TMEP §§ 904.07(a)–(b)**.
- **TMEP § 1301.04(f)(ii)** [V 10-21]: a direct association between the mark and the services.
  **TMEP § 1301.03(a)** [V 10-21] (not 1301.04(h)/(i), as the brief guessed): "the use of a mark in the
  announcement of a future service ... does not constitute use as a service mark."
- **TMEP §§ 1301.01(a)(i), 1301.02(e)–(f)** [V 10-21]: a system, process, method or computer program
  name is not a service mark unless it also identifies a service (the "feature name / in-product unit"
  flag).
- Payment not required for services: **[M]** — no express TMEP statement was found; the closest is
  1301.01(a)(i)–(ii) (a real activity for others' benefit) and 1301.01(b)(i) (free instructional
  parties held a service). The draft prints it with [M].
- **TMEP § 1201.02(b)** [V 10-21]: the application must be filed by the owner on the filing date;
  wrong-party filings are void and not curable by amendment or assignment. **Correction to §8:** TMEP
  § 1201.02(c)(7) lets the name of a party that did not exist on the filing date be corrected in some
  cases, so the product does not say "a non-existent entity's application is void"; it says file only
  when the applicant exists and not to plan around 1201.02(c)(7).
- **Domicile** [V 10-21]: 37 C.F.R. § 2.189 (domicile required) with § 2.2(o) (definition). **Correction to
  §8:** the P.O. box / PMB rule is TMEP § 601.01(c)(i) ("presumptively unacceptable" as domicile), not
  § 2.189 itself; TMEP § 803.05(a); a foreign-domiciled applicant needs a U.S. attorney, 37 C.F.R.
  § 2.11(a).
- **Statement of use** [V 10-21]: due six months after the notice of allowance (37 C.F.R. § 2.88);
  extensions in six-month increments, one plus up to four more, aggregate cap (§ 2.89(a), (c); TMEP
  § 1108.01).
- *M.Z. Berger & Co. v. Swatch AG*, 787 F.3d 1368 (Fed. Cir. 2015): **[M]**, as cited in §0.1; not
  re-read for this build.
- The TEAS declaration's own false-statement warning: **[M]**, the draft points the signer to the form.

Fees **[V 10-21]**, uspto.gov/trademarks/trademark-fee-information ("Last updated on: Jan 18, 2025",
fiscal year 2025 fee rule) corroborated against 37 C.F.R. § 2.6 (Cornell LII, through 89 FR 91089):
$350/class base (electronic); $100/class insufficient information; $200/class free-form text
identification; $200/class for each additional 1,000 characters beyond the first 1,000 (free-form);
$150/class allegation of use (AAU or SOU); $125/class per SOU extension. Re-verify on the day of filing.

Advisory specimen check (the reviewer decides; nothing rejects a specimen): mark absent; a mockup or
edited image; use merely to reserve the name; the term only as a feature's name or an in-product unit;
a webpage without URL or access date; services: "coming soon"/waitlist (not yet rendered), no
association with the services; goods: advertising as a goods specimen, a webpage with no means of
ordering, goods not sold or transported. Basis recommendation: not in use → 1(b); in use with both
dates, a specimen and no flag → 1(a); in use but missing a date or specimen, or flagged → 1(b) until
fixed. Entity: applicant not formed → the 1201.02 rule and "do not file before <formation date>";
marks moving to an entity not yet formed → the three options (wait; file now as the existing applicant
and move the marks later with the business; successor exception, with care), the § 1060(a)(1) bar
printed for 1(b) classes, and for 1(a) classes "no such bar; goodwill must travel".

### 10.4 Who can do what
A connector (any `csp_` token, OAuth grant or agent) can start, propose, relay acceptance and answers,
record runs, ask for triage proposals, run the deep check and file DRAFTs; it cannot sign a stage or
decide a bin — migration 122 refuses both under a connector JWT (`cs_via: 'connector'`), in addition to
there being no tool for it. Every Record row a bot causes is the connector's.

### 10.5 Open questions (for Eden)
1. The TSDR field mapping is from the swagger schema; confirm with the first real response (Eden's key).
2. Whether caseMultiStatus is limited at 4/minute or 60/minute; the client assumes 4.
3. Whether the bot should file DRAFTs into the matter (built: yes, marked DRAFT — NOT REVIEWED) or only
   return the text, as `tm_report` does.
4. `tm_deep_check` / `tm_application_draft` file documents through `file_document` inside the tool call;
   the connector meter counts the outer call as WORK and does not charge the inner filing.
5. Stage 7 (web screen) and stage 10 (docket) are still to build; the docket's deadlines are in the annex.

---

## 11. The register copy: the agent searches Equazia's own copy of the USPTO register (2026-10-21)

Built from the brief of 2026-10-21 and Eden's scope memo of the same day. The agent can run the
knockout queries itself against Equazia's own copy of the federal register, built from the USPTO's
free bulk XML and refreshed daily. tmsearch stays the official cross-check. Every run records its
source and the copy's as-of date. **Everything sits behind configuration:** with
`TM_REGISTER_DB_URL` unset the recipe behaves exactly as before (same tool list, same `next_step`
text, same report), and stage 4 says the copy is "not available". Migration
`123_trademark_register_copy.sql` (NOT applied until Eden approves it by name).

### 11.1 Phase 0 facts (2026-10-21)

**Access.** A key is needed. [V 10-21]
- `bulkdata.uspto.gov` (the old Bulk Data Storage System) no longer resolves (DNS, 2026-10-21).
- The Open Data Portal's download endpoint is
  `GET https://api.uspto.gov/api/v1/datasets/products/files/{productIdentifier}/{fileName}`.
  Its page (data.uspto.gov/apis/bulk-data/download, read in a browser) says "API Key is required".
  Probed: no key gives 401, a wrong key in `X-API-KEY` gives 403 (the CORS allow-list names
  `X-Api-Key`).
- The portal's website also needs a sign-in. From June 18, 2026 it requires a USPTO.gov account
  with MFA. The getting-started page says website downloads need no API key, but the sign-in still
  applies, and a sign-in is the person's to do.
- How the key is minted (data.uspto.gov/apis/getting-started):
  1. a USPTO.gov account with the "Open Data Portal" profile fields filled in (required since
     August 18, 2026; keys of accounts without them were deactivated October 8, 2026);
  2. an ID.me account, verified and linked;
  3. "Manage API Key" at data.uspto.gov.

  It is one key per account, and it is NOT the TSDR key from account.uspto.gov/api-manager.
- Placeholder: `C:\Users\equai\DO-NOT-SEND-keys\uspto-odp.env` (`USPTO_ODP_API_KEY=`).
- Rate limits (data.uspto.gov/apis/api-rate-limits):
  - one API call at a time per key;
  - up to 5 files per 10 seconds per IP;
  - 20 downloads of the same file per year per key ("except for XML files which has a much higher
    limit");
  - downloads redirect to a signed URL that expires in 5 seconds.
- The data is public domain: data.gov's catalog lists license `creativecommons.org/publicdomain/mark/1.0`
  and access level "public".

**Product, naming, cadence, sizes.**
- Daily applications: product `TRTDXFAP`, "Trademark Full Text XML Data (No Images)". data.gov's
  "Trademark Application XML (1884 - Present)" links `data.uspto.gov/bulkdata/datasets/trtdxfap`,
  with accrual periodicity R/P1D (daily).
- Daily files are `apcYYMMDD.zip`, one per calendar day, weekends included.
- The annual backfile is `apc18840407-YYYYMMDD-NN.zip`. The backfile through 2023-12-31 had 75
  pieces.
- Sizes are from the BDSS directory listing (Wayback snapshot of 2025-03-07; the live listing needs
  the key):
  - backfile: 75 pieces, **8,168,666,367 bytes zipped** (smallest 4.0 MB, largest 228.8 MB);
  - dailies (431 files, 2024-01-01 to 2025-03-06): median **24.3 MB** zipped, mean 27.0 MB.
- The listing also shows the DTD documentation versions:
  - 2.0 (to April 12, 2024);
  - 2.1;
  - 2.2;
  - **2.3 (from October 18, 2024)**.

  The element documentation read for this build is V 2.0 (uspto.gov/sites/default/files/products/
  applications-documentation.pdf), so the parser records each file's `version-no` and ignores
  elements it does not know.
- The product name for the annual backfile on the ODP is **not confirmed**. A secondary source says
  `TRTAXMLA` [M].

**Sample.** **None was downloaded.** The key is required, so the download part stopped as the brief
says. An unofficial route exists: the Internet Archive holds copies of old BDSS files (for example
`apc18840407-20191231-01.zip`, about 0.7 MB, and the status-code table
`Table1TrademarkStatusCodes_20230620.doc`). It was not used, because the brief limits downloads to
the documented routes. Eden may authorize it (§11.6).

**Record count: not measured.** The estimate and its method:
- Serial numbers are a 2-digit series code plus a 6-digit number [V DTD doc], so a series holds at
  most 1,000,000 serials.
- Eden's 10-18 export (392 rows) shows 18 series in use (50, 72–79, 85–90, 97–99).
- That gives an upper bound of 18 × 1,000,000 = **18M**.
- Several series are partly filled: 50 opened in 2026, and 89 is a small "non-registration data"
  series.
- A secondary source puts the corpus at about 12.7M records [M, not verified].
- **Working estimate: 10–13M records [M].**
- The first real backfile piece settles it: its record count × 75 pieces, corrected by its zipped
  size against 8.17 GB.

**Field list (DTD V 2.0) and what the copy keeps.**
- Kept: serial, registration number, transaction date, filing date, registration date, status code,
  status date, mark (`mark-identification`), mark drawing code, abandonment date, cancellation date,
  attorney.
- Kept from the statements (`type-code` + `text`):
  - GS*ccc*1/2/3: goods and services per prime class;
  - **PM: pseudo mark (present; "PM – Pseudo Mark", Note 7)**;
  - TR: translation;
  - TLIT: transliteration.
- Kept from the classifications: international and US codes, primary code, and the class status.
- Kept from the owners: party type, name and entity.
- Kept: design search codes (6 digits).
- Read but not stored: event statements, prior registrations, foreign applications, the international
  registration and the Madrid history.

**Live or dead.** The bulk data has no live/dead flag.
- The status code refers to "Table 1 Trademark Status Codes", a separate product file that was not
  read.
- `lib/trademark/register/status-codes.json` therefore treats a record as dead **only** when its
  abandonment date or cancellation date is present. Every status code alone counts as live [M].
- A first draft treated the 600 series as abandoned. The 600 series also holds live examination
  statuses [M], so that rule would have dropped live pending applications from every `LD:true`
  query. Fill the table from Table 1 once it is read.

**Loaded size per 100,000 records, with every index** (`scripts/tm-register/measure.mjs`; PGlite
0.5.8 = Postgres 18.3, **synthetic rows**). The rows are cloned from the fixture's real tmsearch
text, and tmsearch truncates goods at about 1,000 characters.

| | Size |
|---|---|
| Heap, with TOAST | 131.5 MB |
| Indexes | 62.0 MB |
| **Total** | **195.2 MB** (2,047 bytes per record) |

- The largest indexes are trigram on the CM variants (17.3 MB), on owners (13.8 MB) and on the
  joined mark (13.4 MB).
- Loading took 14 s.
- The EQUAZIA query set ran in 3–364 ms per query on one CPU (Q7, the 35k-match prefix sweep, was
  the slowest).
- Real rows carry the full goods text and more distinct marks, so read 2 KB/record as a **floor**.
  The estimate uses 2–5 KB/record [L].

**Hosting estimate.** Size = 10–13M records × 2–5 KB = **20–65 GB** (working figure: about 40 GB).
Prices were read 2026-10-21.

(a) A dedicated Supabase project. Source: supabase.com/pricing and
supabase.com/docs/guides/platform/compute-and-disk.
- The figures used:
  - Pro is "from $25/month";
  - "Additional projects each add their own compute cost";
  - each project includes 8 GB of disk, with extra disk at $0.125 per GB;
  - compute: Small about $15 (2 GB RAM, recommended to 50 GB), Medium about $60 (4 GB, to 100 GB),
    Large about $110 (8 GB, dedicated 2 vCPU).
- Medium + (40 − 8) GB × $0.125 = $60 + $4 = **about $64/month**. At 65 GB:
  $60 + 57 × $0.125 = **about $67**.
- Small (about $15 + $4 = **about $19**) fits only the low end of the size range, and its 2 GB RAM
  is thin for trigram scans over about 12M rows.
- If Equazia's organization is already on Pro, no second plan fee applies [M: confirm on the
  invoice].

(b) Postgres on a small VM. Source: digitalocean.com/pricing/droplets, Basic.
- 8 GiB RAM, 4 vCPU, 160 GiB SSD: **$48/month**. This fits 65 GB with room for the load and the
  WAL.
- 4 GiB, 2 vCPU, 80 GiB: **$24/month**. This fits the working figure; it is tight at 65 GB.
- Backups are extra.
- Hetzner's regular-performance cloud servers start at €6.49/month (hetzner.com/cloud; specs and
  USD prices were not shown on that page).
- One VM can also host Quorium's Archie worker and the daily update.

**Recommendation:** the VM ($24–48) if the worker host is being set up anyway. Otherwise Supabase
Medium (about $64), which is simplest to run. Decide after the first real backfile piece is loaded
and measured.

### 11.2 What was built

- **Schema** `db/tm-register/schema.sql` (a separate database; not in `supabase/migrations`):
  - `register_records`: one row per serial.
  - Search columns:
    - `cm_text`: every CM variant (word mark, pseudo marks, translation and transliteration
      segments, and the numeral reading when there is no pseudo mark), each as words and run
      together;
    - `mark_joined`, `owner_text`, `gs_text`;
    - `dm_codes`: Double Metaphone codes of the joined mark and of each word (fuzzystrmatch).
  - Indexes:
    - trigram on `cm_text`, `mark_joined` and `owner_text`;
    - prefix and suffix btree on `mark_joined`;
    - GIN on `dm_codes` and on `int_classes`;
    - live.
  - `register_files`: each loaded file, with its sha256, DTD version and counts.
  - `register_meta`: `as_of` and `stale_after_days`.
  - `register_gate`: append-only recall runs.
- **Loader** (`lib/trademark/register/{xml,normalize,load}.mjs`, CLI `scripts/tm-register/load.mjs`):
  - streams the XML through `sax`, never the whole file in memory;
  - zip entries are read with `node-stream-zip`;
  - upserts by serial, and only a file with the same or a later as-of date replaces a row;
  - a file already loaded with the same sha256 is skipped;
  - each file loads in one transaction, so a broken file leaves the copy as it was.
- **Normalization** (see normalize.mjs): NFKD, accents dropped, lower case; apostrophes removed;
  `&` becomes "and", `+` "plus", `@` "at"; everything else is a word break; numerals become words
  only when the record has no pseudo mark.
- **Daily update** (`lib/trademark/register/daily.mjs`, CLI `scripts/tm-register/daily.mjs`):
  - fetches every day from as_of + 1 to yesterday, in order, one at a time;
  - the key goes to api.uspto.gov only; the signed redirect is followed without it;
  - it stamps `as_of` only through the last day of an unbroken run;
  - a failure stops the run there, as_of does not move, and once as_of is older than the threshold
    the copy is stale.
- **The stale rule:** more than `stale_after_days` days behind (default 3; `TM_REGISTER_STALE_DAYS`
  overrides).
- **Search** (`lib/trademark/register/search.mjs`): it parses each generated query string and
  translates it to one SQL WHERE clause.
  - `CM:` term matching reproduces `queries.mjs termMatchesMark` (a whole word of any variant, or the
    whole run-together variant). The tests check the parity record by record on every EQUAZIA query.
  - Supported: SN, RN, LD, IC (including A, B, 200), ON, OW (owner names only), AT, GS, FD ranges,
    AND / OR / AND NOT / parentheses.
  - **Not expressible** (refused, never approximated): `CC:` (coordinated class, which needs the
    USPTO coordination table, absent from the bulk XML) and any other tag.
  - Results are run rows, at most 500: live before dead, then by closeness (trigram similarity) and
    a sound-alike flag (Double Metaphone), with the class overlap. The full match count is the run's
    reported count, so a capped run records a gap.
  - tmsearch's own tokenization is not published [M]. The recall gate is the control.
- **Recall gate** (`lib/trademark/register/recall.mjs`, CLI `scripts/tm-register/recall.mjs`).
  - Test-set format `equazia-tm-recall/1`: per mark, the decomposition, the classes, the known
    marks, and tmsearch's `live_conflicts`, plus optional recorded tmsearch queries with their
    serials for diagnostics.
  - The run generates the agent's queries and runs them on the copy; a miss is a live conflict
    tmsearch found and the copy did not.
  - A PASS needs zero misses AND at least 50 marks (`TM_REGISTER_GATE_MIN_MARKS`).
  - `--store` appends the result to `register_gate` with the test set's sha256, the engine version
    and the as-of date.
  - The copy stands on its own only while the **latest** run for the **current** engine passed.
- **Equazia side:**
  - Migration 123 lets `tm_query_runs.source` take `register_copy` and adds `register_as_of` and
    `register_preliminary`. Stage 4 cannot be signed while any query's current run is a
    preliminary register run.
  - `lib/trademark/register/service.mjs` holds `storeRun`, which `tm_record_results` now also uses
    (one sequence for every run), and `registerSearch`.
  - Connector tool `tm_run_search {clearance_id, query_ids?}`. It is listed only when
    `TM_REGISTER_DB_URL` is set.
  - `next_step`:
    - gate passed: "call tm_run_search";
    - not passed: the tmsearch queries, with the copy named as preliminary, then "confirm Qn on
      tmsearch";
    - stale: a plain fallback sentence.
  - Browser: `/api/trademark` actions `register_status` and `register_search`, and stage 4's choice
    (`RegisterChoice.tsx`) in both the stage panel and the search sheet.
  - The report adds a source line, a scope line and, when it applies, a preliminary line, but only
    when register runs exist.

### 11.3 Seed and coverage

`scripts/fixtures/tm-register/` holds SYNTHETIC files in the documented shape, built by
`scripts/tm-register/make-fixture.mjs` from:
- Eden's real tmsearch export of 2026-10-18: 392 rows of
  `CM:equa* AND LD:true AND IC:(009 042 045 a b 200)`, giving serial, mark, owner, truncated goods,
  classes and dates;
- six records named in his 10-19 notes;
- six INVENTED records (serials 76999901–07).

Status codes, pseudo marks and translations of the real rows are not known and are left out.

The seed recall set (`recall-seed-2026-10-21.json`) is EQUAZIA, with live conflicts EQUALL 98137428
and EQUASITE 90562533 (Opus's 10-18 "watch" proposals, not decided bins).

On the fixture:
- Both live conflicts are found: EQUASITE by Q5 and Q7, EQUALL by Q7, Q9 and Q10. The seed is
  **not a pass** (one mark).
- The diagnostics re-run tmsearch's own Q7 on the copy, which finds 216 of tmsearch's 392.
  - The 177 records tmsearch found and the fixture copy did not (EXOTEQ, EQUISPLIT, AXISEQ, DOWA,
    YAMAWAKE, "PRIVACY = …", "+-=÷X" …) match `equa*` only through fields the export does not carry:
    pseudo marks (for example "=" read as EQUAL[S]) and translations.
  - This shows how much the CM: field depends on the pseudo mark and translation statements. The
    real bulk data carries them; the first real load must be rerun through the seed to confirm.
- Because the fixture was built from the same tmsearch rows, the seed tests the query translation
  and the matching rule here, not the completeness of a real copy.

### 11.4 Not verified

- Every claim about the real files beyond the V 2.0 documentation and the 2025-03-07 listing:
  - the v2.3 element changes;
  - the backfile's ODP product id;
  - the record count;
  - the real bytes per record;
  - Table 1's live and dead codes;
  - whether a 40-character `<text>` overflow is split across several `<text>` elements (the parser
    joins them with a space) [M].
- tmsearch's tokenization of marks and pseudo marks [M].
- The `postgres://` adapter (driver `postgres` 3.4.9) has not been run against a hosted Postgres;
  everything ran on PGlite.

### 11.5 What it will not do

- It covers the federal register only.
- It does no design-mark image comparison (design codes only).
- It covers no state or common-law marks.
- It is one or two days behind the register.

The report says so in its Limits section whenever a register run is in it.

### 11.6 For Eden

1. **The ODP key:** mint it as §11.1 describes and put it in `DO-NOT-SEND-keys\uspto-odp.env`.
   With it, the first daily file and the smallest backfile piece go into
   `C:\Users\equai\context-ai-scratch\uspto-bulk\`, followed by the count, the measured size and a
   rerun of the seed.
   - Alternatively, authorize the Internet Archive copy of the smallest 2019 backfile piece and the
     status-code table as a stop-gap sample.
2. **Hosting** (§11.1): a VM ($24–48/month) or a dedicated Supabase project (about $64/month).
   Decide after the first real piece is measured.
3. **The recall test set:** about 50 marks, real and invented, including known conflicts, each run
   on tmsearch once by Eden or a paralegal, with the live conflicts recorded in the
   `equazia-tm-recall/1` format. Until it passes, every register result is "preliminary: confirm on
   tmsearch".
4. **Migration 123:** approve and apply it by name before turning the feature on (`TM_REGISTER_DB_URL`).
