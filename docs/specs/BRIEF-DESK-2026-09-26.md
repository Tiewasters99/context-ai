# The Brief Desk — one spec, four slices

**Date:** 2026-09-26 · **Status:** spec; Eden's decisions in §2 gate the build · **Working name:** "the Brief Desk" and the verb "Confirm this brief" — Eden renames · **Builds on:** `cite_check_runs` (015), the Westlaw star-page pass (#221, `lib/westlaw-pages.mjs`, `lib/cite-page.mjs`), the Reader (`src/pages/DocumentReader.tsx`), marginalia (048/084), the Editor's anchoring (`src/lib/editor/verifier.ts`), the Pages editor (`src/components/content/Editor.tsx`), the ledger (064/072/073), agent tasks (085/089) · **Related specs, unbuilt:** `W6-document-states-and-citation-verification.md` (verify control, gates) and the Cite Verification Record memo of 09-16 (attestations, corrections). This spec is the surface those two attach to; it does not build them.

## 0. The sentence

You load your brief and open it. Page 1 cites *Owen v. Jones*. You click the cite and *Owen v. Jones* opens beside the brief at the pinned page. A third panel lists every cite with its flag and a one-line note. You rewrite the paragraph in place, because the brief is an editor, not a picture. When you are done you export your words: as markdown, as a plain Word file, or to your own assistant, which formats them in your house style.

Eden's V1, in his words: "side by side cite checker, text editor that you can export back to Claude and have Claude reformat to a Word document. So my output is not perfect Word but it captures my words." The north star (not this build) is the whole loop in one place with an engine of our own; §5 says what this build does to keep that door open.

Four rules that decide arguments later:

1. **The draft is text we own; Word is an export.** No in-place .docx editing. A Word file coming in is accepted with a plain list of what did not survive. (§1 shows why: mammoth drops footnotes, numbering and styles; the `docx` library rebuilds rather than patches.)
2. **The interchange format is the master.md dialect Eden's Webster build already reads.** One string serves four jobs: what the editor saves, what the cite-check anchors to, what the export downloads, and what the assistant receives. The house-style build (`build_reply_webster.py` in the `brief-format` skill) consumes it today.
3. **Cites are marks on the text, and the table is derived from the marks.** Editing moves the marks with the words; the table never drifts from the brief. A mark whose words changed since the check says so.
4. **Resolution is code, not a model.** Cite → corpus document and pincite → passage are deterministic lookups over metadata the ingest pass already writes. The model is used where it is used today (extracting cites, rating support) and nowhere new.

## 1. What exists (verified 2026-09-26 against `origin/main` 8e7cf38)

| Area | State | Where |
| --- | --- | --- |
| Cite extraction | **LLM-only** (`generateStructured`, tool `record_citations`, default `claude-opus-4-8`). Each cite carries `raw` and an ~80-char `location` snippet; a contract check drops any cite whose `raw`/`location` is not found in the draft. Cap 1,500. | `src/lib/cite-check/extract-cites.ts:287-319, 153-253` |
| Cite matching | **Never against the matter corpus.** Exact `citation_bluebook` match on the shared `authorities` table (community or own), then `/api/legal-source` (CourtListener, Cornell, eCFR, NY Senate), then an LLM rating on the first 4,000 chars. | `src/lib/cite-check/check.ts:183-310`, `persist.ts:54-73` |
| Pincite check | String compare of the draft pin against `authority_propositions.pin_cite` (case + proposition only). Nothing touches `passages` or printed pages. | `check.ts:270-279` |
| Run persistence | `cite_check_runs`: `document_id` (nullable FK), `report jsonb` = `ReportEntry[]` (`citation, case_name, authority_type, proposition, pin, signal, flag, verification_status, rating, source_label, source_url, note, flags, location, authority_id`), `counts`, `toa_markdown`, `report_markdown`. `note` is the model's justification. **No user note per cite.** | 015, `types.ts:105-121`, `run.ts:59-69,116-127` |
| Cite-Check UI | `CiteCheckSurface` mounted as a matter tab and a Vault view; input = upload (.docx/.pdf/.txt/.md) or `CorpusDocumentPicker` or paste; results = a flag-sorted list with `CiteDetail`; two .md downloads. Runs are **client-side** (dozens of LLM calls). Sealed matters rate through the sealed pen. | `src/components/matter/CiteCheckSurface.tsx`, `MatterspaceView.tsx:450`, `Vault.tsx:812` |
| Star pages / pincites | **Only in `passages.metadata`**: `printed_page`, `printed_page_end`, `pdf_page`, `page_source`, `printed_page_method`, `star_pages {"2":[a,b]}` for parallel reporters; `bluebook_cite` = full cite with pin. Written at ingest and by the #221 backfill. **No index, no RPC** resolves "p. 1221" to a passage. `citePage(row)` gives `printed | pdf_index_declined | unknown` + caveat. | `lib/westlaw-pages.mjs:212-223`, `lib/ingest-core.mjs:1030-1056`, `lib/cite-page.mjs:115-167` |
| Case identity on a document | `documents.metadata.westlaw_case = {kind:'case', case_name, reporters:[{volume,reporter,page}] (≤3), wl, docket, court, date}`; `documents.category` (081) = `case | statute | rule | secondary | pleading | supporting | other`. **No `document_citations` table.** | `ingest-core.mjs:1050-1055`, `lib/bluebook.mjs:304-444, 667-676`, 081 |
| Reader | Route `/app/document/:id`; `DocumentReader({id, embedded, onClose})`; already embedded as a canvas card. Navigation: `gotoPage(p)` and `?page=N` **read from the page's URL** (PDF only); **no passage navigation**. DOCX renders as one mammoth page (`totalPages = 1`); text via `findInRendered`. Highlights/notes = `document_annotations` (page + fractional rects for PDF; `text_anchor {start,end,exact,prefix,suffix}` for text) with cross-links in `annotation_links`. No split view. | `DocumentReader.tsx:255, 708-714, 763, 775, 592, 2173`, `src/lib/document-annotations.ts`, `src/lib/text-anchor.ts` |
| Rich-text editor | TipTap 3.22 (`StarterKit`, `Link`, `Placeholder`); toolbar bold/italic/strike/code/H1-3/lists/quote/link/undo; saves TipTap JSON to `content_items.content.body`; `pageToDocxBlob` exports a Page to .docx. `@tiptap/extension-collaboration` + `yjs` declared, **never imported**. No footnote, highlight or comment extension. | `src/components/content/Editor.tsx`, `src/lib/export-page.ts:156`, `package.json:29-34` |
| Word in / out | In: `mammoth.convertToHtml` (Reader) and `mammoth.extractRawText` (Editor, worker) with no options — footnotes, numbering and styles are lost. Out: `docx` 9.7 (`export-docx.ts` = redline with real `w:ins`/`w:del` + comments, TNR 12). `.doc` via `word-extractor`. | `extract-manuscript.ts:64-76`, `ingest-core.mjs:1793-1809`, `export-docx.ts` |
| Editor's Room | Draft lives in **localStorage only** (`draft-store`, `DESK_ITEM_ID`); everything anchored by character offsets into a plain string; `verifier.ts` grounds each edit's `before` verbatim with curly-quote/whitespace normalisation and an index map. REWRITE mode is on the unmerged `feat/editor-rewrite`. | `src/pages/editor/EditorRoom.tsx`, `src/lib/editor/verifier.ts` |
| Document versions | **None.** No version/parent column, no `document_versions`; lineage = `metadata.source_document_id` (edited copies). `doc_type` includes `brief`. | 002, 007, `DocumentReader.tsx:457` |
| Drafting round trip today | Opus first cut (Claude Code) → Word → Contextspaces cite-check → Word. Eden's house-style build: `master.md` → `build_reply_webster.py` → Webster .docx (three sections, TOC/TOA, real footnotes). **The builder parses `## PRELIMINARY STATEMENT`, `### I. HEADING`, `**A. Heading.**`, `*italic*`, `[verify]` flags, `Dated:`; it has no footnote syntax.** | `~/.claude/skills/brief-format/` |
| Agent tasks | `agent_tasks` + `agent_task_events`; MCP `my_tasks / claim_task / ask_human / post_result`; attachments of kind `document` (resolved with `how_to_read`) or `content_item` (inline text ≤ 20k chars). **No MCP tool returns a document's full text**; `get_media` returns a signed URL to the original. | 085/089, `lib/mcp-core.mjs:936-1033, 4998-5238` |
| Ledger | `events` with a CHECK on `kind`, mirrored in `EVENT_KINDS`; the security spec adds its kinds in 094. | 064/072/073, `lib/ledger.mjs:57` |
| Migrations | Latest on main **093**; **094–099 are claimed** by the security build (S1/S2/S4a worktrees live). This build starts at **100**. | `supabase/migrations/` |

Three consequences: the two resolvers in §3.4 are new code, not wiring; the Reader needs an imperative navigation prop before two of them can share a screen; and the editor's schema must carry footnotes from day one or an imported first cut loses words.

## 2. Decisions Eden owes (each one line)

| # | Decision | Recommended | Gates |
| --- | --- | --- | --- |
| B1 | The name of the surface and the verb | "Brief Desk" / "Confirm this brief" until a better one lands | copy only |
| B2 | Word files coming in: accept with a loss list, or refuse until the engine exists | **Accept with the list** (headings, footnotes, italics survive; numbering, styles, TOC/TOA fields, tracked changes do not — shown once, at import) | D1 |
| B3 | Cite table default position on a wide screen | Right column, collapsible; bottom row below ~1400 px | D3 |
| B4 | A cite not in the corpus: a row that says so, or a persisted wanted list now | **Row only.** The wanted list is the Corpus Builder (09-22 idea), its own spec; the row is its seed | D3 |
| B5 | "Send to your assistant" in V1, or downloads only | **In V1** (D4): an `agent_tasks` row your connected Claude picks up; downloads ship first in D1 | D4 |
| B6 | Confirm re-checks everything, or only cites that are new or changed since the last run | **Incremental by default**, "Re-check all" as a button — a full run on a 100-page brief is dozens of Opus calls | D3 |
| B7 | Phone | **Read-only desk**: brief text plus tap-a-cite → authority full screen with a back gesture; no editing, no three panels | D3 |
| B8 | Footnote syntax in the master.md dialect | `[^n]` inline, `[^n]: text` block at the end (CommonMark footnotes). ⚠ `build_reply_webster.py` must learn it — a change to Eden's skill script, outside this repo | D1 |

## 3. The design

### 3.1 The brief as a document

A brief is a `documents` row (`doc_type = 'brief'`, `category = 'pleading'`) with an editable body. No new document kind; the Vault, search, the seal, shares and the Record all apply as they do to any document.

```sql
-- 100_brief_desk.sql
create table public.draft_bodies (
  document_id     uuid primary key references public.documents(id) on delete cascade,
  body            jsonb not null,               -- TipTap JSON, brief schema (§3.2)
  body_md         text  not null,               -- the same content serialised to the master.md dialect
  schema_version  int   not null default 1,
  updated_by      uuid  not null,
  updated_at      timestamptz not null default now()
);
create table public.draft_snapshots (              -- frozen: what a cite-check run checked, what an export sent
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.documents(id) on delete cascade,
  label           text,                          -- "v3", "as sent to Claude 26 Sep"
  body            jsonb not null,
  body_md         text  not null,
  sha256          text  not null,                -- of body_md, utf-8 — the Cite Verification Record's brief_sha256
  created_by      uuid  not null,
  created_at      timestamptz not null default now()
);
alter table public.cite_check_runs add column if not exists snapshot_id uuid references public.draft_snapshots(id);
create table public.cite_notes (                   -- the telegraphic note, per cite, survives re-checks
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.documents(id) on delete cascade,
  cite_key        text not null,                 -- §3.3
  user_id         uuid not null,
  note            text not null check (char_length(note) <= 280),
  annotation_id   uuid references public.document_annotations(id) on delete set null,  -- the long note, on the authority
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (document_id, cite_key, user_id)
);
```

RLS: all three tables SELECT/INSERT/UPDATE for members of the document's matter through the same helper the `documents` policies use; DELETE on `draft_snapshots` for nobody (a snapshot a run points at must outlive edits); `cite_notes` DELETE by its author. Sealed matters: the body is text inside the matter, governed by the seal like passages. **Do not touch the shared RLS helpers** — S4b is changing them.

Ledger kinds added in 100 and mirrored in `EVENT_KINDS`, the 064 lesson: `draft.snapshot {document_id, snapshot_id, sha256, label}`, `cite.checked {document_id, run_id, snapshot_id, counts}`, `draft.exported {document_id, snapshot_id, destination: 'md'|'docx'|'agent', task_id?}`. Autosave writes no event. ⚠ **Dependency:** the security build's 094 re-declares `events_kind_check` from a hardcoded list; whichever of 094 and 100 applies second would silently drop the other's kinds. **D1 does not start until 094 is on main**, and 100 re-declares the constraint with the **union** of `EVENT_KINDS` as it stands then.

**Lineage without a versions table:** `draft_snapshots` is the version history. The Reader's "Versions" is a later nicety; the desk shows snapshots as a list with "Open read-only" and "Restore" (restore = copy into `draft_bodies`, new snapshot of what it replaced).

**The rest of the product must see the latest text.** A brief filed through `file_document` has a storage object and passages; edits then live in `draft_bodies`, and search, `grep`, `get_passage` and the standalone Reader would keep returning the first cut. So on every snapshot the desk uploads `body_md` to the brief's own `storage_path` and enqueues `ingest_document` with `force`, and passages track the latest snapshot. This is the one sanctioned overwrite of a filed object (S3 asserts the worker never overwrites; the desk does, deliberately, for its own drafts, and the snapshot row is the history). `/app/document/:id` redirects to `/app/brief/:id` when a `draft_bodies` row exists.

### 3.2 The editor schema (the brief subset of Word, chosen now)

TipTap document, schema name `brief`, version 1. Chosen so it can grow into the engine (§5) instead of being replaced by it.

- **Nodes:** `doc`, `heading` (levels 1–3 = `##` part headings / `### I.` point headings / `**A.**` sub-points, per the dialect), `paragraph`, `blockquote`, `footnote` (inline node with block content; numbered by position, never by attr), `signatureBlock` (from `Dated:` to the end), `hardBreak`, `passthrough` (a block the parser could not classify, kept verbatim as text so nothing is lost).
- **Marks:** `bold`, `italic`, `underline`, `highlight {color}`, `cite {cite_key, run_id, flag, raw, authority_document_id?, passage_id?, pin?, stale}`, `flag {kind: STAR|OPP|EDEN|verify}` (the bracketed red flags the dialect already has).
- **Serialiser and parser** live in `src/lib/brief/md.ts`, pure and environment-neutral (Node 24 and browser; the rewrite engine's pattern). Round trip is lossless for the schema: `parse(serialize(doc)) ≡ doc` is the first harness. Cite marks serialise to nothing (they are derived; §3.3 rebuilds them) — the .md a human or an assistant reads is clean.
- **A third projection, `toPlainText(doc)`**, also in `md.ts`: markup dropped, paragraph breaks kept, footnote bodies appended in document order, deterministic. **This is the string the cite-check reads and the marks anchor to** — never `body_md`. In the dialect a case name is `*Owen v. Jones*`; the extractor's contract check would keep the asterisks inside `raw`, and anchoring against the editor's text (no asterisks) would then fail on every italicised case name. Footnote text also moves in the dialect, so `location` snippets would land in the wrong place. `sha256` stays on `body_md` (identity); both derive from `body`.
- **No `yjs`** in V1: one editor per brief, autosave every 2 s of quiet and on blur (`draft_bodies.updated_at` as the optimistic lock; a stale save shows "changed elsewhere — reload" rather than overwriting).

### 3.3 Cite marks and the table

A run's `ReportEntry[]` becomes marks by **text anchoring**: for each entry, find `raw` (then `location`) in the `toPlainText` projection (§3.2) with the verifier's normalisation (curly quotes, whitespace, hyphenation), map the offsets to ProseMirror positions (the projection keeps a position map, as `verifier.ts` keeps an index map), and wrap the range in a `cite` mark. Entries that do not anchor (the extractor's contract check makes this rare) appear in the table as "not located in the text" and never as a silent drop.

`cite_key` = `normalize(citation without pin) + '|' + (pin ?? '')`, where normalize lowercases, collapses whitespace and strips punctuation except the reporter's dots. It is stable across runs and across snapshots, so notes and (later) attestations attach to it. The Cite Verification Record adopts this key.

**The table is a projection of the marks in document order**, not a second list: flag · citation + pin · "in corpus" (title, or "not in corpus") · pin ("p. 1221" resolved, "first page — no star pages", or "pin not found") · note (inline, 280 chars, `cite_notes`) · location (click = scroll the editor to the mark). Filters by flag as today. `CiteDetail` (the existing expander) opens from a row for the model's justification, source and sub-flags.

**Edit rule:** on every transaction, a `cite` mark whose current text no longer normalises to its `raw` gets `stale = true`; the row reads "changed since check" and its flag renders as `unchecked`. The run row is never mutated. **Confirm** (B6) takes a fresh snapshot, runs the extraction call over the whole `toPlainText` projection (extraction is one call and cannot be skipped), diffs the extracted cites against the last run by `cite_key + raw`, calls `checkOne` only for new or stale ones, carries the rest forward with their flags into a new run row with `snapshot_id`, and rebuilds the marks. The saving is in `checkOne`, where the per-cite model calls are. "Re-check all" ignores the diff. Both write `cite.checked`.

### 3.4 Two resolvers (deterministic, matter-scoped, no model)

```sql
-- 101_citation_resolvers.sql
create table public.document_citations (          -- one row per reporter cite a case document carries
  document_id  uuid not null references public.documents(id) on delete cascade,
  reporter     text not null,                     -- normalised as lib/bluebook.mjs prints it ("F.3d", "N.Y.3d")
  volume       int  not null,
  page         int  not null,
  case_name    text,                              -- westlaw_case.case_name, lowercased, for the fallback
  primary key (document_id, reporter, volume, page)
);
create index document_citations_cite_idx on public.document_citations (reporter, volume, page);
```

Populated in `lib/ingest-core.mjs` beside the `westlaw_case` write (one helper, `upsertDocumentCitations(doc)`), and by a one-statement backfill from `documents.metadata->'westlaw_case'->'reporters'` (no storage egress; the metadata is already in Postgres — this is not the S3 backfill).

- **`resolve_citation(p_matter uuid, p_reporter text, p_volume int, p_page int, p_case_name text)`** → `{document_id, title, how: 'reporter'|'name'} | null`. Reporter match first, within the matter and the sub-matters the caller may read (the same scope the `search` RPC uses); name fallback = `category = 'case'` and a trigram/`ilike` match on `case_name` when the reporter parse failed; two hits → return both, the row says "2 copies — pick one". SECURITY DEFINER wrapped INVOKER ([[feedback_rls_security_invoker_wrappers]]); the scope check is inside.
- **`passage_for_printed_page(p_document uuid, p_page int, p_reporter_ordinal int default 1)`** → `{passage_id, page_start, basis: 'printed'|'parallel'|'pdf_index_declined'|'unknown', caveat}`. Scans that document's `summary_level = 0` passages: `metadata->>'printed_page' <= p_page <= printed_page_end`, else the `star_pages` entry for the ordinal (parallel reporters), else the document's first passage with the `citePage` caveat in words. A per-document scan is a few hundred rows; no index on `passages`. The reporter ordinal comes from which of the document's `document_citations` rows matched.

The browser calls both per entry after a run (or after carry-forward) and writes the results onto the marks. The Cite-Check engine itself is unchanged in V1: `check.ts` still rates against `authorities` / free sources. Corpus-first rating (the 09-16 memo's "corpus-first verification") is a later change to `check.ts` that reuses `resolve_citation`; it is not in this build.

### 3.5 The surface

Route `/app/brief/:id`, page `src/pages/brief/BriefDesk.tsx`. Entry points: open a `brief` document from the Vault or a matter (docx/md briefs without a body get "Open in the desk", which imports per B2); "New brief" in the matter's document menu; MCP `file_document` with `doc_type: 'brief'` and a `.md` filename creates the body from the markdown — so a Claude Code drafting session files its first cut straight into the desk.

Layout (B3, B7):

- **≥ 1400 px:** `[ editor 1fr | authority 1fr | table 360px ]`. Table collapses to a 40 px strip with the flag counts.
- **1100–1400 px:** `[ editor | authority ]` over a collapsible bottom row holding the table (the chat-pane shape).
- **< 1100 px, and `useIsMobile()`:** editor only, read-only; a cite tap opens the authority full screen with back. Notes readable, not editable.

The authority pane is `<DocumentReader id={authorityId} embedded goto={…} />`. Two Reader changes, as **props, not URL params** (two readers on one route would fight over `?page=`):

- `goto?: { page?: number; passageId?: string; anchor?: TextAnchor; nonce: number }` — imperative, applied when `nonce` changes. `passageId` → fetch `page_start` + text; PDF: `gotoPage` then paint the passage's first twelve words through the existing `.search-hits` path; DOCX/text: `findInRendered`. `page` → `gotoPage`. The `?page=` reads at 763/775 stay for the standalone route and are skipped when `embedded`.
- `chrome?: 'full' | 'pane'` — `pane` hides the cover, the sidebar toggle and the page editor button (today's `embedded` hides some of these already; make the set explicit).

Click a cite mark → the pane opens `authority_document_id` at `passage_id` (or first page with the caveat under the title: "No star pages in this copy — showing page 1"). Click the pin text in the table → same. "Not in corpus" rows offer "Search the matter" (the existing all-matters search, prefilled) and nothing else in V1 (B4). Long note: the composer in the authority pane is the Reader's own `NoteComposer`; saving from the desk sets `cite_notes.annotation_id`, and the table shows the note's first line under the telegraphic one. "Send a message" from the desk is the same composer with an addressee — `document_annotations.addressee_user_id` / `addressed_to_ai` (048) — so a note to co-counsel or to the assistant about a cite is a marginalia row, not a new channel.

Toolbar: bold · italic · underline · highlight · footnote · flag (STAR/OPP/EDEN/verify) · undo/redo · **Confirm this brief** · Snapshot · Export ▾ (Markdown · Word · Send to your assistant). The Confirm button shows the last run's counts and "N changed since".

### 3.6 Export

All three take a snapshot first (`draft.snapshot`) and then write `draft.exported`. **Gating follows the S4a shape**, because a browser-minted download cannot be gated server-side (W6 §2): for a **sealed** matter, Markdown and Word are built by an endpoint, `api/brief-export.mjs` (the `docx` library runs in Node), which calls `lib/export-gate.mjs`, records `draft.exported`, and returns the file, or refuses in a sentence. For a **Tier A** matter the client builds the file and records the event only. Send to your assistant is server-side on every tier, so it is gated on every tier.

1. **Markdown** — `body_md` of the snapshot, filename `<title> — v<n>.md`. This is the file the `brief-format` skill's build consumes (after B8).
2. **Word** — `src/lib/brief/export-docx.ts` from the snapshot's TipTap JSON: TNR 12, double-spaced, justified, 0.5" first-line indent; headings per level; **real Word footnotes** (`docx` 9 supports footnote references); flags as bold red; the signature block indented 3.5". No cover, no TOC/TOA, no section breaks — the file says "Captures your words. House formatting is the assistant's job." in its DRAFT header line. (`export-page.ts` is the pattern; do not extend `export-docx.ts`, which is the redline builder.)
3. **Send to your assistant** (D4, B5) — files the snapshot's `.md` as its own document in the matter (`metadata.source_document_id` = the brief, `metadata.snapshot_id`), then inserts an `agent_tasks` row: title "Format this brief in house style", instructions = a fixed template + the user's own style note (see below), attachment `{kind:'document', id}`. The assistant reads it through `get_media` (the only full-text path today — stated as a gap; a `get_document_text` tool is a one-line addition to `TOOLS` if the build wants it, through `callTool` so it is recorded), formats with its skill, files the .docx back with `file_document` (base64) and `post_result` with a `result_ref`. The desk shows "Formatted copy filed: <title>" with Open.

**The house-style note (the "model brief skill", V1 shape):** a per-user text stored in `profiles.metadata.brief_style` (or a `content_item` of type `page` titled "My brief style" in the user's serverspace — pick whichever the build finds already has an edit surface), pasted into every "Send to your assistant" task. Eden's is the `brief-format` skill's rules. "Load Jones's model brief and derive the note" is a later feature; V1 is a text box with a good default.

## 4. The slices

Order = dependency. Each = one Opus PR from a fresh worktree off `origin/main`, one offline harness wired into CI (`docs/CI.md`), no prod access, Eden merges. Keep off `mcp-core.mjs` except the `.md` brief branch in `handleFileDocument` (D1) and a new tool (D4), and off the RLS helpers.

### D1 — The brief as an editable document (migration 100)

**What a customer can say after:** "My brief lives in the matter as text I can edit, with footnotes, and I can download it as markdown or Word at any time."

Schema (§3.2) in `src/lib/brief/schema.ts` (TipTap extensions: `Footnote`, `SignatureBlock`, `Passthrough`, `Highlight`, `Flag`, `Cite` — `Cite` is defined here and used in D3); `md.ts` parse/serialise; `import-docx.ts` (mammoth `convertToHtml` with a style map for headings, footnote refs re-attached from mammoth's end-list by number; produces the loss list); `export-docx.ts` (§3.6.2); `draft-store.ts` (load/autosave/snapshot/restore with the optimistic lock); the `BriefDesk` page with the editor column only and the toolbar minus Confirm; "New brief", "Open in the desk"; `file_document` `.md` + `doc_type:'brief'` → body (in `handleFileDocument`, one branch). Snapshots list. Events.
**Migration 100:** `draft_bodies`, `draft_snapshots`, `cite_notes`, `cite_check_runs.snapshot_id`, the three kinds (the CHECK re-declared in the 073 pattern with the **union** of kinds — **wait for 094 on main first**, §3.1). Also the snapshot → `storage_path` upload + forced re-index, and the Reader redirect.
**Harness:** `_verify-brief-md-roundtrip.mjs` — fixtures: a Webster-style master.md with footnotes, flags and a signature block; `parse → serialize` byte-identical; docx import of a fixture produces the expected loss list; export-docx contains `w:footnoteReference` for every footnote; PGlite: RLS member/non-member on the three tables, snapshot DELETE refused, kinds accepted.
**Eden:** B2, B8 (and the skill-script change on his side).

### D2 — The resolvers (migration 101)

**What a customer can say after:** nothing visible yet — "the desk knows which cases in my matter a cite points at, and which page."

`document_citations` + `upsertDocumentCitations` in `ingest-core.mjs` + `scripts/backfill-document-citations.mjs` (one SQL statement, chunked, idempotent, `--dry-run`); `resolve_citation` and `passage_for_printed_page` with INVOKER wrappers; `src/lib/brief/resolve.ts` (browser callers, parse via the same reporter grammar as `lib/bluebook.mjs` — port `parseWestlawCase`'s reporter table, do not re-invent it).
**Harness:** `_verify-citation-resolvers.mjs` (PGlite): reporter hit; name fallback; two copies; a document in another matter is not returned; parallel-reporter pin via `star_pages`; `pdf_index_declined` returns first passage + caveat; backfill idempotent.
**Eden:** none beyond merge; the backfill runs on his "approved: backfill document_citations" (minutes, no egress).

### D3 — The desk: side by side, marks, the table

**What a customer can say after:** "I click a cite and the case opens next to my brief at the pinned page; the table shows every cite's status and my one-line note; I edit in place and the table tells me what I changed."

Reader `goto` + `chrome` props; the three-panel layout and the phone mode (B3, B7); Confirm (snapshot → `runCiteCheck` on `body_md` → run row with `snapshot_id` → resolvers → marks) with the incremental diff (B6) and "Re-check all"; mark anchoring (`src/lib/brief/anchor.ts`, reusing `verifier.ts`'s normalisation); the stale rule; the table (`src/pages/brief/CiteTable.tsx`) with inline notes (`cite_notes`); "not in corpus" rows (B4); `CiteDetail` reuse.
**Harness:** `_verify-brief-desk-marks.mjs`: every fixture entry anchors; an entry with curly quotes anchors; an edit inside a mark sets `stale`; the incremental diff re-checks exactly the new + stale keys and carries the rest with their flags; table order = document order. Plus a Playwright-free render test of the three breakpoints if the repo's harness style allows; otherwise screenshots in the PR.
**Eden:** B1, B3, B6, B7; test on the laptop and the phone ([[feedback_iterate_through_phone]]).

### D4 — Notes on the authority, send to your assistant, the Record

**What a customer can say after:** "My longer notes sit on the case itself; I can hand the brief to my own Claude to format in my house style and the formatted copy comes back into the matter; all of it is in the Record."

`cite_notes.annotation_id` wiring from the pane's `NoteComposer`; the house-style note surface (§3.6); "Send to your assistant" (task insert, attachment, template, the result surface); optional `get_document_text` tool; export-gate on all three paths; the Agents page shows the task like any other.
**Harness:** `_verify-brief-export-task.mjs` (PGlite): task row + attachment resolve; `post_result` with a `result_ref` to a document in the matter is accepted, one outside refused; a sealed matter's export is refused by the gate and recorded; `draft.exported` written with the right destination.
**Eden:** B5; connect his Claude to the matter and run one brief through end to end.

## 5. The door to the engine (what this build must not close)

- The schema is the brief subset of Word, not HTML. Footnotes, signature block and flags are nodes and marks with names that map to Word parts. `passthrough` is where an engine later puts what it does not yet model.
- `md.ts` is the only place that knows the dialect. A later `docx.ts` that reads and patches Word XML directly replaces `import-docx.ts` and `export-docx.ts` without touching the editor.
- Snapshots carry `sha256` of the interchange text. When the engine arrives the hash moves to the .docx bytes, and the Record's claims survive.
- Nothing in V1 depends on `yjs`; the engine may.

## 6. What we can and cannot say after

| After | Can say | Cannot say |
| --- | --- | --- |
| D1 | "Your brief is text you edit in the matter, with real footnotes, exportable as Markdown or Word." | "Word round trip" — the export is a clean rebuild, not your file. "Every export is recorded" — on an unsealed matter the download is built in the browser and the event is written on trust; only sealed matters and assistant hand-offs go through the gate. |
| D2 | (internal) | — |
| D3 | "Click a cite, read the case beside your brief at the pinned page; every cite's status in one table; edits are tracked against the last check." | "Verified" in the SB 574 / McCarthy sense — that is W6's verify control and the attestation record, which attach here later. "Every case is in your corpus" — rows say when one is not. |
| D4 | "Hand it to your own assistant for house formatting; the formatted copy files back; the Record shows the hand-off." | "We format it" — the house style is the assistant's job in V1. |

## 7. Kickoff prompts (one per slice)

**D1.** "Read `docs/specs/BRIEF-DESK-2026-09-26.md` and build slice D1 exactly. First confirm migration 094 is on `origin/main`; if not, stop and say so. Then: migration `100_brief_desk.sql` (execute in PGlite first; probe prod columns before ALTER, per `project_dev_environment_cautions`; re-declare `events_kind_check` with the union of `EVENT_KINDS`), `src/lib/brief/{schema,md,import-docx,export-docx,draft-store}.ts`, `src/pages/brief/BriefDesk.tsx` (editor column only), the `file_document` `.md` branch, `_verify-brief-md-roundtrip.mjs` wired into CI. Do not build Confirm, the table or the authority pane. Fresh worktree from origin/main; one PR; no Co-Authored-By."

**D2.** "… build slice D2 exactly: migration `101_citation_resolvers.sql` with both RPCs wrapped INVOKER, `upsertDocumentCitations` in `lib/ingest-core.mjs` beside the `westlaw_case` write, `scripts/backfill-document-citations.mjs` with `--dry-run`, `src/lib/brief/resolve.ts`, `_verify-citation-resolvers.mjs`. No UI. Reuse `lib/bluebook.mjs`'s reporter grammar; do not re-implement it."

**D3.** "… build slice D3 exactly: `DocumentReader` gains `goto` and `chrome` props (no URL-param behaviour change on the standalone route), `BriefDesk` gains the authority pane, `CiteTable`, Confirm with the incremental diff, `src/lib/brief/anchor.ts` reusing `src/lib/editor/verifier.ts` normalisation, the stale rule, `cite_notes` inline, the phone mode, `_verify-brief-desk-marks.mjs`. Keep `src/lib/cite-check/*` unchanged except for passing `snapshot_id` into the run row."

**D4.** "… build slice D4 exactly: `NoteComposer` → `cite_notes.annotation_id`, the house-style note surface, Send to your assistant (task insert + attachment + template + result surface), the optional `get_document_text` tool through `callTool`, `lib/export-gate.mjs` on all three export paths, `_verify-brief-export-task.mjs`."
