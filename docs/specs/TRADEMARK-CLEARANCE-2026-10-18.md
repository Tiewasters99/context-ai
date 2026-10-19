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
- `scripts/_test-trademark-triage.mjs`: fixture rows (Eden's run of 10-18, corrected 10-19 from his own
  screenshots and exports; Q0 and Q5 synthetic, see the fixture's `_note`): dedup,
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

**Slice 2 (not now; design the data for it):**
- Stage 6 TSDR deep check (official API, key in env, per-serial status and prosecution history
  filed as a document per flagged hit) **[M endpoints]**.
- Stage 7 web screen (labelled as such; domains .com/.ai + misspellings; handles).
- Stage 9 application draft: entity existence on the filing date (void if not formed, TMEP
  §1201.02(b) **[M]**); domicile vs. PMB/P.O. box (37 C.F.R. §2.189, TMEP §803.05(a) **[V 10-19]**:
  an address that does not identify an actual street address or that functions as a mail
  forwarding address generally may not serve as a domicile address, cross-ref §601.01(c); for a
  juristic entity the domicile is the principal place of business; verified from eCFR and the
  BitLaw TMEP May 2024 ed. PDFs Eden downloaded 10-18);
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
3. TMEP §1201.02(b) void-applicant rule [M]. 4. §2.189 / §803.05(a) domicile **[V 10-19]** (see stage 9 above).
5. ID Manual template wording [M]. 6. Fees verified 10-18 [V]; re-verify each release.
7. TSDR API endpoints and limits [M]. 8. Bulk register data availability [L].
9. tmsearch export format **[V 10-19]** from two real files of Eden's 10-18 run ("Results on page" =
   50 rows; "First 500 results" = all 392; no sign-in was needed for either): sheet `tmSearch`,
   three preamble rows (`Search results from 1 to N` / `Search term | | <query>` / blank), then
   SerialNumber, Wordmark, Image, Status, GoodsAndServicesTruncated, Basis, FiledDate,
   InternationalClass, OwnerFullText, PriorityDate, RegistrationDate, RegistrationNumber,
   RegistrationType, SupplementalRegistrationDate. Status is only Live/Dead; the class cell is
   `IC 045 IC 042`, `200.` or every class with a trailing period. The mapper fixture is now real
   (page 1, images stripped). The 392-row export had 392 distinct serials: the overlap Opus saw
   between pages 4 and 5 on screen was a display artefact, not missing records.
10. Q8 exclusion picker needs a typed stem [found 10-19]: the proposer offers only stems it mined from
    Q7's captured marks (equal, equat, equator, equan for EQUAZIA); the real run excluded `equit*`
    too, which it never offered, so Opus's exact narrowed line lives as manual Q102 and Q8 stays
    unconfirmed. Add a free-text stem input beside the checkboxes.
11. Provider refuses a forced `tool_choice` for claude-opus-5-5 [V 10-19, HTTP 400]: every model
    action was dead until model.mjs switched to `auto` + a system line. Any new structured call
    on this model must do the same (lib/describe-image-anthropic already knew).

## 10. What a first-timer asked (from Eden's run with Opus, Oct 11–18; answer these in the stage copy)

The back-and-forth of the EQUAZIA run is the best evidence of what the recipe's copy must say
without being asked. Each question below was asked, in these words or close to them, by a lawyer
doing a knockout search for the first time. The stage that owns the answer is in brackets. None
of this is a conclusion about any mark; it is the explanatory layer the surface owes the reviewer
("explain, don't constrain").

1. "What is a knockout search, and how is it different from the web screen we did?" [stage 1 note:
   a quick look at the federal register for live marks that look or sound like yours for related
   goods; not a clearance opinion; the web screen covers unregistered users, the register covers
   what an examiner would cite.]
2. "What do the pieces of the search mean?" [stage 3, Method panel: the exact term, the embedded
   wildcard, the broad prefix, the known name; `CM:` searches the mark fields; `LD:true` keeps
   live records; `IC:(…)` limits by class; `a b 200` adds certification and collective marks.]
3. "Do I type the whole line including `CM:`? Caps? Spaces?" [stage 4 note: paste the line exactly;
   field tag in caps with the colon, no space after it, terms lowercase, AND/OR in caps with a
   space each side; if the box rejects it, switch on expert mode.]
4. "Why these classes, and why 45 if we are not filing in it?" [stage 2: search classes vs. filing
   classes; 45 because the users are lawyers; filing only where there is bona fide intent.]
5. "What is live vs. dead, and does a pending application count?" [stage 5 note: a pending
   application counts; if it registers, its filing date gives priority; dead records generally
   cannot block, which is why they are listed apart.]
6. "392 results — do I have to read them all?" [stage 4: no; the narrowed sweep (Q8) exists for
   this; a scroll through 392 cards is not a review and the recipe never pretends it was.]
7. "The export did nothing." [stage 4: browser download or pop-up block; try "First 500 results";
   no sign-in was needed in the real run; if it still fails, record the run by hand from the screen
   and mark the gap.]
8. "Two pages showed the same marks." [stage 4: record what you saw; the database marks a repeated
   serial as a gap; a full export closes it.]
9. "What am I looking for in each result?" [stage 5 note: does a LIVE mark both resemble the
   proposed mark and cover related goods or services; if either half is missing, note or dismiss;
   open only the close ones and read their goods.]
10. "Is the empty result real or did I type it wrong?" [stage 4: the self-test Q0; a zero on a
    malformed line looks identical to a true zero.]
11. "Which of these are a real problem?" [stage 5: the model may propose a bin with reasons; the
    reviewer decides each bin with initials; the report never says clear.]
12. "Can the agent run the searches for me?" [Method panel: not in v1; tmsearch's terms of use for
    programmatic access are unconfirmed; the reviewer runs each line and records it.]
13. Not the recipe's job, but it cost half the session: the USPTO.gov account and its authenticator
    enrolment. Stage 9 should say up front that searching needs no account and filing does, and
    link the USPTO's own setup page rather than troubleshoot inline.
14. "Why is the new company the applicant at all? Couldn't the parent that already exists file?"
    (Eden, 10-19) [stage 9 note: which entity files turns on who will own the brand when shares
    are sold and on whether use has begun. 15 U.S.C. §1060(a)(1) [V 10-18] bars assigning an
    intent-to-use application before an amendment to allege use or a statement of use, except to
    a successor to the ongoing business; an assignment outside that voids the application. So:
    (1) wait for the entity and file in its name, cleanest when its shares will be sold; (2) if
    use has begun, the parent files under §1(a) and assigns freely with the goodwill; (3) the
    parent files intent-to-use and keeps the mark, licensing it to the subsidiary (use by a
    related company inures to the owner), which leaves the brand outside the company being sold;
    (4) parent files intent-to-use and assigns as successor when the business is contributed —
    textually within the exception, the riskiest path. Whichever, the code, domains and brand
    must be assigned into the applicant by a separate agreement.]

