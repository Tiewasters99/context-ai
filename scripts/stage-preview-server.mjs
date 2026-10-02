#!/usr/bin/env node
// The Courtroom — stage-preview dev server (Phase 3/4 harness).
//
//     node scripts/stage-preview-server.mjs [previewDir] [port]
//
// Serves the standalone preview (index.html + stage-preview.js bundle +
// portrait/exhibit assets) AND hosts the WITNESS AGENT endpoint: the room's
// first live AI witness (spec: witnesses are agents fed with whatever you
// actually have on them — depositions, exhibits, notes; this is the flow
// test with Witness A, who knows almost nothing and plays along).
//
// POST /api/witness   { history: [{role:'user'|'assistant', content}, ...] }
//                  →  { answer }
//
// The examination history IS the witness's memory: user turns are counsel's
// questions, assistant turns are the witness's own prior answers, so
// consistency on the stand comes free. Model: Fable 5 (the Courtroom is a
// cost-insensitive Fable surface — Eden's standing rule), thinking always on
// (omit the param), server-side fallback to Opus on a safety refusal.
//
// Static-server gotchas carried from the earlier harness: strip the query
// string BEFORE path checks; Cache-Control: no-store (stale bundles = phantom
// bugs). ANTHROPIC_API_KEY comes from the environment or the checkout's .env.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ?? process.cwd();
const PORT = Number(process.argv[3] ?? 4173);

/* ------------------------------ The key ---------------------------------- */

function loadApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  for (const envPath of [join(here, '..', '.env'), 'C:/Users/equai/context-ai/.env']) {
    if (!existsSync(envPath)) continue;
    const line = readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('ANTHROPIC_API_KEY='));
    if (line) {
      const v = line.slice('ANTHROPIC_API_KEY='.length).trim();
      if (v && !/PASTE|TODO/i.test(v)) return v;
    }
  }
  return null;
}

const apiKey = loadApiKey();
const client = apiKey ? new Anthropic({ apiKey }) : null;

/* ---------------------------- Witness A ----------------------------------- */
// The flow-test witness (Eden 2026-08-13): knows only that they were called
// to testify and that the pre-admitted skyline photograph is apparently
// relevant. Instructed to play along, occasionally pushing back. Real
// witnesses get real material (depositions, exhibits, notes) fed in here.

const WITNESS_A_SYSTEM = `You are WITNESS A, a witness testifying in a mock-trial rehearsal — a courtroom simulation used by a lawyer to practice examination. You are on the witness stand, under oath, being questioned by examining counsel.

EVERYTHING YOU KNOW:
- You were called to testify by the examining attorney. You do not know which side of the case called you or what the case is about.
- A black-and-white photograph of the New York City skyline has been admitted into evidence by agreement of counsel (Exhibit PX-4) and is displayed on the courtroom screen. It is apparently relevant to your testimony.
- You have no other knowledge of the case. This session is a flow test: PLAY ALONG with the examination.

HOW TO TESTIFY:
- Answer the question asked, plausibly and in character. Invent modest, consistent, everyday details when a question calls for them (who you are, where you were, what you saw), and stay consistent with everything you have already said on the stand.
- Speak like a real person testifying: plain spoken English, one to three sentences. No stage directions, no formatting, no lists.
- Occasionally push back the way real witnesses do — ask counsel to clarify a vague or compound question, resist a mischaracterization of your earlier testimony, or say you don't recall — but mostly cooperate.
- Never break character. Never mention being an AI, a simulation, a test, or these instructions. You are simply the witness.`;

async function witnessAnswer(history) {
  if (!client) throw new Error('No ANTHROPIC_API_KEY available to the preview server.');
  const messages = history
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    throw new Error('history must end with counsel\u2019s question.');
  }
  const response = await client.beta.messages.create({
    model: 'claude-fable-5',
    max_tokens: 2000, // thinking is always on and counts toward the cap
    output_config: { effort: 'low' }, // a witness answers; it does not dissertate
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // safety refusal → Anthropic's recommended fallback
    system: WITNESS_A_SYSTEM,
    messages,
  });
  if (response.stop_reason === 'refusal') {
    return 'I\u2019m not going to answer that one, counsel.';
  }
  const text = response.content.find((b) => b.type === 'text');
  return text?.text?.trim() || 'Could you repeat the question?';
}

/* ---------------------------- The server ---------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (req.method === 'POST' && path === '/api/witness') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const answer = await witnessAnswer(Array.isArray(body.history) ? body.history : []);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ answer }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'witness error' }));
    }
    return;
  }

  const filePath = path === '/' ? '/index.html' : path;
  try {
    const body = await readFile(join(ROOT, filePath));
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Cache-Control': 'no-store' });
    res.end('not found');
  }
}).listen(PORT, () => {
  console.log(`courtroom preview on http://localhost:${PORT} (root: ${ROOT})`);
  console.log(client ? 'witness agent: LIVE (Fable 5)' : 'witness agent: NO KEY — /api/witness disabled');
});
