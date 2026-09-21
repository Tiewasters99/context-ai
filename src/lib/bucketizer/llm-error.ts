// The one thing the bulk runner needs to know about a failed model call: what
// the server answered.
//
// The class itself now lives in `lib/llm-call-error.mjs`, because the windowed
// classification loop that asks `instanceof` on it runs in two places: the tab,
// where the call goes over HTTP to `/api/llm`, and the Fly worker, where
// `lib/llm-server-call.mjs` runs the same gate → seal → meter → clamp → record
// → send in process. The two must classify a refusal identically — a 402 that
// pauses a browser run and merely fails a server document would be the same bug
// in two colours — so there is one class and both sides import it.
//
// This file is the shim the browser keeps importing. Nothing about it changed.
export { LlmCallError } from '../../../lib/llm-call-error.mjs';
