// Triage checks against error strings taken verbatim from live Contextspaces
// documents (fleming + decamara-v-bryn-mawr, read 2026-08-01 via MCP).
import { classifyError, summarize, describe } from '../lib/ingest-triage.mjs';
import assert from 'node:assert';

const LIVE = [
  ['insert passages: unsupported Unicode escape sequence', 'encoding_reject'],
  ['no passages extracted', 'no_text'],
  ['embed 429: {\n "error": {\n "message": "Rate limit reached for text-embedding-3-small in organization org-jKZ... on tokens per min (TPM): Limit 1000000, Used 979880, Requeste', 'rate_limit_429'],
  ['embed 400: {\n "error": {\n "message": "Invalid \'input[0]\': maximum input length is 8192 tokens.",', 'token_limit_400'],
  ['embed 400: {\n "error": {\n "message": "Requested 943140 tokens, max 300000 tokens per request",\n "type": "max_tokens_per_request",', 'token_limit_400'],
  ['gemini network error: gemini stream idle >120s', 'media_timeout'],
  ['gemini attempt exceeded 8min wall clock', 'media_timeout'],
  ['bad XRef entry', 'corrupt_file'],
  ['Command token too long', 'corrupt_file'],
  ['EPUB is DRM-protected; cannot extract text.', 'corrupt_file'],
  ['upload: The object exceeded the maximum allowed size', 'too_large'],
  ['insert passages: JWT expired', 'auth'],
  ['', 'other'],
  ['something nobody has seen before', 'other'],
];

let bad = 0;
for (const [msg, want] of LIVE) {
  const got = classifyError(msg);
  if (got !== want) { bad++; console.log(`FAIL  want=${want} got=${got}  «${msg.slice(0, 60)}»`); }
  else console.log(`  ok  ${want.padEnd(16)} «${msg.slice(0, 52).replace(/\n/g, ' ')}»`);
}

// Ordering matters: a 429 body also contains the word "tokens", and a
// too_large body contains "upload:". Confirm precedence holds.
assert.strictEqual(classifyError('embed 429: ... on tokens per min (TPM)'), 'rate_limit_429', '429 must beat token rules');
assert.strictEqual(classifyError('upload: exceeded the maximum allowed size'), 'too_large', 'size must beat storage rule');
console.log('  ok  precedence between overlapping patterns');

// Summary must sort blocking first and split the counts correctly.
const s = summarize([
  { error: 'no passages extracted' },
  { error: 'no passages extracted' },
  { error: 'gemini network error: gemini stream idle >120s' },
  { error: 'embed 429: Rate limit reached' },
]);
assert.strictEqual(s.total, 4);
assert.strictEqual(s.groups[0].severity, 'blocking', 'blocking classes sort first');
assert.strictEqual(s.needsHuman, 1, 'one media_timeout needs a human');
assert.strictEqual(s.autoRetryable, 1, 'one 429 is auto-retryable');
console.log('  ok  summarize() severity ordering and counts');

// Every class must carry a real action — an empty action is a silent dead end.
for (const [, cls] of LIVE) {
  const d = describe(cls);
  assert(d.action && d.action.length > 30, `${cls} needs a substantive action`);
  assert(['blocking', 'transient', 'benign'].includes(d.severity), `${cls} severity`);
}
console.log('  ok  every class has an actionable remedy');

console.log(bad === 0 ? '\nAll triage checks passed.' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
