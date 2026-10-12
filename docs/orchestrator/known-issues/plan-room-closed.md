---
id: plan-room-closed
title: "This room is not part of your plan"
status: by-design
surfaces:
  - any
symptoms:
  - This room is not part of your plan
words:
  - not part of your plan
  - plan
  - upgrade
  - can't open
  - locked room
cause: The account's plan does not include that room.
say: That room isn't part of your plan, so it stays closed. Everything in your plan is in the sidebar and the Productivity Suite.
user_can:
  - Settings shows the plan.
escalate_when: They believe the plan should include it.
---

# "This room is not part of your plan"

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
