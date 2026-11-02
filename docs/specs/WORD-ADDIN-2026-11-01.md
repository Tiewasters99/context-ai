# Equazia for Word — Office Add-in spec (2026-11-01)

## Why

Legora's small-firm pitch leans on working inside Word. Our Brief Desk already
does the thing a litigator needs most ("Confirm this brief": every cite walked,
found in the matter, opened at the pincite, signed off by a person), but the
brief has to be brought to the Desk. This add-in brings the Desk to the brief.

The round trip has been the hard part since 09-26: mammoth loses footnotes and
numbering on import, and `docx` rebuilds rather than preserves on export. A task
pane sidesteps it. The document never leaves Word. The pane reads the live file,
runs the Desk's own pipeline, shows the cite table beside the page, and the
lawyer's sign-off is written to the same Record the Desk writes to. Nothing in
the .docx is rebuilt.

## What the lawyer sees

Ribbon: an **Equazia** group on the Home tab with one button, **Confirm this
brief**, which opens the task pane.

Pane, top to bottom:

1. **Sign in** — the Equazia account (email + password; the same Supabase
   session the site uses, kept in the pane's own storage). No Microsoft
   sign-in, no Entra app: the pane is a page on www.equazia.ai and signs in as
   the site does.
2. **Matter** — the matter this brief draws on, the same tree the Desk home
   shows. Remembered per document in the document's own Office settings, so
   reopening the file finds it.
3. **Confirm this brief** — runs the Desk pipeline on the document as it is.
   Progress is the Desk's (snapshot → extracting → checking n/m → resolving →
   saving).
4. **Cite table** — one row per cite: the words as the brief has them, the
   flag, where it was found (title + page, "N copies", "not in the matter").
   Clicking a row selects the cite in the Word document and scrolls to it.
   Opening a row shows the authority: the Reader at the pinned page (slice 2),
   or until then an "Open in Equazia" link that lands on the Desk's authority
   pane for that cite.
5. **Confirm / Problem** on the open row, with initials, exactly the Desk's
   `cite_confirmations` row. Optional, explicit: **Add a Word comment** on the
   cite that records the reading ("Equazia · confirmed EQ 11-01 · Owen v.
   Jones at 412"). Never written uninvited; a matching Remove exists.
6. **Open this brief in Equazia** — the Desk at `/app/brief/<id>` in the
   browser, where the full surface is.

## How it works

### Reading the document

`Office.context.document.getFileAsync(Office.FileType.Compressed)` returns the
real .docx bytes in 4 MB slices; assembled, they go through the Desk's existing
`importBytes()` (mammoth → `htmlToBrief`). `body.getOoxml()` is not used: it is a
flat package mammoth cannot read. The file handle is closed after the last
slice or the next call fails.

### The brief in Equazia

The first Confirm from a document creates a brief in the chosen matter through
`importBriefFile()` (documents row, `doc_type='brief'`, body, first snapshot,
the original .docx stored beside it). The brief id is kept in
`Office.context.document.settings` under `equazia.briefId`, so later Confirms
on the same file update the same brief: `saveBody()` with the stored
`updated_at`, then `confirmBrief()` which takes its own snapshot and run row.
Every Confirm from Word is therefore a snapshot and a run on one brief, the
same as a Confirm from the Desk, and the Desk and the add-in see each other's
runs.

If the stored brief id cannot be read (a shared .docx opened by someone the
matter is not shared with), the pane says so and offers to file a new brief.

Edit hold (105): before writing the body the pane claims the brief edit hold
through `claim_brief_edit` like a Desk tab would, so an open Desk window is
told. The claim is released when the pane closes. A refused claim (someone is
typing in the Desk) is shown, with Take over.

### Confirm

`confirmBrief({ meta, body, prior, stalePairs: new Set(), all: false,
recordMatterId: matterId })`. There are no ProseMirror marks in Word, so the
stale set is empty and `diffForConfirm` carries every unchanged cite_key+raw
pair forward and checks the new ones. "Re-check all" sets `all`.

Every model call runs under the person's own session against `/api/llm` and
`/api/legal-source`, same origin as the site, so the sealed pen and the Record
work exactly as they do for the Desk.

### Finding a cite in Word

Row click: `body.search(window, { matchCase: true, matchWildcards: false })`
on a distinctive window of the cite's raw text (search strings over 255
characters throw; `^` is a code even without wildcards, so it is stripped).
First hit: `select()` and scroll. More than one hit: the row says "N places"
and cycles.

### Writing to Word (opt-in only)

`range.insertComment(text)` (WordApi 1.4). Only on the person's click, only
on the cite's own range, with Remove. v1 writes nothing else into the document.

### Authority at the pincite

Slice 1: the row shows title + page, and "Open in Equazia" opens the Desk with
the row's cite selected. Slice 2: `AuthorityPane` (the Reader in `pane` chrome
with `goto`) inside the task pane. The Reader pulls pdf.js and mammoth; if the
pane bundle or first paint is heavy, slice 2 lazy-loads it on the first open.

## Where it lives

- `addin.html` — third Vite entry beside `index.html` and `reader.html`.
  Office.js is a classic `<script>` in `<head>` from
  `https://appsforoffice.microsoft.com/lib/1/hosted/office.js` (Microsoft
  requires the CDN copy). It nulls `history.pushState/replaceState` on load;
  both are saved before the tag and restored after `Office.onReady`.
- `src/addin/` — `main.tsx` (QueryClient + MemoryRouter + AuthProvider),
  `office.ts` (the Office bridge, with a `?mock=1` mode for a browser),
  `AddinPane.tsx` (the pane), `SignIn.tsx`, `CiteRows.tsx`.
- `public/addin/manifest.xml` — TaskPane add-in, Word only, `WordApi 1.4`,
  SourceLocation `https://www.equazia.ai/addin`, icons in `public/addin/`.
- `vercel.json` — `/addin` → `/addin.html`, like `/read/:id`.

## Mock mode (how it is tested without Word)

`/addin?mock=1`: Office never fires, so the bridge is replaced by one that
takes a .docx from a file input for `getFileAsync`, logs `search/select` to the
console, and keeps `settings` in localStorage. That drives sign-in, matter
pick, import, `confirmBrief` and the rows end to end in a browser on a TEST
matter. Never on a live brief (house rule).

## Installing in Word (one trip, Eden)

Per-user sideload; central deployment through the Microsoft 365 admin center
is not assumed (GoDaddy-hosted tenants often cannot reach Integrated Apps).
Memo: `C:\Users\equai\WORD-ADDIN-INSTALL-2026-11-01.txt`.

## Not in v1

Drafting, redlining, clause playbooks (Legora's transactional set), Outlook,
AppSource listing, Microsoft SSO. Outlook shares the manifest family and is
the natural next add-in.

## Slices

- **1 (this PR):** entry, manifest, sign-in, matter, Confirm, rows, select in
  Word, Confirm/Problem, opt-in comment, Open in Equazia, mock mode.
- **2:** Reader in the pane at the pincite; "N places" cycling; Re-check all.
- **3:** Office SSO once an Entra app exists (shared with OneDrive export);
  AppSource submission.
