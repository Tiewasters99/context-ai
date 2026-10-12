# Known issues — what the Orchestrator knows about what breaks

One file per issue. When someone tells the Orchestrator that something is broken, missing, slow, refused or wrong, it calls `known_issues` with their words and answers from the matching entries (Fable's review of 2026-10-02, P1).

## An entry

```
---
id: brief-read-only-held            # the file name, kebab-case
title: The brief is read-only: another window is editing it
status: by-design                   # open | fixed | by-design
fixed_in: a0eaa51e84f0              # only for fixed: the MERGE commit of the fix on main
surfaces:                           # where the person is: brief-desk vault reader matter
  - brief-desk                      #   cite-check connections settings sign-in assistant any
symptoms:                           # EXACT words on screen; CI fails if they vanish from the code
  - Take over editing
words:                              # plain words people use for it
  - read-only
cause: one true sentence
say: what the person hears (no PR numbers, commits, names of services, or "Eden")
user_can:
  - the steps they can take
orchestrator_can:
  - what the Orchestrator may check or do
escalate_when: when to pass it to the team
note: for the team only — never said to the person
seen:
  - 2026-10-02 what was actually seen (evidence, not a promise)
---
```

## Adding or changing one

1. Edit or add the file here.
2. `node scripts/build-known-issues.mjs` (regenerates `lib/known-issues.generated.mjs`, including main's commit order).
3. `node scripts/_verify-known-issues.mjs`, then commit both.

A fix closes its entry by changing `status` to `fixed` and adding `fixed_in` — never by deleting it: for a while, people with an old tab still see the old behaviour, and the Orchestrator can tell them a reload brings the fix. Fixed entries retire on their own 60 days after the fix.
