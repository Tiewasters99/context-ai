---
id: seal-questions
title: Questions about how safe a SecureSpace is
status: open
surfaces:
  - any
words:
  - is it secure
  - is the seal
  - sealed safe
  - bucketizer sealed
  - office shelf sealed
  - who can see sealed
cause: Some protections around sealed matters are still being completed.
say: A SecureSpace keeps sealed documents out of outside AI and requires your second factor to enter. For anything beyond that — or before you run a whole-matter tool over a parent that holds a sealed folder, or put a sealed document on a public shelf — let me pass your question to the team.
user_can:
  - Don't run the Bucketizer on a parent that holds a sealed sub-folder, and don't put sealed documents on a public shelf, until the team confirms.
escalate_when: Always.
note: 098 (PR #251) not merged: aal1 direct reads and no WITH CHECK on documents UPDATE; Bucketizer parent run reads sealed child (~bucketizer-run 506); Office covers copy sealed pages. Never describe the seal as complete.
---

# Questions about how safe a SecureSpace is

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
