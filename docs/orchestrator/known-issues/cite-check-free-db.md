---
id: cite-check-free-db
title: Cite-Check says every citation needs a Westlaw paste
status: fixed
fixed_in: 0da4a1fc6dce
surfaces:
  - cite-check
  - matter
symptoms:
  - Westlaw paste
words:
  - free database
  - not found
  - westlaw paste
  - cite-check
  - cite check
cause: The free-database lookup was being refused, so every citation read as not found; it now goes through.
say: The free-database lookup in Cite-Check was failing quietly, so citations read as not found when they hadn't really been checked. That's fixed — re-run the check to get real results.
user_can:
  - Re-run the Cite-Check on the brief.
escalate_when: Re-run results still say not found for a well-known case.
---

# Cite-Check says every citation needs a Westlaw paste

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
