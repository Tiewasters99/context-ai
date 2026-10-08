---
id: footnote-not-found
title: A cited footnote seems missing from the authority
status: fixed
fixed_in: 3e45db5c5cac
surfaces:
  - brief-desk
  - reader
  - vault
words:
  - footnote
  - footnotes
  - n.1
  - n.2
  - note 1
  - no footnotes
  - missing footnote
cause: A Word file shows its footnotes at the end under "Footnotes"; a cite ending "n.1" opens at that note. Some authorities are filed only as a text transcription, not the original PDF.
say: A Word document's footnotes are at the end, under Footnotes, and a cite ending in a note number opens straight at that note. If the authority looks like plain text rather than the page images you downloaded, the folder holds a transcription — add the original PDF beside it.
user_can:
  - Scroll to the end of the document for Footnotes.
  - If the file is a text transcription, add the downloaded PDF to the same folder.
orchestrator_can:
  - Search the document for the footnote's words.
escalate_when: The note is in the original but not in Contextspaces after a reload.
note: Word footnotes were not indexed before dcf7c00 (#349); 89 files backfilled 10-02 (passages metadata.source=docx_notes). Diplomat was a docx transcription.
seen:
  - 2026-10-02 a decision filed only as a Word transcription looked footnote-free
---

# A cited footnote seems missing from the authority

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
