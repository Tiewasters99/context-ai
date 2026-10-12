---
id: connector-no-response
title: An outside AI is connected but does nothing
status: open
surfaces:
  - connections
  - any
words:
  - connector
  - claude
  - chatgpt
  - authorized
  - authorised
  - connected but
  - mcp
  - doesn't see
cause: Most often a stale connection on that device, or a known problem with the web version of one assistant.
say: Usually the connection on that device has gone stale. Remove Contextspaces from that assistant and add it again; if you're using Claude in a browser, the desktop app is the more reliable route right now.
user_can:
  - Remove and re-add the Contextspaces connector on that device.
  - Start a new chat after reconnecting.
escalate_when: It still does nothing after reconnecting in a new chat.
note: claude.ai web OAuth regression (docs/strategy/002); ChatGPT connectors desktop-web only; GPT unshareable.
---

# An outside AI is connected but does nothing

One entry of the Orchestrator's known-issues list. Edit the header above; run `node scripts/build-known-issues.mjs` and commit the generated file.
