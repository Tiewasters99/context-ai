---
id: not-searchable-yet
title: A document isn't searchable
status: by-design
surfaces:
  - vault
  - reader
  - any
words:
  - not searchable
  - can't search
  - no results in
  - ocr
  - scanned
  - no text
  - not indexed
cause: It may still be processing, waiting for OCR (scans and stamp-only pages), stored without text on purpose, or — in a sealed matter — searchable by words but not by meaning.
say: Let me check where that document is in processing — it may still be reading, waiting for text recognition on scanned pages, or stored without text.
user_can:
  - Wait for processing; a scan takes longer.
orchestrator_can:
  - check_ingest_status, then explain what it says.
  - ingest_document to retry one that shows an error (from the Vault, not the Brief Desk).
escalate_when: It shows an error a retry does not clear.
---

# A document isn't searchable

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
