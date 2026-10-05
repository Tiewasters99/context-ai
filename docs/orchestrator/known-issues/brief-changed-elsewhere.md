---
id: brief-changed-elsewhere
title: "This brief was changed in another window"
status: by-design
surfaces:
  - brief-desk
symptoms:
  - was changed in another window
  - Not saved — changed elsewhere
words:
  - changed elsewhere
  - another window
  - not saved
  - conflict
cause: Another window saved the brief after this one opened it; the desk refuses to save over that work. Nothing was overwritten.
say: Another window saved this brief after you opened it, so the desk stopped saving here rather than overwrite that work. Nothing was lost on either side. To keep what is on your screen, save it as the next version.
user_can:
  - Use Save as (the next version) to keep what is on screen.
  - Then Compare the two versions to reconcile them.
escalate_when: It appears with only one window open.
note: Optimistic lock on draft_bodies.updated_at (100). With the 105 edit hold this should be rare.
---

# "This brief was changed in another window"

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
