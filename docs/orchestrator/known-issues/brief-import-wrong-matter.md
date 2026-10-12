---
id: brief-import-wrong-matter
title: A brief brought in from Contextspaces landed in the wrong matter
status: by-design
surfaces:
  - brief-desk
symptoms:
  - File it in
words:
  - filed in the wrong
  - wrong matter
  - landed in
  - brought in
  - imported into
  - other client
cause: The Brief Desk home remembers the last "File it in" choice and files the next brief there.
say: The Brief Desk files a brief you bring in under the matter chosen in "File it in" — and it remembers the last choice, so a brief can land in the matter you worked in before.
user_can:
  - Move the brief: in the Vault, Cut it, then right-click the right matter and Paste.
  - Before bringing in the next brief, check "File it in".
orchestrator_can:
  - Find the brief by name in the current matter and tell them where it is filed.
escalate_when: The brief cannot be moved, or it reappears in the wrong matter.
note: BriefDeskHome.tsx MATTER_KEY in localStorage. Default-to-document-own-matter fix was offered 10-01, not built.
---

# A brief brought in from Contextspaces landed in the wrong matter

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
