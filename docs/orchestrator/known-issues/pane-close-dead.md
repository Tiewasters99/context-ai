---
id: pane-close-dead
title: The close button in the case pane does nothing
status: fixed
fixed_in: 44ff59b22f62
surfaces:
  - brief-desk
words:
  - close
  - x button
  - won't close
  - case pane
  - close button
cause: The document viewer inside the case pane had its own close button that was not connected.
say: Both close buttons in the case pane now close it; in an older tab the inner one did nothing.
user_can:
  - Use the pane's own close button at its top left.
escalate_when: Neither closes it after a reload.
---

# The close button in the case pane does nothing

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
