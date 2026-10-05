---
id: stale-tab
title: A feature seems missing, or opening something does nothing
status: by-design
surfaces:
  - any
symptoms:
  - This tab is out of date
words:
  - out of date
  - not there
  - doesn't work
  - does nothing
  - refresh
  - new version
  - feature missing
  - button missing
cause: A tab left open across an update runs the older version; some parts load only from the newer one.
say: Your tab may be running the version from before the last update. Save your work, then reload the tab, and it will pick up the current version.
user_can:
  - Finish or save what you are doing, then reload (F5).
escalate_when: It still happens after a reload.
---

# A feature seems missing, or opening something does nothing

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
