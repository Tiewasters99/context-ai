---
id: processing-paused
title: Documents stuck processing
status: open
surfaces:
  - vault
  - any
symptoms:
  - Processing is paused on our side
words:
  - stuck
  - processing
  - queued
  - still processing
  - upload stuck
  - not moving
  - pending
cause: Processing has stopped on the service side; documents already uploaded are safe and resume on their own.
say: Processing is paused on our side; your document is safe and the team has been told. You don't need to upload it again — it continues on its own.
user_can:
  - Don't re-upload; it doubles the queue.
orchestrator_can:
  - check_ingest_status on the document, and pass along what it says about the worker.
escalate_when: Always, once — then tell them it has been passed on.
note: Classes: Vercel 402 DEPLOYMENT_DISABLED, Google Cloud dunning, Fly past-due, worker heartbeat silent. Never name the class to a user.
---

# Documents stuck processing

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
