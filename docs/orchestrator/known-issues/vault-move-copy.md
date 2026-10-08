---
id: vault-move-copy
title: Moving or copying documents
status: by-design
surfaces:
  - vault
  - matter
  - any
words:
  - move
  - copy
  - paste
  - cut
  - drag
  - drag stopped working
  - file it under
cause: Documents move by drag or by Cut and Paste, copy by Copy and Paste; a drag onto a sidebar matter asks for confirmation after a short press.
say: Select the documents (Ctrl or Shift click, or drag a box), then drag them onto a folder — or right-click, Cut or Copy, and right-click the destination to Paste. In the sidebar, press and hold a moment before dragging; a card asks you to confirm.
user_can:
  - Right-click, Cut or Copy, then right-click the folder and Paste.
  - Ctrl+X, Ctrl+C and Ctrl+V work in the list.
orchestrator_can:
  - Propose a move with move_document for them to confirm (not from the Brief Desk).
escalate_when: A move or paste reports success but the document stays put.
---

# Moving or copying documents

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
