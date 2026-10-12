---
id: vault-file-not-found
title: "My document isn't in the Vault"
status: by-design
surfaces:
  - vault
  - matter
  - any
words:
  - can't find
  - missing
  - disappeared
  - where is
  - not in the vault
  - gone
  - lost my file
cause: Almost always the document is in another matter or sub-folder, or the list was opened before it arrived.
say: Usually it's there but somewhere else — a sub-folder or the parent matter — or the list was open before it arrived. Coming back to the Vault re-reads the list, and searching by name ignores punctuation and word order.
user_can:
  - Search the Vault by a few words of the name.
  - Open the parent matter and sort by date.
orchestrator_can:
  - Search the current matter by name; with their go-ahead, look the name up across their matters — names only, never contents.
escalate_when: It is not found by name anywhere they can see.
---

# "My document isn't in the Vault"

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
