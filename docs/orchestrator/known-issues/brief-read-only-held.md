---
id: brief-read-only-held
title: The brief is read-only: another window is editing it
status: by-design
surfaces:
  - brief-desk
symptoms:
  - Read-only: this brief is being edited
  - Take over editing
words:
  - read-only
  - read only
  - can't type
  - cannot type
  - locked
  - another window
  - won't let me edit
cause: One person edits a brief at a time; another window — often your own other tab — holds it. A closed window lets go within about two and a half minutes.
say: One person edits a brief at a time, and another window has it open — often your own other tab. Close that window, or press Take over editing. The other window turns read-only within about half a minute and keeps its text on screen, unsaved.
user_can:
  - Close the other window, or press Take over editing.
  - If the other window has unsaved work, use Save as there first.
escalate_when: It stays read-only for more than three minutes with no other window open.
note: 105 brief_edit_leases; RENEW_MS 30 s, lapse 150 s.
---

# The brief is read-only: another window is editing it

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
