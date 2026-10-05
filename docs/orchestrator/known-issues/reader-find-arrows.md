---
id: reader-find-arrows
title: Find in document does nothing
status: fixed
fixed_in: 20b50d8f151f
surfaces:
  - reader
  - brief-desk
symptoms:
  - Find in document
words:
  - find
  - search box
  - arrows
  - nothing happens
  - magnifying glass
cause: The find box used to search only on Enter, and its arrows stayed off until then. It now searches as you type.
say: The find box searches as you type now; in an older tab it searched only when you pressed Enter.
user_can:
  - Type the word and wait a moment, or press Enter.
escalate_when: It finds nothing for a word that is visibly on the page.
---

# Find in document does nothing

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
