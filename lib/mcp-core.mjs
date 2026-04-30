// Shared retrieval logic for the Contextspaces MCP servers.
//
// Two callers import from here:
//   - scripts/mcp-server.mjs      (local stdio server, service-role client)
//   - api/mcp.mjs                 (hosted HTTP server, user-scoped client)
//
// Every handler takes a Supabase client as its first argument so the
// caller chooses the auth scoping. All queries go through the normal
// PostgREST interface — when the client is user-scoped, Postgres RLS
// (migration 002) enforces matter access automatically.

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1024;
const PREVIEW_CHARS = 800;


// -----------------------------------------------------------------------------
// Tool schemas — identical across transports
// -----------------------------------------------------------------------------
export const TOOLS = [
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
      '(transcripts, depositions, briefs, exhibits, contracts, other). ' +
      'Returns metadata such as volume numbers, witnesses, page counts, ' +
      'and Bates ranges. Call this after list_matters to plan retrieval: ' +
      'you will see exactly what transcripts, witnesses, briefs, and ' +
      'exhibits exist before you query the corpus.',
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
      '(vector) similarity with keyword (tsvector) rank. Returns up to ' +
      '`limit` passages (default 5) with formatted citations such as ' +
      '"Peloso Trial Tr. Day 3, p. 42:11-24", raw coordinates, and a ' +
      'text_preview (first ~800 chars of each passage). To see the full ' +
      'text of a specific passage, call get_passage with its passage_id. ' +
      'Supply filters to narrow by doc_types, witnesses, or document_ids. ' +
      'Query text supports websearch_to_tsquery syntax (quoted phrases, ' +
      '-exclusions, OR).\n\n' +
      'Budget discipline: retrieve only what you need for the immediate ' +
      'sentence or paragraph. The corpus persists across turns — you can ' +
      'always search again. Prefer narrow queries with limit: 5 over broad ' +
      'queries with large limits; large result sets flood the context ' +
      'window and leave no room for drafting output.',
    inputSchema: {
      type: 'object',
      properties: {
        matter: { type: 'string', description: 'Matter short_code or UUID.' },
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
          description:
            'Max results to return. Default 5. Only raise above 10 when ' +
            'casting a deliberate wide net — wide searches consume context ' +
            'that you will need for drafting output.',
        },
        full_text: {
          type: 'boolean',
          description:
            'Optional. If true, return the full passage text instead of ' +
            'an 800-char preview. Default false. Prefer the default ' +
            'preview; if you need the full text of a specific result, ' +
            'call get_passage with that passage_id instead.',
        },
      },
      required: ['matter', 'q'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_passage',
    description:
      'Fetch a single passage by its UUID at full text, optionally with ' +
      'surrounding pages of context from the same document. This is the ' +
      'drill-down tool: after search surfaces a promising passage, call ' +
      'get_passage to read the full text before quoting it. Only request ' +
      'context_pages when you specifically need to see what precedes or ' +
      'follows the passage (for out-of-context risk mitigation); otherwise ' +
      'leave context_pages at 0, because context pages pull in every ' +
      'surrounding passage at full text and can easily add 10–30k tokens ' +
      'to the conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Passage UUID.' },
        context_pages: {
          type: 'number',
          description:
            'Optional. Pages of surrounding context. Default 0. Use ' +
            'sparingly; each page adds 2–5 passages at full text.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_outline',
    description:
      'Return a hierarchical outline / summary tree for a document. ' +
      'Useful for understanding the shape of a long transcript or brief ' +
      'before diving in. If no summary tree has been generated yet, ' +
      'returns a flat list of the document\'s raw passages at ' +
      'summary_level 0.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: 'Document UUID.' },
        depth: {
          type: 'number',
          description: 'Optional. Default 2.',
        },
      },
      required: ['doc'],
      additionalProperties: false,
    },
  },
];


// -----------------------------------------------------------------------------
// Dispatcher
// -----------------------------------------------------------------------------
export async function callTool(supabase, name, args = {}, opts = {}) {
  switch (name) {
    case 'list_matters':         return handleListMatters(supabase);
    case 'list_matter_contents': return handleListMatterContents(supabase, args);
    case 'search':               return handleSearch(supabase, args, opts);
    case 'get_passage':          return handleGetPassage(supabase, args);
    case 'get_outline':          return handleGetOutline(supabase, args);
    default:                     throw new Error(`Unknown tool: ${name}`);
  }
}


// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------
export async function handleListMatters(supabase) {
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

export async function handleListMatterContents(supabase, args) {
  if (!args.matter) throw new Error('matter is required');
  const matter = await resolveMatter(supabase, args.matter);
  const { data: docs, error } = await supabase
    .from('documents')
    .select(
      'id, title, doc_type, witness_name, deposition_date, volume_number, ' +
      'exhibit_number, bates_prefix, bates_start, bates_end, page_count, ' +
      'author, publisher, processing_status, created_at'
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

export async function handleSearch(supabase, args, opts = {}) {
  if (!args.matter) throw new Error('matter is required');
  if (!args.q) throw new Error('q is required');
  if (!opts.openaiApiKey) throw new Error('openaiApiKey is required for search');

  const matter = await resolveMatter(supabase, args.matter);
  const queryEmbedding = await embedOne(opts.openaiApiKey, args.q);

  const { data, error } = await supabase.rpc('search_passages', {
    p_matterspace_id: matter.id,
    p_query_text: args.q,
    p_query_embedding: queryEmbedding,
    p_doc_types: args.doc_types ?? null,
    p_witness_names: args.witnesses ?? null,
    p_document_ids: args.document_ids ?? null,
    p_summary_level: 0,
    p_limit: args.limit ?? 5,
  });
  if (error) throw new Error(`search: ${error.message}`);

  const fullText = args.full_text === true;

  return {
    query: args.q,
    matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
    result_count: data.length,
    preview_mode: !fullText,
    results: data.map((r) => {
      const out = {
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
        text_full_length: r.text.length,
        scores: {
          hybrid: round3(r.hybrid_score),
          text_rank: round3(r.text_rank),
          vector: round3(r.vector_score),
        },
      };
      if (fullText || r.text.length <= PREVIEW_CHARS) {
        out.text = r.text;
      } else {
        out.text_preview = r.text.slice(0, PREVIEW_CHARS);
        out.text_truncated = true;
        out.hint = `Call get_passage with id="${r.passage_id}" for the full ${r.text.length}-char passage.`;
      }
      return out;
    }),
  };
}

export async function handleGetPassage(supabase, args) {
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

export async function handleGetOutline(supabase, args) {
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
export async function resolveMatter(supabase, key) {
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

export async function embedOne(apiKey, text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
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

export function formatCitation(row) {
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
  if (docType === 'book') {
    // page_start is the chapter_number (no real pagination in EPUBs).
    // Footnotes carry their own [fn N] marker in the text already.
    return `${docTitle}, Ch. ${page}`;
  }
  return `${docTitle}, p. ${page}${line}`;
}

export function trimDoc(d) {
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
  if (d.author) base.author = d.author;
  if (d.publisher) base.publisher = d.publisher;
  if (d.bates_prefix) {
    base.bates_range = `${d.bates_prefix}${d.bates_start}-${d.bates_prefix}${d.bates_end}`;
  }
  // For books, page_count is chapter count — relabel for clarity.
  if (d.doc_type === 'book') {
    base.chapter_count = d.page_count;
    delete base.page_count;
  }
  return base;
}

export function pluralize(docType) {
  const map = {
    transcript: 'transcripts',
    deposition: 'depositions',
    exhibit: 'exhibits',
    brief: 'briefs',
    expert_report: 'expert_reports',
    contract: 'contracts',
    correspondence: 'correspondence',
    book: 'books',
    other: 'other',
  };
  return map[docType] || docType;
}

export function round3(n) {
  if (n == null) return null;
  return Math.round(n * 1000) / 1000;
}
