---
id: share-no-account
title: Sharing says "No Contextspaces account for …"
status: open
surfaces:
  - matter
  - any
symptoms:
  - No Contextspaces account
words:
  - invite
  - share
  - no account
  - can't add
  - not found
cause: Invitations look a person up by the address they first signed up with; someone who changed their sign-in address is not found by the new one.
say: Sharing finds people by the address they first signed up with. Try that address; if it still says there's no account, I'll write it up for the team.
user_can:
  - Try the address the person first signed up with.
escalate_when: The second address fails too.
note: profiles.email drift; fix is PR #208 / migration 082, awaiting Eden.
---

# Sharing says "No Contextspaces account for …"

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
