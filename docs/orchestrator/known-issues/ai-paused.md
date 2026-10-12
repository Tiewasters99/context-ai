---
id: ai-paused
title: "AI is paused on this matter"
status: by-design
surfaces:
  - any
symptoms:
  - AI is paused on this matter
words:
  - paused
  - ai is paused
  - won't answer
  - pause
cause: Someone paused AI on this matter; nothing is sent to any model until it is resumed.
say: AI is paused on this matter, so nothing is sent to any model. An owner or admin of the matter can resume it from the matter's menu.
user_can:
  - Ask the matter's owner or admin to resume AI.
escalate_when: No owner or admin can resume it.
---

# "AI is paused on this matter"

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
