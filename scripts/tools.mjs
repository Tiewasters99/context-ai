// Retrieval tools for Contextspaces. Five commands, one file.
// Called by Claude Code (or any shell) to search a matterspace's passages.
//
// Commands:
//   list-matters
//   list-matter-contents --matter <short_code_or_uuid>
//   search               --matter <short_code_or_uuid> --q "..." [filters]
//   get-passage          --id <passage_uuid> [--context-pages N]
//   get-outline          --doc <document_uuid> [--depth 2]
//
// Search filters:
//   --doc-types <a,b,c>     transcript, deposition, exhibit, brief, expert_report, ...
//   --witnesses <A,B>       filter by witness_name
//   --document-ids <u1,u2>  restrict to specific document UUIDs
//   --limit <n>             default 20
//   --summary-level <n>     default 0 (raw passages). Higher pulls from the summary tree.
//
// All commands print JSON to stdout. Errors go to stderr with non-zero exit.
//
// Env required:
//   VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (bypasses RLS; for local dogfooding only)
//   OPENAI_API_KEY              (only required for `search`)

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1024;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

switch (cmd) {
  case 'list-matters':         await listMatters(args);        break;
  case 'list-matter-contents': await listMatterContents(args); break;
  case 'search':               await search(args);             break;
  case 'get-passage':          await getPassage(args);         break;
  case 'get-outline':          await getOutline(args);         break;
  default:
    die(
      'Usage:\n' +
      '  node scripts/tools.mjs list-matters\n' +
      '  node scripts/tools.mjs list-matter-contents --matter <short_code>\n' +
      '  node scripts/tools.mjs search --matter <short_code> --q "..." [--doc-types ...] [--witnesses ...] [--limit N]\n' +
      '  node scripts/tools.mjs get-passage --id <uuid> [--context-pages N]\n' +
      '  node scripts/tools.mjs get-outline --doc <uuid> [--depth 2]'
    );
}


// -----------------------------------------------------------------------------
// 1. list-matters
//    What matters exist and how much is in each one?
// -----------------------------------------------------------------------------
async function listMatters() {
  const { data: matters, error } = await supabase
    .from('matterspaces')
    .select('id, name, short_code, description, serverspace_id, created_at')
    .order('created_at', { ascending: false });
  if (error) die(`list-matters: ${error.message}`);

  const out = [];
  for (const m of matters) {
    const { count } = await supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('matterspace_id', m.id);
    out.push({
      id: m.id,
      short_code: m.short_code,
      name: m.name,
      description: m.description,
      document_count: count || 0,
    });
  }
  print(out);
}


// -----------------------------------------------------------------------------
// 2. list-matter-contents
//    What's inside a matter, grouped by doc_type, with key metadata?
//    Claude calls this at the start of a session to plan.
// -----------------------------------------------------------------------------
async function listMatterContents(args) {
  const matter = await resolveMatter(args.matter);
  const { data: docs, error } = await supabase
    .from('documents')
    .select(
      'id, title, doc_type, witness_name, deposition_date, volume_number, ' +
      'exhibit_number, bates_prefix, bates_start, bates_end, page_count, ' +
      'processing_status, created_at'
    )
    .eq('matterspace_id', matter.id)
    .order('doc_type', { ascending: true })
    .order('volume_number', { ascending: true, nullsFirst: true })
    .order('deposition_date', { ascending: true, nullsFirst: true })
    .order('title', { ascending: true });
  if (error) die(`list-matter-contents: ${error.message}`);

  const grouped = {};
  for (const d of docs) {
    const bucket = pluralize(d.doc_type);
    grouped[bucket] = grouped[bucket] || [];
    grouped[bucket].push(trimDoc(d));
  }
  print({
    matter: {
      id: matter.id,
      short_code: matter.short_code,
      name: matter.name,
      description: matter.description,
    },
    document_count: docs.length,
    ...grouped,
  });
}


// -----------------------------------------------------------------------------
// 3. search
//    Hybrid retrieval: tsvector rank + pgvector cosine. Returns passages
//    with citation coordinates ready to cite.
// -----------------------------------------------------------------------------
async function search(args) {
  if (!args.q) die('search: --q "<query text>" is required');
  const matter = await resolveMatter(args.matter);

  const queryEmbedding = await embedOne(args.q);

  const { data, error } = await supabase.rpc('search_passages', {
    p_matterspace_id:    matter.id,
    p_query_text:        args.q,
    p_query_embedding:   queryEmbedding,
    p_doc_types:         splitList(args['doc-types']),
    p_witness_names:     splitList(args.witnesses),
    p_document_ids:      splitList(args['document-ids']),
    p_summary_level:     numOrDefault(args['summary-level'], 0),
    p_limit:             numOrDefault(args.limit, 20),
  });
  if (error) die(`search: ${error.message}`);

  print({
    query: args.q,
    matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
    result_count: data.length,
    results: data.map(r => ({
      passage_id: r.passage_id,
      document_id: r.document_id,
      document_title: r.document_title,
      doc_type: r.doc_type,
      citation: formatCitation(r),
      coordinates: {
        page_start: r.page_start,
        page_end: r.page_end,
        line_start: r.line_start,
        line_end: r.line_end,
      },
      witness: r.witness_name,
      examination: r.examination_type,
      passage_type: r.passage_type,
      text: r.text,
      scores: {
        hybrid: round3(r.hybrid_score),
        text_rank: round3(r.text_rank),
        vector: round3(r.vector_score),
      },
    })),
  });
}


// -----------------------------------------------------------------------------
// 4. get-passage
//    Pull one passage by id, optionally with surrounding pages of context
//    (same document, neighboring page range).
// -----------------------------------------------------------------------------
async function getPassage(args) {
  if (!args.id) die('get-passage: --id <passage_uuid> is required');

  const { data: p, error } = await supabase
    .from('passages')
    .select(
      'id, document_id, matterspace_id, sequence_number, ' +
      'page_start, page_end, line_start, line_end, ' +
      'witness_name, examination_type, speaker, ' +
      'text, passage_type, parent_passage_id, summary_level'
    )
    .eq('id', args.id)
    .single();
  if (error) die(`get-passage: ${error.message}`);

  const { data: doc } = await supabase
    .from('documents')
    .select('id, title, doc_type')
    .eq('id', p.document_id)
    .single();

  let context = null;
  const pagesContext = numOrDefault(args['context-pages'], 0);
  if (pagesContext > 0) {
    const { data: ctx } = await supabase
      .from('passages')
      .select(
        'id, sequence_number, page_start, page_end, line_start, line_end, ' +
        'speaker, text, passage_type'
      )
      .eq('document_id', p.document_id)
      .eq('summary_level', 0)
      .gte('page_start', Math.max(1, p.page_start - pagesContext))
      .lte('page_end',   p.page_end + pagesContext)
      .order('sequence_number', { ascending: true });
    context = ctx;
  }

  print({
    passage: {
      id: p.id,
      citation: formatCitation({ ...p, document_title: doc?.title, doc_type: doc?.doc_type }),
      document: doc,
      coordinates: {
        page_start: p.page_start,
        page_end: p.page_end,
        line_start: p.line_start,
        line_end: p.line_end,
      },
      witness: p.witness_name,
      examination: p.examination_type,
      speaker: p.speaker,
      passage_type: p.passage_type,
      text: p.text,
    },
    surrounding_context: context,
  });
}


// -----------------------------------------------------------------------------
// 5. get-outline
//    Hierarchical summary tree for a document. Depth controls how deep into
//    the tree to walk. Returns nodes at each level with passage ids so the
//    caller can drill into leaves via get-passage.
//    NOTE: for now the summary tree only exists if it was populated by an
//    offline summarization pass. At summary_level=0 this degrades to a flat
//    list of the document's raw passages.
// -----------------------------------------------------------------------------
async function getOutline(args) {
  if (!args.doc) die('get-outline: --doc <document_uuid> is required');
  const depth = numOrDefault(args.depth, 2);

  const { data: doc, error: docErr } = await supabase
    .from('documents')
    .select('id, title, doc_type, page_count, witness_name, volume_number')
    .eq('id', args.doc)
    .single();
  if (docErr) die(`get-outline: ${docErr.message}`);

  // Top of tree = highest summary_level that has rows for this document.
  const { data: levels } = await supabase
    .from('passages')
    .select('summary_level')
    .eq('document_id', doc.id);
  const maxLevel = Math.max(0, ...levels.map(r => r.summary_level));
  const startLevel = Math.min(maxLevel, depth);

  const { data: nodes } = await supabase
    .from('passages')
    .select(
      'id, sequence_number, page_start, page_end, line_start, line_end, ' +
      'text, passage_type, summary_level, parent_passage_id'
    )
    .eq('document_id', doc.id)
    .eq('summary_level', startLevel)
    .order('sequence_number', { ascending: true });

  print({
    document: {
      id: doc.id,
      title: doc.title,
      doc_type: doc.doc_type,
      page_count: doc.page_count,
      witness: doc.witness_name,
      volume: doc.volume_number,
    },
    max_summary_level: maxLevel,
    returned_level: startLevel,
    node_count: nodes.length,
    nodes: nodes.map(n => ({
      id: n.id,
      summary_level: n.summary_level,
      page_range: [n.page_start, n.page_end],
      text_preview: n.text.slice(0, 400),
      full_text_length: n.text.length,
    })),
  });
}


// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------
async function resolveMatter(key) {
  if (!key) die('--matter <short_code_or_uuid> is required');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    const { data, error } = await supabase
      .from('matterspaces')
      .select('id, name, short_code, description, serverspace_id')
      .eq('id', key)
      .single();
    if (error) die(`resolve matter ${key}: ${error.message}`);
    return data;
  }
  const { data, error } = await supabase
    .from('matterspaces')
    .select('id, name, short_code, description, serverspace_id')
    .eq('short_code', key)
    .maybeSingle();
  if (error) die(`resolve matter '${key}': ${error.message}`);
  if (!data) die(`No matterspace with short_code '${key}'.`);
  return data;
}

async function embedOne(text) {
  const key = requireEnv('OPENAI_API_KEY');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIM,
      input: text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    die(`embed: ${res.status} ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

function formatCitation(row) {
  // Produce a human-readable cite string and leave the raw coords in the payload.
  const docTitle = row.document_title || 'Document';
  const docType = row.doc_type;
  const page = row.page_start === row.page_end
    ? row.page_start
    : `${row.page_start}-${row.page_end}`;
  const line = row.line_start
    ? row.line_start === row.line_end
      ? `:${row.line_start}`
      : `:${row.line_start}-${row.line_end}`
    : '';

  if (docType === 'transcript' || docType === 'deposition') {
    return `${docTitle}, ${page}${line}`;
  }
  return `${docTitle}, p. ${page}${line}`;
}

function trimDoc(d) {
  const base = {
    id: d.id,
    title: d.title,
    page_count: d.page_count,
    processing_status: d.processing_status,
  };
  if (d.witness_name) base.witness_name = d.witness_name;
  if (d.deposition_date) base.deposition_date = d.deposition_date;
  if (d.volume_number) base.volume_number = d.volume_number;
  if (d.exhibit_number) base.exhibit_number = d.exhibit_number;
  if (d.bates_prefix) base.bates_range = `${d.bates_prefix}${d.bates_start}-${d.bates_prefix}${d.bates_end}`;
  return base;
}

function pluralize(docType) {
  const map = {
    transcript: 'transcripts',
    deposition: 'depositions',
    exhibit: 'exhibits',
    brief: 'briefs',
    expert_report: 'expert_reports',
    contract: 'contracts',
    correspondence: 'correspondence',
    other: 'other',
  };
  return map[docType] || docType;
}

function splitList(s) {
  if (!s || s === true) return null;
  return String(s).split(',').map(x => x.trim()).filter(Boolean);
}

function numOrDefault(v, d) {
  if (v == null || v === true) return d;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function round3(n) {
  if (n == null) return null;
  return Math.round(n * 1000) / 1000;
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[k] = true;
      } else {
        out[k] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function loadEnv(envPath) {
  try {
    const text = await fs.readFile(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  } catch {}
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) die(`Missing env: ${name}`);
  return v;
}

function die(msg) {
  process.stderr.write(`tools: ${msg}\n`);
  process.exit(1);
}
