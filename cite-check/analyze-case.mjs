#!/usr/bin/env node
// One-off case analyzer. Given a PDF (typically a Westlaw download of an
// opinion) and a proposition the case is being cited for, do the full
// "value-added" pass:
//   1. Extract text from the PDF.
//   2. Strip Westlaw / Lexis editorial content (headnotes, synopsis,
//      Key Numbers, KeyCite, syllabus blocks) so we never store TR
//      proprietary material.
//   3. Find the strongest passage in the OPINION text that supports
//      the proposition. If none directly supports, flag oblique
//      citation and surface the strongest reasoning passage.
//   4. Suggest related cases the opinion cites that may enrich or
//      complicate the proposition — the "Further Review" pile.
//   5. Print a structured markdown report.
//
// Usage:
//   node cite-check/analyze-case.mjs <case.pdf> --citation "<Bluebook>" --for "<proposition>"
//                                   [--matter <short_code>] [--no-store]
//
// On a successful run with persistence enabled (the default), this:
//   - finds-or-creates an authority record keyed by citation
//   - inserts a proposition row carrying the supporting_quote + oblique fields
//   - inserts a verification log entry
//   - inserts the related-cases list as a single editorial_note (private)
//   - if --matter is set, links the authority to that matter via matter_authorities

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './lib/env.mjs';
import { makeStore } from './lib/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const args = parseArgs(process.argv.slice(2));
if (args._.length === 0) die('Usage: analyze-case.mjs <case.pdf> [--citation "..."] [--for "..."] [--matter <code>] [--no-store] [--yes]');
const pdfPath = expandTilde(args._[0]);
let citation = args.citation || null;
let proposition = args.for || null;
const matterKey = args.matter ?? null;
const persistEnabled = !args['no-store'];
const skipConfirm = !!args.yes;

// Interactive fallback: prompt for any missing fields. Robust against the
// PowerShell-multi-line-paste class of mishap that silently corrupts $cite
// or $prop when several commands are pasted at once.
if (typeof citation !== 'string') {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  citation = (await rl.question('Citation (Bluebook): ')).trim();
  rl.close();
}
if (typeof proposition !== 'string') {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  proposition = (await rl.question('Cited for (proposition): ')).trim();
  rl.close();
}
if (!citation || !proposition) die('Citation and proposition both required.');

// Sanity check the PDF filename against the citation. If no word from the
// case name shows up in the filename, the user almost certainly typo'd or
// PowerShell concatenated something — flag it before we waste an API call.
const filenameLower = path.basename(pdfPath).toLowerCase();
const caseNameWords = (citation.match(/^([^,]+)/) ?? [''])[1]
  .toLowerCase()
  .split(/[\s.,&'\-]+/)
  .filter((w) => w.length >= 4 && !['matter','people','state','city','court','county','board','dept'].includes(w));
const filenameMatch = caseNameWords.some((w) => filenameLower.includes(w));

console.log('\n[analyze] About to run:');
console.log(`  PDF:         ${pdfPath}`);
console.log(`  Citation:    ${citation}`);
console.log(`  Proposition: ${proposition}`);
if (matterKey) console.log(`  Matter:      ${matterKey}`);
if (!persistEnabled) console.log(`  Persistence: OFF (--no-store)`);
if (caseNameWords.length > 0 && !filenameMatch) {
  console.log(`  ⚠ WARNING: no word from the case name appears in the PDF filename — double-check that the PDF and citation match.`);
}

if (!skipConfirm) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question('Proceed? [Y/n] ')).trim().toLowerCase();
  rl.close();
  if (answer === 'n' || answer === 'no') die('Aborted by user.');
}

// ---- 1. Extract -------------------------------------------------------------
console.log(`[analyze] reading ${path.basename(pdfPath)}`);
const buf = await fs.readFile(pdfPath);
const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
const parsed = await pdfParse(buf);
const rawText = parsed.text || '';
console.log(`[analyze] ${rawText.length} chars across ${parsed.numpages} page(s)`);

// ---- 2. Strip Westlaw editorial layer ---------------------------------------
const cleaned = stripEditorialLayer(rawText);
console.log(`[analyze] ${cleaned.length} chars after editorial-layer strip`);

// ---- 3 + 4. Analysis pass via Anthropic -------------------------------------
console.log(`[analyze] running analysis pass`);
const analysis = await analyseOpinion({
  opinionText: cleaned,
  citation,
  proposition,
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ---- 5. Persist to authorities store ----------------------------------------
let authorityId = null;
if (persistEnabled) {
  const store = makeStore();
  const matter = matterKey ? await store.resolveMatter(matterKey) : null;
  if (matterKey && !matter) die(`No matter found for "${matterKey}".`);

  // Find-or-create the authority record. Same citation across runs hits
  // the existing record; we just append a new proposition for this run.
  let existing = await store.findByCitation(citation);
  if (existing) {
    authorityId = existing.id;
    console.log(`[analyze] authority already in store (${authorityId.slice(0, 8)}); appending proposition.`);
  } else {
    const created = await store.createAuthority({
      citation_bluebook: citation,
      case_name: parseCaseName(citation),
      court: analysis.court_level ?? null,
      year: parseYear(citation),
      authority_type: 'case',
      doctrinal_subject: [],
      full_text: cleaned,
      holding_summary: analysis.holding_summary ?? null,
      source_provenance: `Westlaw paste (${path.basename(pdfPath)}) ${new Date().toISOString().slice(0, 10)}`,
      verification_status: 'verified',
      confidence_rating: 'high',
    });
    authorityId = created.id;
    console.log(`[analyze] authority created (${authorityId.slice(0, 8)}).`);
  }

  await store.logVerification({
    authority_id: authorityId,
    source: `Westlaw paste — ${path.basename(pdfPath)}`,
    notes: `Analyzer pass for proposition: ${proposition}`,
  });

  if (proposition) {
    const propId = await store.addProposition({
      authority_id: authorityId,
      proposition_text: proposition,
      pin_cite: parsePinCite(citation),
      supporting_quote: analysis.supporting_quote ?? null,
      supporting_quote_location: analysis.supporting_quote_location ?? null,
      oblique: !!analysis.oblique,
      oblique_explanation: analysis.oblique_explanation ?? null,
    });
    console.log(`[analyze] proposition recorded (${propId.slice(0, 8)}).`);
  }

  if (Array.isArray(analysis.related_cases) && analysis.related_cases.length > 0) {
    const noteText = [
      'Related cases worth reviewing (auto-surfaced by analyzer):',
      '',
      ...analysis.related_cases.map((r) => `- ${r.citation} — ${r.why}`),
    ].join('\n');
    await store.addEditorialNote({
      authority_id: authorityId,
      note_text: noteText,
      matter_id: matter?.id ?? null,
    });
    console.log(`[analyze] ${analysis.related_cases.length} related-case suggestion(s) saved as editorial note.`);
  }

  if (matter) {
    await store.linkAuthorityToMatter({
      matter_id: matter.id,
      authority_id: authorityId,
      cited_in_briefs: [],
    });
    console.log(`[analyze] linked to matter: ${matter.name} (${matter.short_code}).`);
  }
}

// ---- 6. Report --------------------------------------------------------------
const reportPath = path.join(path.dirname(pdfPath), `${path.basename(pdfPath, '.pdf')}.analysis.md`);
const cleanedPath = path.join(path.dirname(pdfPath), `${path.basename(pdfPath, '.pdf')}.opinion.txt`);
await fs.writeFile(cleanedPath, cleaned, 'utf8');
await fs.writeFile(reportPath, renderReport({ pdfPath, citation, proposition, analysis, authorityId }), 'utf8');

console.log(`\n[analyze] done.`);
console.log(`  Report:        ${reportPath}`);
console.log(`  Cleaned text:  ${cleanedPath}`);
if (authorityId) console.log(`  Stored as authority ${authorityId}`);
if (analysis.oblique) {
  console.log(`  ⚠ Oblique citation — no quotable language directly supports the proposition.`);
} else if (analysis.supporting_quote) {
  console.log(`  ✓ Supporting quote found.`);
}


// ============================================================================
// Editorial-layer stripper
// Removes Westlaw / Lexis headnotes, synopsis, Key Numbers, attorney lists,
// KeyCite signals, and any obvious TR/Lexis editorial blocks. Keeps the
// judicial opinion text intact.
// ============================================================================
function stripEditorialLayer(text) {
  let t = text;

  // Common Westlaw section markers — everything between these and the next
  // section break (or "OPINION") is editorial and gets dropped.
  const editorialBlocks = [
    /Synopsis[\s\S]*?(?=West Headnotes|Headnotes|Attorneys and Law Firms|Opinion|OPINION|Background|Holdings)/i,
    /West Headnotes[\s\S]*?(?=Attorneys and Law Firms|Opinion|OPINION|Background|Holdings)/i,
    /Headnotes\s*\(\s*\d+\s*\)[\s\S]*?(?=Attorneys and Law Firms|Opinion|OPINION|Background|Holdings)/i,
    /Attorneys and Law Firms[\s\S]*?(?=Opinion|OPINION|MEMORANDUM|PER CURIAM)/i,
    /\*\*KeyCite\b[\s\S]*?(?=\n\n|\Z)/g,
    /KeyCite Yellow Flag[\s\S]*?(?=\n\n|\Z)/g,
    /KeyCite Red Flag[\s\S]*?(?=\n\n|\Z)/g,
    /KeyCite Blue Flag[\s\S]*?(?=\n\n|\Z)/g,
  ];
  for (const re of editorialBlocks) {
    t = t.replace(re, '');
  }

  // Strip Westlaw page references like "*282" embedded in text — these are
  // West's pagination of unofficial reporters, contested doctrine.
  t = t.replace(/\*\d+\s*/g, '');

  // Drop boilerplate footer lines from Westlaw exports.
  t = t.replace(/©\s*\d{4}\s*Thomson Reuters[\s\S]*?$/gim, '');
  t = t.replace(/End of Document[\s\S]*?$/gim, '');
  t = t.replace(/\b(?:Document Details|Search Details|Status Icons)\b[\s\S]*?(?=\n\n|\Z)/gim, '');

  // Collapse runs of whitespace from the stripping.
  t = t.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  return t;
}


// ============================================================================
// Anthropic analysis pass
// Returns:
//   { supporting_quote, supporting_quote_location, oblique, oblique_explanation,
//     reasoning_passage, related_cases: [{ citation, why }], court_level,
//     holding_summary }
// ============================================================================
async function analyseOpinion({ opinionText, citation, proposition, apiKey }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required');

  const system = `You are a careful legal-citation analyst. You will receive (a) the text of a court opinion and (b) the proposition the opinion is being cited for. Run a structured analysis and return it via the analyse_opinion tool.

For supporting_quote: search the opinion for the SHORTEST passage that DIRECTLY supports the proposition — ideally a single sentence the lawyer could quote in a brief. Reproduce it verbatim. If the only support is a longer paragraph, return the paragraph but mark oblique=false.

For oblique: set true ONLY if no passage directly states or quotably supports the proposition — i.e., the proposition flows from the opinion's reasoning or holding pattern rather than from quotable language. When oblique=true, give the strongest reasoning passage (longer is fine) and an explanation in oblique_explanation of how the proposition derives from it.

For related_cases: identify up to 5 cases this opinion cites that look most likely to enrich or complicate the proposition. For each, give the citation as it appears in this opinion, and a one-sentence "why" explaining what it adds — DO NOT speculate beyond what's actually said. If fewer than 5 are clearly relevant, return only those.

For court_level: one of "U.S. Supreme Court", "federal circuit court", "federal district court", "state high court", "state intermediate appellate", "state trial", "agency", "other".

For holding_summary: 1-3 sentences distilling what THIS case actually holds (independent of the cited proposition).

Be honest. If the case doesn't support the proposition at all, say so plainly in oblique_explanation and set oblique=true.`;

  const tools = [{
    name: 'analyse_opinion',
    description: 'Return the structured analysis of this opinion against the cited proposition.',
    input_schema: {
      type: 'object',
      properties: {
        supporting_quote: { type: ['string', 'null'] },
        supporting_quote_location: { type: ['string', 'null'], description: 'page or section reference if visible in the source' },
        oblique: { type: 'boolean' },
        oblique_explanation: { type: ['string', 'null'] },
        reasoning_passage: { type: ['string', 'null'] },
        court_level: { type: 'string' },
        holding_summary: { type: 'string' },
        related_cases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              citation: { type: 'string' },
              why: { type: 'string' },
            },
            required: ['citation', 'why'],
          },
        },
      },
      required: ['oblique', 'court_level', 'holding_summary', 'related_cases'],
    },
  }];

  const userPayload = [
    `CITATION: ${citation ?? '(unspecified)'}`,
    `CITED FOR: ${proposition ?? '(unspecified)'}`,
    '',
    'OPINION TEXT (Westlaw editorial layer stripped):',
    opinionText.slice(0, 200_000),
  ].join('\n');

  const body = {
    model: 'claude-opus-4-7',
    max_tokens: 8000,
    system,
    tools,
    tool_choice: { type: 'tool', name: 'analyse_opinion' },
    messages: [{ role: 'user', content: userPayload }],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic analyse: ${res.status} ${t.slice(0, 600)}`);
  }
  const data = await res.json();
  const toolUse = (data.content ?? []).find((c) => c.type === 'tool_use');
  if (!toolUse?.input) {
    console.error('[analyze] WARNING: analyse_opinion tool not invoked. stop_reason:', data.stop_reason);
    console.error('[analyze] content blocks:', JSON.stringify(data.content, null, 2).slice(0, 2000));
    return {};
  }
  return toolUse.input;
}


// ============================================================================
// Report renderer
// ============================================================================
function renderReport({ pdfPath, citation, proposition, analysis, authorityId }) {
  const lines = [];
  lines.push(`# Case Analysis: ${path.basename(pdfPath, '.pdf')}`);
  lines.push('');
  lines.push(`**Citation:** ${citation ?? '_(not specified)_'}`);
  lines.push(`**Cited for:** ${proposition ?? '_(not specified)_'}`);
  lines.push(`**Analyzed:** ${new Date().toISOString()}`);
  lines.push(`**Court level:** ${analysis.court_level ?? '_(not determined)_'}`);
  if (authorityId) lines.push(`**Authority record:** \`${authorityId}\``);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## Holding');
  lines.push('');
  lines.push(analysis.holding_summary ?? '_(not determined)_');
  lines.push('');

  lines.push('## Support for the cited proposition');
  lines.push('');
  if (analysis.oblique) {
    lines.push('⚠ **Oblique citation.** No quotable language in this opinion directly supports the cited proposition. The proposition flows from the opinion\'s reasoning rather than from a direct statement.');
    lines.push('');
    if (analysis.oblique_explanation) {
      lines.push('**How the proposition derives from this opinion:**');
      lines.push('');
      lines.push(analysis.oblique_explanation);
      lines.push('');
    }
    if (analysis.reasoning_passage) {
      lines.push('**Strongest reasoning passage:**');
      lines.push('');
      lines.push('> ' + analysis.reasoning_passage.replace(/\n/g, '\n> '));
      lines.push('');
    }
  } else if (analysis.supporting_quote) {
    lines.push('✓ **Direct support found.**');
    lines.push('');
    lines.push('> ' + analysis.supporting_quote.replace(/\n/g, '\n> '));
    lines.push('');
    if (analysis.supporting_quote_location) {
      lines.push(`_Located at: ${analysis.supporting_quote_location}_`);
      lines.push('');
    }
  } else {
    lines.push('_(no result returned by analyzer)_');
    lines.push('');
  }

  lines.push('## Related cases worth reviewing');
  lines.push('');
  if (Array.isArray(analysis.related_cases) && analysis.related_cases.length > 0) {
    for (const r of analysis.related_cases) {
      lines.push(`- **${r.citation}** — ${r.why}`);
    }
  } else {
    lines.push('_(no related cases surfaced)_');
  }
  lines.push('');

  return lines.join('\n');
}


// ============================================================================
// helpers
// ============================================================================
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}
function expandTilde(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}
function die(msg) { console.error(`[analyze] ${msg}`); process.exit(1); }

// Light parsers for the citation string. Best-effort only; the canonical
// citation_bluebook is what's stored verbatim. These extract supplementary
// fields so the authority row can be queried by year / case_name / pin
// without re-parsing the full citation each time.
function parseYear(citation) {
  if (!citation) return null;
  const m = citation.match(/\((\d{4})\)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}
function parseCaseName(citation) {
  if (!citation) return null;
  // Case name is everything before the first ", " followed by a digit
  // (which marks the start of the citation block, e.g. "71 N.Y.2d ...").
  const m = citation.match(/^(.+?),\s+\d/);
  return m ? m[1].trim() : null;
}
function parsePinCite(citation) {
  if (!citation) return null;
  // Look for ", PAGE_NUMBER" before the year parens. Common shapes:
  //   "71 N.Y.2d 274, 282 (1988)"  → pin "282"
  //   "50 N.Y.2d 31, 44"            → pin "44"
  const m = citation.match(/,\s*(\d+(?:[-–]\d+)?)\s*(?:\(|$)/);
  return m ? m[1] : null;
}
