---
id: rate-limit
title: "Too many requests just now"
status: by-design
surfaces:
  - any
symptoms:
  - Too many requests just now
words:
  - too many requests
  - rate
  - slow down
  - try again
cause: A short rate window was reached; it clears on its own.
say: Too many requests went out in a short window; it clears on its own in a moment.
user_can:
  - Wait a moment and try again.
escalate_when: It persists for more than a few minutes.
---

# "Too many requests just now"

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
