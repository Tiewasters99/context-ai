// Probe: which Bedrock models can our account run under data_retention_mode
// "none" — the sealed-tier eligibility question, answered by the account's
// own model catalog rather than by vendor marketing.
//
// bedrock-mantle exposes, per model, `data_retention.allowed_modes` (the
// modes that satisfy the model's minimum) and `data_retention.mode` (our
// effective mode). A model is a candidate sealed pen iff allowed_modes
// includes "none". The Bedrock control plane does not expose this signal;
// only bedrock-mantle GET /v1/models/{id} does, per region.
//
// Usage:
//   node scripts/_probe-bedrock-retention.mjs [--env path/to/.env] [--region us-east-1,us-west-2] [id ...]
//
// Reads BEDROCK_AWS_ACCESS_KEY_ID / BEDROCK_AWS_SECRET_ACCESS_KEY
// (/ BEDROCK_AWS_SESSION_TOKEN) — the invoke-only pen key. GetModel must be
// in its policy (it is: _verify-bedrock-pen.mjs reads the same field).
// Read-only. Prints nothing secret.

import fs from 'node:fs';
import { signRequest } from '../lib/aws-sigv4.mjs';
import { bedrockCredsFromEnv } from '../lib/assistant-core.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const envPath = opt('--env', '.env');
const regions = opt('--region', 'us-east-1,us-west-2').split(',');
const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--env' && args[i - 1] !== '--region');

// ⚠ Ids below other than the four Claude ids, openai.gpt-6-astra and
// xai.grok-4.6 (read off the AWS model cards 2026-09-16) are GUESSES at the
// catalog naming; a 404 row means "wrong id", not "model absent". Prefer the
// catalog listing when the key may list models.
// ⚠ Retention mode is PER REGION. GPT-6 Astra's bedrock-mantle endpoint is
// us-west-2 only; our account's `none` was set in us-east-1 (08-27). Probe
// both, and set the mode in any Region a sealed pen will actually use.
const DEFAULT_IDS = [
  'anthropic.claude-opus-5',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-sonnet-5',
  'anthropic.claude-fable-5-1',
  'openai.gpt-6-astra',
  'openai.gpt-5.6-sol',
  'xai.grok-4.6',
  'amazon.nova-2-pro-v1:0',
  'amazon.nova-premier-v1:0',
  'twelvelabs.pegasus-1-2-v1:0',
  'twelvelabs.marengo-embed-2-7-v1:0',
  'moonshotai.kimi-k3',
];

const env = { ...process.env };
try {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* rely on process.env */ }

const creds = bedrockCredsFromEnv(env);
if (!creds) {
  console.error(`No BEDROCK_AWS_* credentials in ${envPath} (or placeholders). Nothing probed.`);
  process.exit(2);
}

async function get(region, path) {
  const url = `https://bedrock-mantle.${region}.api.aws${path}`;
  const headers = signRequest({
    method: 'GET', url, headers: { accept: 'application/json' }, body: '',
    region, service: 'bedrock-mantle',
    accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken,
  });
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}

const rows = [];
for (const region of regions) {
  // Account-level effective mode for this region.
  const acct = await get(region, '/v1/data_retention');
  console.log(`\n== ${region}  account data_retention: ${acct.status} ${acct.json ? JSON.stringify(acct.json) : acct.text}`);

  // Full catalog first (one call); fall back to per-id GETs if the list
  // endpoint omits data_retention or is not permitted for this key.
  const list = await get(region, '/v1/models');
  const catalog = list.json?.data ?? list.json?.models ?? null;
  const byId = new Map();
  if (Array.isArray(catalog)) for (const m of catalog) byId.set(m.id ?? m.model_id ?? m.modelId, m);
  console.log(`   catalog: ${list.status}, ${byId.size} models listed${byId.size ? '' : ` (${list.text})`}`);

  const wanted = ids.length ? ids : (byId.size ? [...byId.keys()] : DEFAULT_IDS);
  for (const id of wanted) {
    let m = byId.get(id) ?? null;
    if (!m || !m.data_retention) {
      const one = await get(region, `/v1/models/${encodeURIComponent(id)}`);
      m = one.json ?? { id, _status: one.status, _err: one.text };
    }
    const dr = m.data_retention ?? {};
    rows.push({
      region, id,
      status: m._status ?? 'ok',
      effective: dr.mode ?? '',
      allowed: Array.isArray(dr.allowed_modes) ? dr.allowed_modes.join(',') : '',
      sealed_ok: Array.isArray(dr.allowed_modes) ? (dr.allowed_modes.includes('none') ? 'YES' : 'no') : '?',
      note: m.status_reason ?? (m._err ? String(m._err).replace(/\s+/g, ' ').slice(0, 90) : ''),
    });
  }
}

const sealedEligible = rows.filter(r => r.sealed_ok === 'YES').map(r => `${r.region}:${r.id}`);
console.log('\nsealed-eligible (allowed_modes includes "none"):');
console.log(sealedEligible.length ? sealedEligible.map(s => '  ' + s).join('\n') : '  (none found among probed ids)');
console.log('\nfull table:');
console.table(rows);
