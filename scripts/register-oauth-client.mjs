#!/usr/bin/env node
// Mint a CONFIDENTIAL OAuth client for a host that authenticates with
// client_id + client_secret and sends no PKCE — a Custom GPT's Actions
// (docs/specs/GPT-ACTIONS-2026-09-29.md §2).
//
//   node scripts/register-oauth-client.mjs --name "Contextspaces GPT" \
//     --redirect https://chat.openai.com/aip/g-XXXX/oauth/callback \
//     --redirect https://chatgpt.com/aip/g-XXXX/oauth/callback
//
//   ... --out C:/Users/equai/gpt-oauth-client.txt     (writes id + secret there; stdout names only the file)
//
// Reads MCP_OAUTH_SECRET from the environment or from ./.env / .env.local (the same
// secret Vercel holds; a client minted with any other secret is refused by
// /api/oauth-approve and /api/oauth-token). Prints the client_id and the
// client_secret ONCE. Nothing is written anywhere: the client_id is the
// registration. Paste both into the GPT builder's Authentication panel
// (OAuth · Client ID · Client Secret · Authorization URL
// https://www.contextspaces.ai/oauth/authorize · Token URL
// https://www.contextspaces.ai/api/oauth-token · Scope contextspaces · Token
// Exchange Method: Default (POST request)).

import fs from 'node:fs';
import path from 'node:path';
import { mintConfidentialClient } from '../lib/oauth-clients.mjs';

const args = process.argv.slice(2);
const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const all = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));

const name = opt('--name') || 'Contextspaces GPT';
const redirects = all('--redirect');
if (!redirects.length) {
  console.error('usage: node scripts/register-oauth-client.mjs --name "<client name>" --redirect <https url> [--redirect <https url> …]');
  process.exit(2);
}

let secret = process.env.MCP_OAUTH_SECRET;
if (!secret) {
  // .env beside the repo root, KEY=VALUE lines, no interpolation.
  for (const name of ['.env', '.env.local', '.env.production.local']) {
    const envPath = path.resolve(process.cwd(), name);
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = /^\s*MCP_OAUTH_SECRET\s*=\s*(.+?)\s*$/.exec(line);
      if (m) { secret = m[1].replace(/^["']|["']$/g, ''); break; }
    }
    if (secret) break;
  }
}
if (!secret || /PASTE|CHANGE_ME/i.test(secret)) {
  console.error('MCP_OAUTH_SECRET is not set (env or .env). It must be the same secret production uses.');
  process.exit(2);
}

const { client_id, client_secret } = mintConfidentialClient({ client_name: name, redirect_uris: redirects }, secret);
const text = [
  `client_name:    ${name}`,
  `redirect_uris:  ${redirects.join(' , ')}`,
  `minted:         ${new Date().toISOString()}`,
  '',
  'CLIENT_ID (paste into the GPT builder > Authentication > Client ID):',
  client_id,
  '',
  'CLIENT_SECRET (paste into Client Secret; this is the only copy - delete this file once pasted):',
  client_secret,
  '',
].join('\n');
const out = opt('--out');
if (out) {
  fs.writeFileSync(out, text, { encoding: 'utf8', mode: 0o600 });
  console.log(`client written to ${out} (id + secret). Paste both into the GPT builder, then delete the file.`);
} else {
  process.stdout.write(text);
}
