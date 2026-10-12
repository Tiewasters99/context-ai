---
id: printed-page-off
title: A transcript cite points at the wrong page
status: open
surfaces:
  - reader
  - brief-desk
  - any
words:
  - wrong page
  - page is wrong
  - off by one
  - page number
  - printed page
  - transcript page
cause: Some transcripts processed before the printed-page detector cite the file's page rather than the reporter's; a re-run fixes it.
say: Some older transcripts cite the file's page rather than the court reporter's printed page. Reprocessing the transcript fixes it — I can queue that if you'd like.
user_can:
  - Check the printed page on the page itself before relying on the cite.
orchestrator_can:
  - ingest_document with force to reprocess that transcript (not from the Brief Desk).
escalate_when: The page is still off after reprocessing.
---

# A transcript cite points at the wrong page

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
