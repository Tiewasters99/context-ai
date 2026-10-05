---
id: sealed-matter-entry
title: A sealed matter is "not found" or asks to confirm it's you
status: by-design
surfaces:
  - matter
  - any
symptoms:
  - Matter not found
words:
  - matter not found
  - sealed
  - second factor
  - confirm it
  - securespace
  - can't open the matter
cause: A sealed matter opens only after the second factor; until then it can look as if it isn't there.
say: That may be a sealed matter: it opens only after you confirm it's you with your second factor, and until then it can look as if it isn't there. If you haven't set up a second factor, do that in Settings first.
user_can:
  - Confirm with your second factor when asked.
  - Settings to set one up.
escalate_when: They have lost their second factor — the team has to help.
---

# A sealed matter is "not found" or asks to confirm it's you

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
