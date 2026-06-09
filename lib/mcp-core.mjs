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
  {
    name: 'grep',
    description:
      'Exact-match search across every passage in a matter (and its ' +
      'sub-matters), returning every occurrence with page + line ' +
      'coordinates and surrounding context. Unlike `search`, results ' +
      'are in document order (not relevance order) and the result set ' +
      'is the COMPLETE set of matches up to max_matches — `match_count` ' +
      'always reports the true total.\n\n' +
      'Use this for verification work: counting "every occurrence of X," ' +
      'checking whether a specific phrase appears verbatim, validating ' +
      'exact wording, cross-referencing names / dates / dollar amounts ' +
      'across a corpus, age-tag and continuity audits. `search` is for ' +
      'retrieval ("where is the river scene"); `grep` is for verification ' +
      '("does the line read exactly this"). Reach for `grep` whenever you ' +
      'would otherwise want to download the file and run command-line ' +
      'grep on it — this returns the same shape of result without the ' +
      'round-trip.\n\n' +
      'Default mode is case-insensitive literal substring. Pass ' +
      'regex: true for POSIX regex (Postgres ~* operator). Pass ' +
      'case_sensitive: true to require exact case. Scope to one ' +
      'document with `doc: <uuid>` when you know it.',
    inputSchema: {
      type: 'object',
      properties: {
        matter: { type: 'string', description: 'Matter short_code or UUID.' },
        pattern: {
          type: 'string',
          description:
            'What to find. Default mode is literal substring; with ' +
            'regex: true, this is a POSIX regular expression.',
        },
        doc: {
          type: 'string',
          description: 'Optional. Restrict the search to one document UUID.',
        },
        regex: {
          type: 'boolean',
          description:
            'Optional. Treat pattern as a POSIX regex (text ~* pattern) ' +
            'instead of a literal substring. Default false.',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Optional. Default false (case-insensitive).',
        },
        max_matches: {
          type: 'number',
          description:
            'Optional. Cap on returned matches. Default 50, max 500. ' +
            '`match_count` always reports the true total so a result ' +
            'truncated to 50 still tells you how many actual hits there ' +
            'were.',
        },
        context_chars: {
          type: 'number',
          description:
            'Optional. Characters of context before AND after each match. ' +
            'Default 60. Set to 0 if you only need the matches themselves.',
        },
      },
      required: ['matter', 'pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'file_document',
    description:
      'File a document into a Contextspaces matter — the "Save to ' +
      'Contextspaces" action. Stores the file and runs the full ingest ' +
      'pipeline (extract → OCR if the PDF is scanned → chunk → embed) so it ' +
      'becomes searchable with page-accurate citations, under strict ' +
      'per-matter isolation. Name the target matter explicitly (call ' +
      'list_matters first if unsure). Provide the file as text, or as base64 ' +
      'for binary documents (PDF/DOCX). Returns the new document_id and the ' +
      'number of passages indexed.',
    inputSchema: {
      type: 'object',
      properties: {
        matter: {
          type: 'string',
          description: 'Target matter short_code (e.g. "fleming") or UUID. Call list_matters to see options.',
        },
        filename: {
          type: 'string',
          description: 'Filename including extension, e.g. "motion-to-compel.pdf" or "notes.txt". The extension drives extraction.',
        },
        content: {
          type: 'string',
          description: 'The file contents. Plain UTF-8 text by default; set encoding:"base64" for binary files (PDF, DOCX, images).',
        },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64'],
          description: 'How `content` is encoded. Default "utf8". Use "base64" for binary documents.',
        },
        title: {
          type: 'string',
          description: 'Optional display title. Defaults to the filename without its extension.',
        },
        doc_type: {
          type: 'string',
          description: 'Optional doc_type: transcript, deposition, exhibit, brief, expert_report, contract, correspondence, other. Default "other".',
        },
      },
      required: ['matter', 'filename', 'content'],
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
    case 'grep':                 return handleGrep(supabase, args);
    case 'file_document':        return handleFileDocument(supabase, args, opts);
    default:                     throw new Error(`Unknown tool: ${name}`);
  }
}


// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------
export async function handleListMatters(supabase) {
  const { data: matters, error } = await supabase
    .from('matterspaces')
    .select('id, name, short_code, description, serverspace_id, parent_matterspace_id, created_at')
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
      parent_matterspace_id: m.parent_matterspace_id,
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

  // Tree-aware scope: expand the requested matter to itself + every
  // descendant. A search inside "History" then sees passages from
  // "One Hundred years inside quantum mechanics" too.
  const { data: descRows, error: descErr } = await supabase
    .rpc('matterspace_descendants', { p_root: matter.id });
  if (descErr) throw new Error(`matter scope: ${descErr.message}`);
  const matterIds = (descRows ?? []).map((r) => r.id);
  if (matterIds.length === 0) matterIds.push(matter.id);

  const { data, error } = await supabase.rpc('search_passages', {
    p_matterspace_ids: matterIds,
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


export async function handleGrep(supabase, args) {
  if (!args.matter) throw new Error('matter is required');
  if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
    throw new Error('pattern is required and must be a non-empty string');
  }

  const matter = await resolveMatter(supabase, args.matter);
  const useRegex = args.regex === true;
  const caseSensitive = args.case_sensitive === true;
  const maxMatches = Math.min(500, Math.max(1, args.max_matches ?? 50));
  const contextChars = Math.min(500, Math.max(0, args.context_chars ?? 60));

  // Tree-aware scope, same as handleSearch — grep inside "History" sees
  // passages from sub-matters too.
  const { data: descRows, error: descErr } = await supabase
    .rpc('matterspace_descendants', { p_root: matter.id });
  if (descErr) throw new Error(`matter scope: ${descErr.message}`);
  const matterIds = (descRows ?? []).map((r) => r.id);
  if (matterIds.length === 0) matterIds.push(matter.id);

  // SQL filter — Postgres ILIKE / LIKE for literal substring, or the
  // imatch / match regex operators via PostgREST's .filter() syntax.
  // summary_level = 0 means raw passages only, so we don't double-count
  // text that also appears in a summarised rollup.
  let q = supabase
    .from('passages')
    .select('id, document_id, matterspace_id, sequence_number, page_start, line_start, text')
    .in('matterspace_id', matterIds)
    .eq('summary_level', 0)
    .order('document_id', { ascending: true })
    .order('sequence_number', { ascending: true });

  if (args.doc) q = q.eq('document_id', args.doc);

  if (useRegex) {
    q = q.filter('text', caseSensitive ? 'match' : 'imatch', args.pattern);
  } else if (caseSensitive) {
    q = q.like('text', `%${escapeLikePattern(args.pattern)}%`);
  } else {
    q = q.ilike('text', `%${escapeLikePattern(args.pattern)}%`);
  }

  // Cap candidate passages defensively — a pattern that hits 10,000 passages
  // means the user wants `search`, not `grep`. Surface that as a hint.
  const { data: candidates, error } = await q.limit(2000);
  if (error) throw new Error(`grep: ${error.message}`);

  // Bulk-fetch document titles for citation rendering.
  const docIds = [...new Set(candidates.map((p) => p.document_id))];
  const docsById = new Map();
  if (docIds.length > 0) {
    const { data: docs } = await supabase
      .from('documents')
      .select('id, title, doc_type, witness_name, volume_number')
      .in('id', docIds);
    for (const d of docs ?? []) docsById.set(d.id, d);
  }

  // Compile the regex once for per-passage match enumeration.
  let regex = null;
  if (useRegex) {
    try {
      regex = new RegExp(args.pattern, caseSensitive ? 'g' : 'gi');
    } catch (e) {
      throw new Error(`invalid regex: ${e.message}`);
    }
  }
  const literalLower = args.pattern.toLowerCase();

  const matches = [];
  let totalMatchCount = 0;
  for (const p of candidates) {
    const text = p.text || '';
    const positions = [];
    if (regex) {
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(text)) !== null) {
        positions.push({ start: m.index, length: m[0].length });
        // Zero-length matches would loop forever; advance manually.
        if (m[0].length === 0) regex.lastIndex++;
      }
    } else {
      const hay = caseSensitive ? text : text.toLowerCase();
      const needle = caseSensitive ? args.pattern : literalLower;
      let idx = 0;
      while ((idx = hay.indexOf(needle, idx)) !== -1) {
        positions.push({ start: idx, length: needle.length });
        idx += Math.max(1, needle.length);
      }
    }

    for (const pos of positions) {
      totalMatchCount++;
      if (matches.length >= maxMatches) continue;
      const beforeStart = Math.max(0, pos.start - contextChars);
      const afterEnd = Math.min(text.length, pos.start + pos.length + contextChars);
      const lineWithin = countNewlinesBefore(text, pos.start) + 1;
      const absLine = p.line_start != null ? p.line_start + lineWithin - 1 : lineWithin;
      const doc = docsById.get(p.document_id);
      matches.push({
        passage_id: p.id,
        document_id: p.document_id,
        document_title: doc?.title ?? null,
        citation: formatCitation({
          page_start: p.page_start,
          line_start: absLine,
          line_end: absLine,
          witness_name: doc?.witness_name ?? null,
          volume_number: doc?.volume_number ?? null,
          document_title: doc?.title ?? null,
          doc_type: doc?.doc_type ?? null,
        }),
        page: p.page_start,
        line: absLine,
        before: text.slice(beforeStart, pos.start),
        match: text.slice(pos.start, pos.start + pos.length),
        after: text.slice(pos.start + pos.length, afterEnd),
      });
    }
  }

  const candidatesTruncated = candidates.length >= 2000;

  return {
    pattern: args.pattern,
    matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
    mode: useRegex ? 'regex' : 'literal',
    case_sensitive: caseSensitive,
    document_count: docIds.length,
    passage_count: candidates.length,
    match_count: totalMatchCount,
    returned: matches.length,
    truncated: totalMatchCount > matches.length,
    candidates_truncated: candidatesTruncated,
    ...(candidatesTruncated && {
      hint:
        'More than 2000 passages matched at the SQL level — narrow the ' +
        'pattern or scope to a single doc with `doc: <uuid>`. The match ' +
        'set you see only reflects the first 2000 candidate passages.',
    }),
    matches,
  };
}

// LIKE / ILIKE wildcards need escaping in user input so that "100%" doesn't
// become a wildcard. \ is the default LIKE escape char in Postgres.
function escapeLikePattern(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}

// Newline count via charCode is faster than .split('\n').length on long text.
function countNewlinesBefore(text, offset) {
  let n = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
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

// Wrap `fetch` with a hard timeout. supabase-js's fetch has none, so a
// stalled query (stale TCP connection, pooler blip, brief outage) hangs
// forever — the MCP client only gives up after its own multi-minute
// timeout. Aborting at ~Ns turns that into a fast, clear error the caller
// (or Claude) can simply retry.
export function timeoutFetch(ms = 15000, label = 'request') {
  return async (input, init = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(input, { ...init, signal: init.signal ?? ctrl.signal });
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new Error(`${label} timed out after ${ms}ms (possible stale connection — retry)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

const fetchWithTimeout = timeoutFetch;

export async function embedOne(apiKey, text) {
  const res = await fetchWithTimeout(20000, 'openai embeddings')('https://api.openai.com/v1/embeddings', {
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


// -----------------------------------------------------------------------------
// file_document — store a file in a matter and run the full ingest pipeline.
// The user-initiated front door ("Save to Contextspaces"). Heavy deps
// (ingest-core, ocr-gemini) are lazy-imported so the retrieval-only path
// stays light. opts: { openaiApiKey (required), googleApiKey?, userId? }.
// -----------------------------------------------------------------------------
export async function handleFileDocument(supabase, args, opts = {}) {
  if (!args.matter) throw new Error('matter is required');
  if (!args.filename) throw new Error('filename is required');
  if (typeof args.content !== 'string') throw new Error('content (string) is required');
  if (!opts.openaiApiKey) throw new Error('openaiApiKey is required to embed the document');

  const matter = await resolveMatter(supabase, args.matter);

  const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
  const fileBuf = Buffer.from(args.content, encoding);
  if (fileBuf.length === 0) throw new Error('content decoded to 0 bytes');

  const filename = args.filename;
  const ext = '.' + (filename.split('.').pop() || '').toLowerCase();
  const title = args.title || filename.replace(/\.[^.]+$/, '');
  const docType = args.doc_type || 'other';

  // Isolation guard: don't double-file the same bytes/name into one matter.
  const { data: existing } = await supabase
    .from('documents')
    .select('id, processing_status')
    .eq('matterspace_id', matter.id)
    .eq('source_filename', filename)
    .eq('file_size_bytes', fileBuf.length)
    .limit(1);
  if (existing && existing.length) {
    return {
      document_id: existing[0].id,
      matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
      source_filename: filename,
      status: existing[0].processing_status,
      already_filed: true,
      note: 'A document with the same filename and size already exists in this matter; not re-filed.',
    };
  }

  // 1. Create the documents row (mirrors the web upload path in vault-persist).
  let createdBy = opts.userId ?? null;
  if (!createdBy) {
    try { createdBy = (await supabase.auth.getUser()).data.user?.id ?? null; } catch {}
  }
  const { data: doc, error: insErr } = await supabase
    .from('documents')
    .insert({
      matterspace_id: matter.id,
      title,
      doc_type: docType,
      source_filename: filename,
      file_size_bytes: fileBuf.length,
      processing_status: 'pending',
      created_by: createdBy,
    })
    .select('id')
    .single();
  if (insErr) throw new Error(`create document: ${insErr.message}`);

  // 2. Upload bytes to the vault-documents bucket.
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const storagePath = `${matter.id}/${doc.id}/${safeName}`;
  const { error: upErr } = await supabase.storage
    .from('vault-documents')
    .upload(storagePath, fileBuf, { contentType: mimeForExt(ext), upsert: true });
  if (upErr) {
    await supabase.from('documents').delete().eq('id', doc.id); // roll back the stub
    throw new Error(`upload: ${upErr.message}`);
  }
  await supabase.from('documents').update({ storage_path: storagePath }).eq('id', doc.id);

  // 3. Run the ingest pipeline. Wire the Gemini OCR hook when a key is present
  //    so a scanned PDF files with real text + page coordinates rather than
  //    failing as image-only. processDocument marks the row 'ready' itself.
  try {
    const { processDocument } = await import('./ingest-core.mjs');
    let ocr;
    if (opts.googleApiKey && ext === '.pdf') {
      const { ocrPdf } = await import('./ocr-gemini.mjs');
      ocr = (buf) => ocrPdf(buf, { apiKey: opts.googleApiKey });
    }
    const { passageCount } = await processDocument(supabase, {
      documentId: doc.id,
      fileBuf,
      ext,
      openaiApiKey: opts.openaiApiKey,
      ocr,
    });
    return {
      document_id: doc.id,
      matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
      source_filename: filename,
      doc_type: docType,
      passages: passageCount,
      status: 'ready',
    };
  } catch (err) {
    const msg = (err && err.message ? err.message : String(err)).slice(0, 500);
    await supabase
      .from('documents')
      .update({ processing_status: 'error', processing_error: msg })
      .eq('id', doc.id);
    return {
      document_id: doc.id,
      matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
      source_filename: filename,
      status: 'error',
      error: msg,
      note: 'File stored but ingestion failed; it can be retried.',
    };
  }
}

// Minimal extension → MIME map for stored uploads (storage metadata only;
// ingest keys off the extension, not this).
function mimeForExt(ext) {
  const m = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.epub': 'application/epub+zip',
    '.fountain': 'text/plain',
    '.html': 'text/html',
    '.rtf': 'application/rtf',
  };
  return m[ext] || 'application/octet-stream';
}
