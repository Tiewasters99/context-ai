---
id: brief-saved-version-missing
title: "I saved the next version but can't find it"
status: fixed
fixed_in: 3ce24a3d670d
surfaces:
  - brief-desk
  - vault
words:
  - save as
  - saved
  - new version
  - can't find
  - missing
  - v19
  - v20
  - where did
cause: Save as files the new version in the same matter as the version saved from, which may differ from where an original Word file sits; a sub-folder shows only its own files.
say: Save as puts the new version in the same matter as the version you saved from — the notice after saving names it. If you opened a sub-folder, the new version may be one level up, in the parent matter.
user_can:
  - Open the parent matter and sort by date, newest first.
  - Search the matter by the brief name.
orchestrator_can:
  - Search the current matter by the brief name.
escalate_when: It is in neither the matter nor its parent.
---

# "I saved the next version but can't find it"

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
