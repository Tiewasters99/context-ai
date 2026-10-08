---
id: brief-record-wrong-matter
title: The desk searches another matter (or another client)
status: by-design
surfaces:
  - brief-desk
words:
  - wrong matter
  - other client
  - another client
  - wrong client
  - wrong case
  - wrong record
  - searching
  - record
cause: The desk searches the brief's record: the matter chosen under Record in the desk header, otherwise the matter the brief is filed in. A tab opened before the brief was moved keeps the old matter until it is reloaded.
say: The desk searches the brief's record — the matter shown next to Record in the desk header, or else the matter the brief is filed in. Most often the tab was opened before the brief was moved, and a reload fixes it.
user_can:
  - Reload the tab (F5) once your work is saved.
  - Check Record in the desk header and change it if it names the wrong matter.
  - If the brief itself is filed in the wrong matter, move it in the Vault (Cut, then Paste on the right matter).
orchestrator_can:
  - Name the record matter from the current context and compare it with the brief's caption.
escalate_when: It still names an unrelated matter after a reload.
note: recordRootId derives from meta.matterspace_id loaded once (BriefDesk.tsx ~701). Seen 10-02: Bushell v20 copy filed under DeCamara, then searched DeCamara/Kaya until reloaded.
seen:
  - 2026-10-02 a brief copy filed under another client searched that client until moved and reloaded
---

# The desk searches another matter (or another client)

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
