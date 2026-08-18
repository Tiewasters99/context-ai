// Live smoke test: can Kimi K3 hold the Editor's pen?
//
// Validates, against the real Moonshot API with the key in context-ai\.env:
//   1. the key + endpoint work;
//   2. kimi-k3 honors an OpenAI-style FORCED tool_choice (our structured path);
//   3. its plan anchors and edit `before` anchors are verbatim enough to
//      survive the deterministic verifier (the whole ballgame);
//   4. rough token cost for a pass.
//
// Run: node scripts/_test-kimi-editor.mjs [model] [host] [form]
//   model: kimi-k3 (default) | kimi-k2.6 | …
//   host:  moonshot (default) | fireworks (uses FIREWORKS_API_KEY + slug)
//   form:  optional charter form (brief | memo | … | marketing | presentation)
// (Node ≥ 23.6 strips types natively)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyEdits } from '../src/lib/editor/verifier.ts';
import { CORRECTIVE_MARKS, PRAISE_MARKS } from '../src/lib/editor/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync('C:/Users/equai/context-ai/.env', 'utf8');

const MODEL = process.argv[2] || 'kimi-k3';
const HOST = process.argv[3] || 'moonshot';
const FORM = process.argv[4] || '';

const HOSTS = {
  moonshot: {
    url: 'https://api.moonshot.ai/v1/chat/completions',
    envKey: 'MOONSHOT_API_KEY',
    model: (m) => m,
    // kimi-k3 thinking is incompatible with a named tool_choice
    toolChoice: () => 'required',
  },
  fireworks: {
    url: 'https://api.fireworks.ai/inference/v1/chat/completions',
    envKey: 'FIREWORKS_API_KEY',
    model: (m) => (m.startsWith('accounts/') ? m : `accounts/fireworks/models/${m.replace(/\./g, 'p')}`),
    // standard OpenAI named choice; switch to 'any' if the thinking conflict appears here too
    toolChoice: (name) => ({ type: 'function', function: { name } }),
  },
};
const host = HOSTS[HOST];
if (!host) throw new Error(`unknown host: ${HOST}`);
const key = envText.match(new RegExp(`^${host.envKey}=(.+)$`, 'm'))?.[1]?.trim();
if (!key || key === 'PASTE') throw new Error(`${host.envKey} not set in context-ai\\.env`);

const charter = readFileSync(join(here, '../docs/editor/CONSTITUTION.md'), 'utf8');
const PREAMBLE = `You are the Contextspaces Editor. Your founding charter follows — it is your identity, your principles, and your procedures. Work from it.\n\n${charter}\n\n---\n`;
const FORM_CHARGE = FORM
  ? `\n\nTHE FORM: This manuscript is a ${FORM}. The charter's "forms of the work" entry for the ${FORM} governs its register and its characteristic failures — hold the manuscript to it.`
  : '';

// Small manuscripts with planted AI-isms per form; the default legal one
// also carries a citation, a quotation, and numbers the verifier must find
// untouched.
const MANUSCRIPTS = {
  default: `It is important to note that the motion presents a deeply complex question. In today's fast-paced legal landscape, courts must navigate the delicate balance between procedural rigor and substantive justice.

The record tells a different story. Nievera testified that the gate logs were exported on March 4, 2024, and that 643 entries were reviewed. (ECF 131 at 12.) As the court observed, "the export was complete when tendered." No party disputes the timeline.

In conclusion, the foregoing considerations demonstrate that, at the end of the day, the motion's profound implications resonate far beyond this case, weaving a rich tapestry of doctrinal significance.`,
  marketing: `In today's fast-paced legal landscape, Contextspaces is a game-changing platform that elevates your practice and unlocks seamless workflows. Our cutting-edge solution empowers legal teams to harness the transformative power of AI.

Contextspaces stores every matter's documents with page:line citations, runs OCR on scans automatically, and lets any AI assistant your firm already uses read the file through one connector. A solo practitioner ingested a 643-document federal docket in one afternoon.

At the end of the day, Contextspaces isn't just a tool — it's a journey. Join us as we revolutionize the future of law, together!`,
  presentation: `Slide 1 — Key Takeaways
- Leveraging synergies across the litigation lifecycle
- Driving impactful outcomes through innovation
- Empowering stakeholders at every touchpoint

Slide 2 — The Problem
- Lawyers spend 11 hours per week searching for documents they already have
- 68% of discovery costs are document review
- Context is lost between matters, tools, and teams

Slide 3 — Conclusion
- The future is now
- Transformation is a journey, not a destination
- Together, we can unlock what's next`,
};
const MANUSCRIPT = MANUSCRIPTS[FORM] || MANUSCRIPTS.default;

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

// Plain https POST: node's fetch (undici) gives up if response headers take
// >5 min, and K3's thinking on a big edit call can exceed that.
import { request as httpsRequest } from 'node:https';
function post(url, bodyObj, timeoutMs = 900_000) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: data }));
    });
    req.on('timeout', () => { req.destroy(new Error(`no response after ${timeoutMs / 1000}s`)); });
    req.on('error', reject);
    req.end(JSON.stringify(bodyObj));
  });
}

async function structured(system, userContent, toolName, toolDescription, schema, maxTokens) {
  const res = await post(host.url, {
      model: host.model(MODEL),
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
      tool_choice: host.toolChoice(toolName),
  });
  const bodyText = res.text;
  if (!res.ok) throw new Error(`${res.status}: ${bodyText.slice(0, 400)}`);
  const json = JSON.parse(bodyText);
  totalIn += json.usage?.prompt_tokens ?? 0;
  totalOut += json.usage?.completion_tokens ?? 0;
  const args = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (typeof args !== 'string') throw new Error(`no forced tool call in response; finish_reason=${json.choices?.[0]?.finish_reason}, content=${String(json.choices?.[0]?.message?.content).slice(0, 200)}`);
  return JSON.parse(args);
}

console.log(`— model: ${MODEL} @ ${HOST}${FORM ? ` (form: ${FORM})` : ''}\n— call 1: the plan…`);
const plan = await structured(
  PREAMBLE + 'Your task in this pass: READ FOR THE ARGUMENT. Do not edit yet. Produce the document-level plan: thesis, structural assessment, and sections with VERBATIM firstWords anchors (6–12 words, character for character — they are matched mechanically).' + FORM_CHARGE,
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
  PREAMBLE + 'Your task in this pass: EDIT this manuscript as one section. For every flagged passage produce before (VERBATIM, unique), claim, failure, mark (charter vocabulary only), authority, after (rewrite FROM the claim; empty string proposes a cut). Citations, quotations, record cites, numbers, and defined terms are untouchable. Do not flag what does not need fixing. Record praise too.' + FORM_CHARGE,
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
