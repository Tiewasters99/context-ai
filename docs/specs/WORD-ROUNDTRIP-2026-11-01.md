# Word is the editor, Equazia is the home — the .docx round trip (2026-11-01)

Supersedes the "file as a Desk brief" section of WORD-ADDIN-2026-11-01.md for
documents that are written in Word. The task pane, sign-in, cite table and
Confirm from that spec stay as they are.

## What Eden asked for (11-01)

> I click on the document. I have an option: Open in Word? I click and it
> opens in Word. I'm done, I click save and I have an option Save to Equazia?
> I label the document v.2 and click yes. Now my document lives in Equazia,
> but I manipulate it outside of Equazia. Just two additional options.

All of a matter's documents in one place, Word drafts included, so nothing is
kept in OneDrive on the side; sealable like anything else; Confirm this brief
as one step near the end, not the reason the document is there.

## The idea

The round trip was hard because the .docx was converted into the Desk's
editing format and back, and formatting died in the conversion. This design
never converts. **The .docx itself is the document in the matter**, the way a
filed PDF is: stored, versioned, its text read for search and Confirm. Word is
the editor. Nothing is translated, so nothing is lost.

## What the lawyer sees

**Open in Word** — on a .docx in the Vault list (right-click) and on the
Reader's toolbar beside Download. The file leaves Equazia through the same
door Download uses (the Record gets `file.exported`), carrying a hidden tag
that names the document and matter, and lands in Downloads; Word opens it
from there (Chrome's "always open files of this type" makes that one click).

**Save to Equazia** — a button in the Equazia pane inside Word, with a label
box prefilled with the next version ("v.2"). It takes the document exactly as
Word has it, byte for byte, and stores it as a new version of the same
document. The pane then reads "In Equazia as *DeCamara Reply Brief* · v.2".
A document that is not in Equazia yet (written fresh in Word) shows the matter
tree and the same button; the first Save is the filing.

**Confirm this brief** — the same button as before, pressed when the lawyer is
ready. It runs on the words Word has now; it never files anything.

**Versions** — the Reader shows the document's versions (label, date, who),
each downloadable. The Vault row shows the latest label beside the name.

Saves are explicit. There is no autosave in this version: Word's own
AutoRecover covers a crash, every Save is a version that re-indexes the
document, and versions are never deleted.

## How it works

### One document, many versions (migration 127)

`document_versions` — one row per Save, immutable (INSERT and SELECT only):
`id, document_id, label, storage_path, filename, file_size_bytes, sha256,
source ('word' | 'upload' | 'desk'), note, created_by, created_at`. Readable
with the document; insertable by someone who can write the matter. A trigger
refuses a `storage_path` outside the document's matter (097's rule).

`documents.storage_path` always points at the **current** version's object,
exactly as the Desk's `publishSnapshot` repoints it. Older objects stay in
storage as the history. Every object is `<matter>/<document>/<file>`, three
segments (097), `upsert: false` with a fresh name each time (096 refuses an
overwrite on a sealed matter). `documents.metadata.editor = 'word'` marks a
document whose editor is Word: the Reader renders its .docx and does not
redirect to the Desk even after a Confirm has given it a draft body; the Desk
shows it read-only with an "Edited in Word" line.

A Save, in order: tag the bytes → sha256 → upload the new object → insert the
version row → update the documents row (storage_path, filename, size,
`processing_status: 'pending'`, metadata) → delete the old passages → trigger
`/api/ingest` → write `file.filed {document_id, version_id, label, sha256,
source: 'word'}` to the matter's Record. The matter for the path comes from
the documents row read as the user, never from the tag.

### The tag

A custom document property in the .docx (`docProps/custom.xml`:
`EquaziaDocumentId`, `EquaziaMatterId`). It is written by Open in Word
(JSZip, client side, before the file leaves) and by every Save from the pane
(`Word.run` → `document.properties.customProperties`, WordApi 1.3, checked at
run time), so a copy of the file still knows its home. The pane reads it the
same way; a document with no tag is "not in Equazia yet". The Office setting
from the first spec (`equazia.briefId`) is read as a fallback for files tagged
before this change. The mock bridge reads and writes the same part with
JSZip, so the tagged path is testable without Word.

### Where the code lives

- `supabase/migrations/127_document_versions.sql` — the table, policies,
  trigger. Paste memo `C:\Users\equai\PASTE-SQL-127-2026-11-01.txt`.
- `src/lib/docx-tag.ts` — read/write the custom property in .docx bytes.
- `src/lib/document-versions.ts` — `listVersions`, `nextVersionLabel`,
  `saveDocxVersion`, `createDocxDocument`.
- `src/lib/open-in-word.ts` — Open in Word (download through the door, tagged).
- `src/addin/office.ts` — `readTag` / `writeTag` on the bridge (Word + mock).
- `src/addin/AddinPane.tsx` — the document line, Save to Equazia, Confirm.
- `src/pages/DocumentReader.tsx` — Open in Word, Versions, no Desk redirect
  for `editor = 'word'`. `src/components/vault/ImportPanel.tsx` — Open in Word
  in the row menu, latest label on the row.
- `src/pages/brief/BriefDesk.tsx` — read-only for `editor = 'word'`.

## Not in this version

- Launching Word straight from the browser (`ms-word:ofe|u|<url>`): a signed
  URL with a query string may open read-only or not at all; untested here.
  Downloads first; the protocol launch is a follow-up once tried on Eden's
  machine.
- Autosave (above).
- Desk briefs exported to Word and round-tripped: a Desk brief's Word export
  is a conversion; this spec covers documents whose stored bytes are .docx.
- Downloading an OLDER version of a document in a sealed matter: the door
  signs only the row's current object. The list shows the versions; the
  download of an old one works on open matters and says why not on sealed.
