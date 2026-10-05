---
id: rename-matter
title: Renaming a matter or sub-matter
status: by-design
surfaces:
  - matter
  - any
words:
  - rename
  - misspelled
  - misspelt
  - change the name
  - typo in the name
cause: Matters are renamed in place.
say: Hover the matter in the sidebar and click the pencil (or double-click its name), fix it and press Enter. You can also click the name at the top of the matter's page.
user_can:
  - Sidebar: pencil, edit, Enter.
escalate_when: The new name does not stick after a reload.
---

# Renaming a matter or sub-matter

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
