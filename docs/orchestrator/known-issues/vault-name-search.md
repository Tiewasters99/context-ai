---
id: vault-name-search
title: Searching by name misses files with hyphens or underscores
status: fixed
fixed_in: 30bb5284ff9f
surfaces:
  - vault
  - brief-desk
words:
  - hyphen
  - underscore
  - search by name
  - name search
  - search the name
cause: Name search used to match one exact string; it now matches each word, ignoring punctuation.
say: Name search matches each word now, ignoring punctuation — "Verified Petition v. 18" finds a file named Verified-Petition-v18.
user_can:
  - Search with the distinctive words of the name.
escalate_when: A file with those words is not found after a reload.
---

# Searching by name misses files with hyphens or underscores

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
