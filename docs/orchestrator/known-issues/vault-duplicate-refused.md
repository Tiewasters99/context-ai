---
id: vault-duplicate-refused
title: An upload is refused as already filed
status: by-design
surfaces:
  - vault
symptoms:
  - is already filed as
words:
  - duplicate
  - already filed
  - won't upload
  - already uploaded
  - refused
cause: The same file (same name and size) is already in this matter.
say: That file is already filed in this matter, so the Vault opened nothing new. Use the copy that's there; to replace it, delete it first.
user_can:
  - Open the existing copy named in the message.
orchestrator_can:
  - Find the existing copy by name.
escalate_when: No such copy exists.
---

# An upload is refused as already filed

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
