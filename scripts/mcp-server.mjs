// Contextspaces MCP server.
//
// Exposes five retrieval tools to MCP-compatible clients (Claude Desktop,
// Claude Code, any other MCP consumer). Runs as a local stdio subprocess;
// the client launches it automatically when the config points at this file.
//
// Tools: list_matters, list_matter_contents, search, get_passage, get_outline.
//
// Env: the server loads ~/context-ai/.env (same path as scripts/tools.mjs)
// and requires VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and
// OPENAI_API_KEY (the last only needed when the `search` tool is called).
//
// Stdout is reserved for JSON-RPC over stdio per the MCP spec. All logging
// and diagnostic output is written to stderr.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
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


// -----------------------------------------------------------------------------
// Tool definitions
// -----------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'list_matters',
    description:
      'List every matter (case / engagement) stored in Contextspaces, with ' +
      'document counts. Call this first in any session to see what matters ' +
      'are available to draw on.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_matter_contents',
    description:
      'Show the documents inside a specific matter, grouped by doc_type ' +
      '(transcripts, depositions, briefs, exhibits, other). Returns metadata ' +
      'such as volume numbers, witnesses, page counts, and Bates ranges. ' +
      'Call this after list_matters to plan retrieval: you will see exactly ' +
      'what transcripts, witnesses, briefs, and exhibits exist before you ' +
      'query the corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        matter: {
          type: 'string',
          description: 'Matter short_code (e.g. "webster") or UUID.',
        },
      },
      required: ['matter'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description:
      'Hybrid search across all passages in a matter, fusing semantic ' +
      '(vector) similarity with keyword (tsvector) rank in one SQL call. ' +
      'Returns up to `limit` passages with formatted citations such as ' +
      '"Peloso Trial Tr. Day 3, p. 42:11-24" and raw coordinates ' +
      '(page_start, page_end, line_start, line_end, witness). Use this as ' +
      'the primary tool when drafting: every result carries a verifiable ' +
      'citation. Supply filters to narrow by doc_types, witnesses, or ' +
      'specific document_ids. The query text supports websearch_to_tsquery ' +
      'syntax — quoted phrases, -exclusions, OR.',
    inputSchema: {
      type: 'object',
      properties: {
        matter: {
          type: 'string',
          description: 'Matter short_code or UUID.',
        },
        q: {
          type: 'string',
          description:
            'Natural-language query describing what to find. Phrases, ' +
            'quoted literals, -exclusions, and OR are supported.',
        },
        doc_types: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional. Restrict to doc_types: transcript, deposition, ' +
            'exhibit, brief, expert_report, contract, correspondence, other.',
        },
        witnesses: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional. Restrict to passages where witness_name matches one ' +
            'of the given names (e.g. ["Peloso", "Ortega"]).',
        },
        document_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional. Restrict to specific document UUIDs.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return. Default 20.',
        },
      },
      required: ['matter', 'q'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_passage',
    description:
      'Fetch a single passage by its UUID, optionally with surrounding ' +
      'pages of context from the same document. Use this after search when ' +
      'you need to confirm a quote in situ or see what precedes / follows a ' +
      'specific exchange — critical for verifying that a citation is not ' +
      'out of context before you put it in a brief.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Passage UUID (taken from a search result).',
        },
        context_pages: {
          type: 'number',
          description:
            'Optional. Number of surrounding pages of the same document to ' +
            'include. Default 0.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_outline',
    description:
      'Return a hierarchical outline / summary tree for a document. Useful ' +
      'for understanding the shape of a long transcript or brief before ' +
      'diving in. If no summary tree has been generated yet, returns a ' +
      'flat list of the document\'s raw passages at summary_level 0.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: {
          type: 'string',
          description: 'Document UUID.',
        },
        depth: {
          type: 'number',
          description:
            'Optional. How deep into the summary tree to walk. Default 2.',
        },
      },
      required: ['doc'],
      additionalProperties: false,
    },
  },
];


// -----------------------------------------------------------------------------
// Server wiring
// -----------------------------------------------------------------------------
const server = new Server(
  { name: 'contextspaces-retrieval', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case 'list_matters':         return asText(await handleListMatters());
      case 'list_matter_contents': return asText(await handleListMatterContents(args));
      case 'search':               return asText(await handleSearch(args));
      case 'get_passage':          return asText(await handleGetPassage(args));
      case 'get_outline':          return asText(await handleGetOutline(args));
      default:                     return asError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return asError(err.message || String(err));
  }
});

function asText(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function asError(msg) {
  return {
    content: [{ type: 'text', text: `ERROR: ${msg}` }],
    isError: true,
  };
}


// -----------------------------------------------------------------------------
// Handlers (mirror scripts/tools.mjs)
// -----------------------------------------------------------------------------
async function handleListMatters() {
  const { data: matters, error } = await supabase
    .from('matterspaces')
    .select('id, name, short_code, description, serverspace_id, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`list_matters: ${error.message}`);

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
  return out;
}

async function handleListMatterContents(args) {
  if (!args.matter) throw new Error('matter is required');
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
  if (error) throw new Error(`list_matter_contents: ${error.message}`);

  const grouped = {};
  for (const d of docs) {
    const bucket = pluralize(d.doc_type);
    grouped[bucket] = grouped[bucket] || [];
    grouped[bucket].push(trimDoc(d));
  }
  return {
    matter: {
      id: matter.id,
      short_code: matter.short_code,
      name: matter.name,
      description: matter.description,
    },
    document_count: docs.length,
    ...grouped,
  };
}

async function handleSearch(args) {
  if (!args.matter) throw new Error('matter is required');
  if (!args.q) throw new Error('q is required');
  const matter = await resolveMatter(args.matter);
  const queryEmbedding = await embedOne(args.q);

  const { data, error } = await supabase.rpc('search_passages', {
    p_matterspace_id: matter.id,
    p_query_text: args.q,
    p_query_embedding: queryEmbedding,
    p_doc_types: args.doc_types ?? null,
    p_witness_names: args.witnesses ?? null,
    p_document_ids: args.document_ids ?? null,
    p_summary_level: 0,
    p_limit: args.limit ?? 20,
  });
  if (error) throw new Error(`search: ${error.message}`);

  return {
    query: args.q,
    matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
    result_count: data.length,
    results: data.map((r) => ({
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
  };
}

async function handleGetPassage(args) {
  if (!args.id) throw new Error('id is required');

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
  if (error) throw new Error(`get_passage: ${error.message}`);

  const { data: doc } = await supabase
    .from('documents')
    .select('id, title, doc_type')
    .eq('id', p.document_id)
    .single();

  let context = null;
  const pagesContext = args.context_pages ?? 0;
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
      .lte('page_end', p.page_end + pagesContext)
      .order('sequence_number', { ascending: true });
    context = ctx;
  }

  return {
    passage: {
      id: p.id,
      citation: formatCitation({
        ...p,
        document_title: doc?.title,
        doc_type: doc?.doc_type,
      }),
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
  };
}

async function handleGetOutline(args) {
  if (!args.doc) throw new Error('doc is required');
  const depth = args.depth ?? 2;

  const { data: doc, error: docErr } = await supabase
    .from('documents')
    .select('id, title, doc_type, page_count, witness_name, volume_number')
    .eq('id', args.doc)
    .single();
  if (docErr) throw new Error(`get_outline: ${docErr.message}`);

  const { data: levels } = await supabase
    .from('passages')
    .select('summary_level')
    .eq('document_id', doc.id);
  const maxLevel = Math.max(0, ...levels.map((r) => r.summary_level));
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

  return {
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
    nodes: nodes.map((n) => ({
      id: n.id,
      summary_level: n.summary_level,
      page_range: [n.page_start, n.page_end],
      text_preview: n.text.slice(0, 400),
      full_text_length: n.text.length,
    })),
  };
}


// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
async function resolveMatter(key) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    const { data, error } = await supabase
      .from('matterspaces')
      .select('id, name, short_code, description, serverspace_id')
      .eq('id', key)
      .single();
    if (error) throw new Error(`resolve matter ${key}: ${error.message}`);
    return data;
  }
  const { data, error } = await supabase
    .from('matterspaces')
    .select('id, name, short_code, description, serverspace_id')
    .eq('short_code', key)
    .maybeSingle();
  if (error) throw new Error(`resolve matter '${key}': ${error.message}`);
  if (!data) throw new Error(`No matterspace with short_code '${key}'.`);
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
    throw new Error(`embed: ${res.status} ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

function formatCitation(row) {
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
  if (d.bates_prefix) {
    base.bates_range = `${d.bates_prefix}${d.bates_start}-${d.bates_prefix}${d.bates_end}`;
  }
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

function round3(n) {
  if (n == null) return null;
  return Math.round(n * 1000) / 1000;
}

async function loadEnv(envPath) {
  try {
    const text = await fs.readFile(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let val = m[2];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  } catch {}
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}


// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('contextspaces MCP server listening on stdio\n');
