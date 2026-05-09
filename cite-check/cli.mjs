#!/usr/bin/env node
// Contextspaces cite-check CLI.
//
// Usage:
//   node cite-check/cli.mjs <draft.docx|draft.md> [--matter <short_code>] [--no-store]
//
// Pipeline:
//   1. Read the draft as text (mammoth for .docx, plain read for .md).
//   2. Use Anthropic to extract every legal citation with surrounding
//      proposition + pin + signal.
//   3. For each cite: look up against the authorities store (Supabase),
//      fall back to free legal DBs (Cornell LII, CourtListener), produce
//      a confidence rating.
//   4. Persist verified records to Supabase and (if --matter is set) link
//      them to the named matter via matter_authorities.
//   5. Emit a TOA markdown file alongside the draft and a verification
//      report listing each cite's status.
//
// Required env (read from ~/context-ai/.env):
//   VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY
//
// Phase 1 deliberately defers: proposition-match, full Bluebook validation,
// Westlaw paste prompts (flagged but not interactive), and the editor UI.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './lib/env.mjs';
import { readDraft } from './lib/extract.mjs';
import { extractCitations } from './lib/anthropic.mjs';
import { runChecks } from './lib/check.mjs';
import { writeReport } from './lib/output.mjs';
import { makeStore } from './lib/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const args = parseArgs(process.argv.slice(2));
if (args._.length === 0) die('Missing draft path. Usage: cli.mjs <draft.docx|draft.md> [--matter <short_code>] [--no-store]');

const draftPath = expandTilde(args._[0]);
const matterKey = args.matter ?? null;
const persistEnabled = !args['no-store'];

console.log(`[cite-check] reading ${path.basename(draftPath)}`);
const draftText = await readDraft(draftPath);
console.log(`[cite-check] ${draftText.length} chars extracted`);

console.log(`[cite-check] extracting citations via Anthropic`);
const cites = await extractCitations(draftText, { apiKey: process.env.ANTHROPIC_API_KEY });
console.log(`[cite-check] found ${cites.length} citation(s)`);

const store = persistEnabled ? makeStore() : null;
let matter = null;
if (matterKey && store) {
  matter = await store.resolveMatter(matterKey);
  if (!matter) die(`No matter found for "${matterKey}".`);
  console.log(`[cite-check] linking verified authorities to matter: ${matter.name} (${matter.short_code})`);
}

console.log(`[cite-check] running checks (existence + confidence)`);
const results = await runChecks(cites, {
  store,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  onProgress: (i, n, c) => console.log(`  [${i}/${n}] ${c.citation_bluebook ?? c.raw}`),
});

if (store && matter) {
  for (const r of results) {
    if (r.authority_id) {
      await store.linkAuthorityToMatter({
        matter_id: matter.id,
        authority_id: r.authority_id,
        cited_in_briefs: [path.basename(draftPath)],
      });
    }
  }
}

const reportDir = path.dirname(draftPath);
const baseName = path.basename(draftPath, path.extname(draftPath));
const toaPath = path.join(reportDir, `${baseName}.toa.md`);
const reportPath = path.join(reportDir, `${baseName}.cite-report.md`);
await writeReport({ draftPath, results, toaPath, reportPath });

console.log(`\n[cite-check] done.`);
console.log(`  TOA:    ${toaPath}`);
console.log(`  Report: ${reportPath}`);
const flagged = results.filter((r) => r.flag !== 'green').length;
if (flagged > 0) {
  console.log(`  ${flagged} cite(s) flagged for review (yellow/red/blue).`);
}


function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function die(msg) {
  console.error(`[cite-check] ${msg}`);
  process.exit(1);
}

// Bash expands ~ to $HOME automatically; PowerShell and cmd.exe do not.
// We expand it here so the CLI behaves identically across shells.
function expandTilde(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
