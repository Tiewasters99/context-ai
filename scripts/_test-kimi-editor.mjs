// Live smoke test: can Kimi K3 hold the Editor's pen?
//
// Validates, against the real Moonshot API with the key in context-ai\.env:
//   1. the key + endpoint work;
//   2. kimi-k3 honors an OpenAI-style FORCED tool_choice (our structured path);
//   3. its plan anchors and edit `before` anchors are verbatim enough to
//      survive the deterministic verifier (the whole ballgame);
//   4. rough token cost for a pass.
//
// Run: node scripts/_test-kimi-editor.mjs   (Node ≥ 23.6 strips types natively)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyEdits } from '../src/lib/editor/verifier.ts';
import { CORRECTIVE_MARKS, PRAISE_MARKS } from '../src/lib/editor/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync('C:/Users/equai/context-ai/.env', 'utf8');
const key = envText.match(/^MOONSHOT_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key || key === 'PASTE') throw new Error('MOONSHOT_API_KEY not set in context-ai\\.env');

const MODEL = process.argv[2] || 'kimi-k3';
const charter = readFileSync(join(here, '../docs/editor/CONSTITUTION.md'), 'utf8');
const PREAMBLE = `You are the Contextspaces Editor. Your founding charter follows — it is your identity, your principles, and your procedures. Work from it.\n\n${charter}\n\n---\n`;

// A small manuscript with planted AI-isms, plus a citation, a quotation,
// and numbers the verifier must find untouched.
const MANUSCRIPT = `It is important to note that the motion presents a deeply complex question. In today's fast-paced legal landscape, courts must navigate the delicate balance between procedural rigor and substantive justice.

The record tells a different story. Nievera testified that the gate logs were exported on March 4, 2024, and that 643 entries were reviewed. (ECF 131 at 12.) As the court observed, "the export was complete when tendered." No party disputes the timeline.

In conclusion, the foregoing considerations demonstrate that, at the end of the day, the motion's profound implications resonate far beyond this case, weaving a rich tapestry of doctrinal significance.`;

const PLAN_SCHEMA = {
  type: 'object',
  required: ['thesis', 'assessment', 'sections'],
  properties: {
    thesis: { type: 'string' },
    assessment: { type: 'string' },
    sections: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['title', 'firstWords', 'role'],
        properties: {
          title: { type: 'string' },
          firstWords: { type: 'string', description: 'The first 6–12 words of the section, copied VERBATIM character-for-character from the manuscript.' },
          role: { type: 'string' },
          structuralNote: { type: 'string' },
        },
      },
    },
  },
};

const SECTION_SCHEMA = {
  type: 'object',
  required: ['edits', 'praise'],
  properties: {
    edits: {
      type: 'array',
      items: {
        type: 'object',
        required: ['before', 'claim', 'failure', 'mark', 'authority', 'after'],
        properties: {
          before: { type: 'string', description: 'The flagged passage, VERBATIM character-for-character, long enough to be unique.' },
          claim: { type: 'string' },
          failure: { type: 'string' },
          mark: { type: 'string', enum: [...CORRECTIVE_MARKS] },
          authority: { type: 'string' },
          after: { type: 'string' },
        },
      },
    },
    praise: {
      type: 'array',
      items: {
        type: 'object',
        required: ['quote', 'mark', 'note'],
        properties: {
          quote: { type: 'string' },
          mark: { type: 'string', enum: [...PRAISE_MARKS] },
          note: { type: 'string' },
        },
      },
    },
  },
};

let totalIn = 0, totalOut = 0;

async function structured(system, userContent, toolName, toolDescription, schema, maxTokens) {
  const res = await fetch('https://api.moonshot.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      // +12k thinking headroom, mirroring the adapter: thinking spends from
      // max_tokens and a payload-sized budget dies with finish_reason=length
      max_tokens: maxTokens + 12_000,
      // no temperature: kimi-k3 rejects any value but 1 (adapter does the same)
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      tools: [{ type: 'function', function: { name: toolName, description: toolDescription, parameters: schema } }],
      // 'required' not a named choice: kimi-k3's thinking is incompatible
      // with tool_choice 'specified' (adapter does the same)
      tool_choice: 'required',
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${bodyText.slice(0, 400)}`);
  const json = JSON.parse(bodyText);
  totalIn += json.usage?.prompt_tokens ?? 0;
  totalOut += json.usage?.completion_tokens ?? 0;
  const args = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (typeof args !== 'string') throw new Error(`no forced tool call in response; finish_reason=${json.choices?.[0]?.finish_reason}, content=${String(json.choices?.[0]?.message?.content).slice(0, 200)}`);
  return JSON.parse(args);
}

console.log(`— model: ${MODEL}\n— call 1: the plan…`);
const plan = await structured(
  PREAMBLE + 'Your task in this pass: READ FOR THE ARGUMENT. Do not edit yet. Produce the document-level plan: thesis, structural assessment, and sections with VERBATIM firstWords anchors (6–12 words, character for character — they are matched mechanically).',
  `THE MANUSCRIPT\n\n${MANUSCRIPT}`,
  'file_document_plan', 'File the document-level plan.', PLAN_SCHEMA, 3000,
);
console.log(`  thesis: ${plan.thesis}`);
let anchored = 0;
for (const s of plan.sections) {
  const hit = MANUSCRIPT.includes(s.firstWords);
  if (hit) anchored++;
  console.log(`  ${hit ? '✓' : '✗'} anchor [${s.title}]: “${s.firstWords}”`);
}

console.log('— call 2: the section edit…');
const result = await structured(
  PREAMBLE + 'Your task in this pass: EDIT this manuscript as one section. For every flagged passage produce before (VERBATIM, unique), claim, failure, mark (charter vocabulary only), authority, after (rewrite FROM the claim; empty string proposes a cut). Citations, quotations, record cites, numbers, and defined terms are untouchable. Do not flag what does not need fixing. Record praise too.',
  `THE DOCUMENT PLAN\nThesis: ${plan.thesis}\nAssessment: ${plan.assessment}\n\nTHE MANUSCRIPT\n\n${MANUSCRIPT}`,
  'file_section_edits', 'File the proposed edits and praise, each with its full work-product.', SECTION_SCHEMA, 8000,
);

const raw = result.edits.map((e, i) => ({ id: `edit-${i}`, ...e }));
const { accepted, rejected } = verifyEdits(MANUSCRIPT, raw);
console.log(`  edits proposed: ${raw.length}, praise: ${result.praise.length}`);
console.log(`  verifier: ${accepted.length} accepted, ${rejected.length} rejected`);
for (const e of accepted) console.log(`  ✓ [${e.mark}] “${e.before.slice(0, 60)}…” → “${(e.after || '(cut)').slice(0, 60)}”`);
for (const r of rejected) console.log(`  ✗ [${r.mark}] ${r.rejectionReason}: “${r.before.slice(0, 70)}”`);

const cost = MODEL === 'kimi-k3' ? (totalIn * 3 + totalOut * 15) / 1e6 : (totalIn * 0.95 + totalOut * 4) / 1e6;
console.log(`— tokens: ${totalIn} in / ${totalOut} out ≈ $${cost.toFixed(4)} (uncached)`);

if (anchored === 0) throw new Error('FAIL: no plan anchor resolved');
if (accepted.length === 0) throw new Error('FAIL: no edit survived the verifier');
console.log(`\nPASS — ${MODEL} holds the pen: forced tool calls honored, ${anchored}/${plan.sections.length} anchors verbatim, ${accepted.length}/${raw.length} edits survived the verifier.`);
