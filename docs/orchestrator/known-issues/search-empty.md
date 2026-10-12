---
id: search-empty
title: A search comes up empty
status: by-design
surfaces:
  - any
words:
  - no results
  - nothing found
  - found nothing
  - search returns nothing
  - empty search
  - can't find it in
cause: Usually the scope: a sub-folder instead of its parent, a sealed or paused sub-folder left out, a document not processed yet, or a copy that was never indexed.
say: Empty searches are usually about where we looked — a sub-folder instead of the whole matter, a sealed or paused sub-folder, or a document that isn't processed yet. Let me check which.
user_can:
  - Search from the parent matter.
orchestrator_can:
  - Re-run the search in the parent matter; check_ingest_status on the document they expect.
escalate_when: The words are visibly in a processed document and the search still misses them.
---

# A search comes up empty

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
