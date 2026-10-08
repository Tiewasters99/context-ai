---
id: mail-not-arriving
title: A sign-in, reset or invitation email never arrives
status: open
surfaces:
  - sign-in
  - settings
  - any
words:
  - email
  - reset password
  - password reset
  - invitation
  - invite email
  - sign-in link
  - didn't get
  - no email
cause: The platform does not yet send mail reliably.
say: Our sign-in emails aren't reliable yet. I'll have the team send you a sign-in link directly.
user_can:
  - Check spam once; do not request many links.
escalate_when: Always.
note: No platform mail sender (Supabase mailer failed 09-25; Postmark E1 not configured).
---

# A sign-in, reset or invitation email never arrives

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
