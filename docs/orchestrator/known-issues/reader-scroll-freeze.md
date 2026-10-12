---
id: reader-scroll-freeze
title: Dragging the scrollbar on a long PDF freezes
status: fixed
fixed_in: 60795b2d39a1
surfaces:
  - reader
  - brief-desk
words:
  - freeze
  - frozen
  - scrollbar
  - scroller
  - drag
  - hangs
  - stuck scrolling
cause: A fast drag used to draw every page it passed; pages are now drawn when the drag pauses.
say: Dragging the scrollbar quickly down a long PDF used to queue up every page it passed. Now pages draw when you pause.
user_can:
  - Reload the tab if it still freezes.
escalate_when: It still freezes after a reload — note the document and its page count.
---

# Dragging the scrollbar on a long PDF freezes

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
