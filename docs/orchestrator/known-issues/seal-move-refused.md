---
id: seal-move-refused
title: A move or copy out of a SecureSpace is refused
status: by-design
surfaces:
  - vault
  - matter
  - any
words:
  - sealed
  - securespace
  - secure space
  - can't move
  - refused
  - out of the seal
cause: A sealed document never moves or copies to anything less sealed, and entering a sealed matter asks for your second factor.
say: That's the seal working: a sealed document can't move or be copied to anything less sealed, and going into a sealed matter asks you to confirm it's you first.
user_can:
  - Move it within the seal, or into a matter sealed at least as tightly.
escalate_when: They need it out of the seal for a real reason — that is a decision for the team.
---

# A move or copy out of a SecureSpace is refused

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
