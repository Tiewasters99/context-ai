---
id: vault-failed-to-fetch
title: "Couldn't load this matter's documents (… Failed to fetch)"
status: by-design
surfaces:
  - vault
  - brief-desk
  - any
symptoms:
  - Couldn't load this matter's documents
words:
  - failed to fetch
  - typeerror
  - network
  - won't load
cause: The browser could not reach the server — usually a dropped or switching connection, sometimes a browser extension. Nothing is lost.
say: That means the browser couldn't reach us for a moment — usually the connection dropped or switched. Your documents are safe.
user_can:
  - Reload the page.
  - If it keeps happening, try a private window (extensions off).
escalate_when: It fails in a private window too.
---

# "Couldn't load this matter's documents (… Failed to fetch)"

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
