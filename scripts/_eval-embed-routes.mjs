// Retrieval evaluation: open-weight embedding models (served locally by
// Ollama) against the Tier-A route (OpenAI text-embedding-3-small at 1024
// dims), plus a text-only baseline and hybrid fusion — the question that
// matters for sealed matters, which today have NO vectors at all.
//
// Method (deterministic after the one-time question generation):
//   1. Extract + chunk a PUBLIC-DOMAIN legal text with the repo's own
//      extractPages/chunkPages so passages look like production passages.
//   2. Sample N passages; ask one LLM call for a lawyer-style question each
//      passage answers, phrased without copying its wording. Cached to JSON
//      so re-runs re-score without paying again.
//   3. For each route: embed passages (input_type document) + questions
//      (query), cosine-rank, score recall@1/5/10 and MRR against the source
//      passage. BM25 stands in for the DB's tsvector stage; RRF(BM25, vec)
//      stands in for the two-stage hybrid.
//   4. Throughput per route (passages/s), GPU by default; --cpu asks Ollama
//      for num_gpu:0 so the Fly worker (CPU-only) case is measured too.
//
// Usage:
//   node scripts/_eval-embed-routes.mjs --pdf "<path>" [--n 60] [--max-passages 800]
//        [--routes openai,bge-m3,qwen3] [--cpu] [--out <dir>]
//
// Needs: OPENAI_API_KEY + ANTHROPIC_API_KEY in .env (question generation uses
// Claude once; scoring uses OpenAI embeddings for the baseline route), and
// Ollama at localhost:11434 with `bge-m3` and `qwen3-embedding:0.6b` pulled.
// Fictional / public-domain content ONLY — never a client document.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractPages, chunkPages } from '../lib/ingest-core.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(n);
const PDF = opt('--pdf', null);
const N = Number(opt('--n', 60));
const MAX_P = Number(opt('--max-passages', 800));
const ROUTES = opt('--routes', 'openai,bge-m3,qwen3').split(',');
const CPU = flag('--cpu');
const OUT = opt('--out', path.join(process.cwd(), 'scratch-eval'));
if (!PDF) { console.error('need --pdf <public-domain pdf>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const env = { ...process.env };
try {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }
const present = (v) => !!v && v !== 'PASTE';

// ── 1. corpus ────────────────────────────────────────────────────────────
const corpusKey = crypto.createHash('sha1').update(PDF + MAX_P).digest('hex').slice(0, 10);
const corpusPath = path.join(OUT, `corpus-${corpusKey}.json`);
let passages;
if (fs.existsSync(corpusPath)) {
  passages = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
} else {
  const buf = fs.readFileSync(PDF);
  const pages = await extractPages(buf, path.extname(PDF));
  const all = chunkPages(pages).filter((p) => (p.text || '').split(/\s+/).length >= 40);
  // Even sampling across the document so the set is not one chapter.
  const step = Math.max(1, Math.floor(all.length / MAX_P));
  passages = all.filter((_, i) => i % step === 0).slice(0, MAX_P)
    .map((p, i) => ({ id: i, page: p.page_start, text: p.text.trim() }));
  fs.writeFileSync(corpusPath, JSON.stringify(passages));
  console.log(`corpus: ${pages.length} pages → ${all.length} passages → ${passages.length} sampled`);
}
console.log(`corpus: ${passages.length} passages (${corpusPath})`);

// ── 2. questions (one LLM call, cached) ──────────────────────────────────
const qPath = path.join(OUT, `questions-${corpusKey}-n${N}.json`);
let questions;
if (fs.existsSync(qPath)) {
  questions = JSON.parse(fs.readFileSync(qPath, 'utf8'));
} else {
  if (!present(env.ANTHROPIC_API_KEY)) { console.error('ANTHROPIC_API_KEY needed once to generate questions'); process.exit(2); }
  // Seeded pick so the set is reproducible.
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const picked = [...passages].sort(() => rnd() - 0.5).slice(0, N);
  const prompt = `You are helping evaluate a legal search engine. For EACH numbered passage below, write ONE question a lawyer or law student might type into a search box that this passage answers. Rules: paraphrase — do not reuse the passage's distinctive words or phrases where a synonym exists; do not mention passage numbers; 8–25 words; no preamble. Return ONLY a JSON array of objects {"id": <number>, "q": "<question>"} in the same order.\n\n` +
    picked.map((p) => `[${p.id}] ${p.text.slice(0, 1200)}`).join('\n\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await res.json();
  if (!res.ok) { console.error('question generation failed', j); process.exit(1); }
  const text = j.content.map((c) => c.text || '').join('');
  const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  questions = arr.filter((x) => passages[x.id]).map((x) => ({ id: x.id, q: x.q }));
  fs.writeFileSync(qPath, JSON.stringify(questions, null, 1));
  console.log(`questions: ${questions.length} generated (${j.usage?.input_tokens} in / ${j.usage?.output_tokens} out tokens)`);
}
console.log(`questions: ${questions.length} (${qPath})`);

// ── 3. embedders ─────────────────────────────────────────────────────────
async function embedOpenAI(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 128) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts.slice(i, i + 128), dimensions: 1024 }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error('openai ' + res.status + ' ' + JSON.stringify(j).slice(0, 200));
    for (const d of j.data) out.push(d.embedding);
  }
  return out;
}
function ollamaEmbedder(model, { queryPrefix = '' } = {}) {
  return async (texts, kind) => {
    const out = [];
    for (let i = 0; i < texts.length; i += 32) {
      const input = texts.slice(i, i + 32).map((t) => (kind === 'query' ? queryPrefix + t : t));
      const res = await fetch('http://localhost:11434/api/embed', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input, truncate: true, options: CPU ? { num_gpu: 0 } : {} }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(`ollama ${model} ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
      out.push(...j.embeddings);
    }
    return out;
  };
}
const EMBEDDERS = {
  'openai': { label: 'text-embedding-3-small @1024 (Tier A today)', fn: (t) => embedOpenAI(t), needs: () => present(env.OPENAI_API_KEY) },
  'bge-m3': { label: 'bge-m3 (Ollama, 1024)', fn: ollamaEmbedder('bge-m3'), needs: () => true },
  // Qwen3-Embedding is trained with an instruction on the QUERY side only.
  'qwen3': { label: 'qwen3-embedding:0.6b (Ollama, 1024, query instruction)', fn: ollamaEmbedder('qwen3-embedding:0.6b', { queryPrefix: 'Instruct: Given a legal question, retrieve the passage that answers it\nQuery: ' }), needs: () => true },
};

// ── 4. scoring ───────────────────────────────────────────────────────────
function cosine(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }
function rankOf(scores, targetId) { const order = [...scores.keys()].sort((x, y) => scores[y] - scores[x]); return order.indexOf(targetId) + 1; }
function metrics(ranks) {
  const n = ranks.length;
  const at = (k) => ranks.filter((r) => r > 0 && r <= k).length / n;
  return { 'R@1': at(1), 'R@5': at(5), 'R@10': at(10), MRR: ranks.reduce((s, r) => s + (r > 0 ? 1 / r : 0), 0) / n };
}
// BM25 over simple tokens — stands in for the tsvector stage.
const tok = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function bm25Index(docs) {
  const tf = docs.map((d) => { const m = new Map(); for (const w of tok(d)) m.set(w, (m.get(w) || 0) + 1); return m; });
  const df = new Map(); for (const m of tf) for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
  const len = tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0)); const avg = len.reduce((a, b) => a + b, 0) / len.length;
  const Nn = docs.length, k1 = 1.2, b = 0.75;
  return (q) => tf.map((m, i) => tok(q).reduce((s, w) => { const f = m.get(w); if (!f) return s; const idf = Math.log(1 + (Nn - df.get(w) + 0.5) / (df.get(w) + 0.5)); return s + idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len[i] / avg)); }, 0));
}
function rrf(a, b, k = 60) { const ra = [...a.keys()].sort((x, y) => a[y] - a[x]); const rb = [...b.keys()].sort((x, y) => b[y] - b[x]); const out = new Array(a.length).fill(0); ra.forEach((id, i) => { out[id] += 1 / (k + i + 1); }); rb.forEach((id, i) => { out[id] += 1 / (k + i + 1); }); return out; }

const texts = passages.map((p) => p.text);
const results = [];
const bm25 = bm25Index(texts);
const bmRanks = questions.map(({ id, q }) => rankOf(bm25(q), id));
results.push({ route: 'text-only (BM25 ≈ tsvector stage)', ...metrics(bmRanks), 'passages/s': '—' });

for (const key of ROUTES) {
  const e = EMBEDDERS[key];
  if (!e) { console.warn(`unknown route ${key}`); continue; }
  if (!e.needs()) { console.warn(`skip ${key}: credentials absent`); continue; }
  const t0 = Date.now();
  const docVecs = await e.fn(texts, 'document');
  const secs = (Date.now() - t0) / 1000;
  const qVecs = await e.fn(questions.map((x) => x.q), 'query');
  const vRanks = [], hRanks = [];
  questions.forEach(({ id }, qi) => {
    const scores = docVecs.map((d) => cosine(qVecs[qi], d));
    vRanks.push(rankOf(scores, id));
    hRanks.push(rankOf(rrf(bm25(questions[qi].q), scores), id));
  });
  if (docVecs.some((v) => v.length !== 1024)) console.warn(`⚠ ${key}: a vector was not 1024 wide`);
  results.push({ route: e.label + (CPU ? ' [CPU]' : ''), ...metrics(vRanks), 'passages/s': (passages.length / secs).toFixed(1) });
  results.push({ route: `  hybrid RRF(BM25, ${key})`, ...metrics(hRanks), 'passages/s': '' });
  console.log(`${key}: embedded ${passages.length} passages in ${secs.toFixed(1)}s`);
}

for (const r of results) for (const k of ['R@1', 'R@5', 'R@10', 'MRR']) r[k] = Number(r[k].toFixed(3));
console.log(`\ncorpus ${path.basename(PDF)} · ${passages.length} passages · ${questions.length} questions · ${CPU ? 'CPU' : 'GPU'}`);
console.table(results);
const md = ['| route | R@1 | R@5 | R@10 | MRR | passages/s |', '|---|---|---|---|---|---|', ...results.map((r) => `| ${r.route} | ${r['R@1']} | ${r['R@5']} | ${r['R@10']} | ${r.MRR} | ${r['passages/s']} |`)].join('\n');
const stamp = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(OUT, `results-${corpusKey}-${CPU ? 'cpu' : 'gpu'}-${stamp}.md`), `# embed-routes eval — ${path.basename(PDF)} — ${stamp}\n\n${passages.length} passages · ${questions.length} questions · ${CPU ? 'CPU' : 'GPU'}\n\n${md}\n`);
console.log(`written ${OUT}`);
