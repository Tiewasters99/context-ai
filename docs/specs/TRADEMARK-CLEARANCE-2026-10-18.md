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
7. TSDR API endpoints and limits [M]. 8. Bulk register data availability [L].
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
