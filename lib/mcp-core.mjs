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

import { sealedMatterIds } from './ai-tier-policy.mjs';
import { sealedSearchNote, tierMap } from './seal-pipes.mjs';
import { ROUTES, routeForTier, routeReady } from './embed-routes.mjs';
import { makeOcrProvider, describeOcrRoute } from './ocr-routes.mjs';
// Dependency-free: the accepted-types list, storage cap, and the
// "stored without text" vocabulary shared with the pipeline and the browser.
import { checkUpload, describeTextStatus, describeOcrPending } from './ingest-formats.mjs';

const PREVIEW_CHARS = 800;

// MIME types for media originals. Used three ways: to stamp the correct
// content-type on upload (so signed URLs stream instead of forcing a
// download), to flag media documents in list_matter_contents, and to
// describe what get_media hands back.
const MEDIA_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg', '.mts': 'video/mp2t', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.wma': 'audio/x-ms-wma',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.heic': 'image/heic', '.webp': 'image/webp',
};


// -----------------------------------------------------------------------------
// Tool schemas — identical across transports
// -----------------------------------------------------------------------------
export const TOOLS = [
  {
    name: 'list_matters',
    description:
      'List every matter (case / engagement) stored in Contextspaces, with ' +
      'document counts, each matter\'s serverspace, and its parent matter ' +
      '(if it is a sub-matter/folder). Call this first in any session to ' +
      'see the workspace tree — serverspace → matter → sub-matter — before ' +
      'retrieving, filing, or organizing.',
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
      'Hybrid search across all passages in a matter — or across EVERY ' +
      'matter you can see when `matter` is omitted — fusing semantic ' +
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
        matter: {
          type: 'string',
          description:
            'Optional. Matter short_code or UUID. Omit to search across ' +
            'ALL accessible matters — each result then carries a `matter` ' +
            'field saying where it lives.',
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
      required: ['q'],
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
      'pipeline (extract → OCR if the PDF is scanned → transcribe if ' +
      'audio/video → chunk → embed) so it becomes searchable with ' +
      'page-accurate citations, under strict per-matter isolation. Files too ' +
      'large for immediate processing are automatically queued for the ' +
      'background worker (status "queued" — follow up with ' +
      'check_ingest_status). Containers are unpacked: a .zip archive or a PDF ' +
      'portfolio files each entry as its own document in a folder named after ' +
      'it, and an .eml files its attachments beside the message. Name the ' +
      'target matter explicitly (call list_matters first if unsure). Provide ' +
      'the file as text, or as base64 for binary documents (PDF/DOCX/media/zip). ' +
      'Returns the new document_id and the number of passages indexed.',
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
  {
    name: 'ingest_document',
    description:
      'Queue a document that is ALREADY stored in the Vault for (re)ingestion by the ' +
      'always-on background worker — no size or length limits (huge scanned productions, ' +
      'hour-long recordings). Call this when a document shows status "error" or seems stuck ' +
      '(find it via list_matter_contents or check_ingest_status), or when the user asks to ' +
      'retry or re-import a specific stored document. It queues and returns immediately — ' +
      'the document is NOT searchable yet when this returns; typical documents finish within ' +
      'minutes. Use check_ingest_status to report progress. For adding a NEW file, use ' +
      'file_document instead.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'UUID of the stored document, from list_matter_contents / check_ingest_status / search results.',
        },
      },
      required: ['document_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_ingest_status',
    description:
      'Report document-ingestion status: which documents are still processing, queued for ' +
      'the background worker, or errored — with progress notes and error reasons. Call this ' +
      'when the user asks whether an upload or import has finished, why a document is not ' +
      'searchable yet, or to follow up after ingest_document. Pass document_id for one ' +
      'document, or matter for a matter-wide report.',
    inputSchema: {
      type: 'object',
      properties: {
        matter: {
          type: 'string',
          description: 'Matter short_code or UUID for a matter-wide report.',
        },
        document_id: {
          type: 'string',
          description: 'UUID of one document to check (takes precedence over matter).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_media',
    description:
      'Get a short-lived HTTPS streaming URL for the ORIGINAL stored file ' +
      'behind a document — video, audio, image, or the as-filed PDF/DOCX. ' +
      'Contextspaces DOES support media access this way: when the user asks ' +
      'you to watch, review, or analyze a video or recording stored in ' +
      'Contextspaces, call this tool and fetch the returned stream_url ' +
      'yourself. The URL supports HTTP Range requests, so you can stream, ' +
      'seek, or download directly. Do not ask the user for a local file ' +
      'path before trying this tool. CAVEAT: some sandboxed environments ' +
      'block outbound fetches to this storage host (e.g. HTTP 403 with ' +
      'x-deny-reason: host_not_allowed from an egress proxy). If your fetch ' +
      'is blocked, do NOT retry repeatedly and do NOT tell the user the ' +
      'media does not exist — the URL is valid: give it to the user as a ' +
      'clickable link (it works in their browser), accept a manual upload ' +
      'as the fallback, and for combining stored PDFs use ' +
      'assemble_documents, which merges server-side with no fetch needed. ' +
      'Find the document UUID first via list_matter_contents (media ' +
      'documents carry source_filename and media_kind fields) or search. ' +
      'The URL expires after expires_in seconds (default 900); simply call ' +
      'again for a fresh link.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description:
            'Document UUID, from list_matter_contents, search, or ' +
            'check_ingest_status.',
        },
        expires_in: {
          type: 'number',
          description:
            'Optional. URL lifetime in seconds, clamped to 60–3600. ' +
            'Default 900.',
        },
      },
      required: ['document_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_matter_state',
    description:
      'Read a matter\'s ledger state: status (active | urgent | waiting | ' +
      'dormant | archived), headline (one-line "where things stand"), ' +
      'next_action (+ owner), the next and overdue deadlines derived from ' +
      'the matter calendar, and the most recent ledger events. This is the ' +
      'same state layer the Knowledge Map renders — call it to orient on a ' +
      'matter before working in it.',
    inputSchema: {
      type: 'object',
      properties: {
        matter: { type: 'string', description: 'Matter short_code or UUID.' },
      },
      required: ['matter'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_matter_state',
    description:
      'Update a matter\'s ledger state and/or append a note. Supply only ' +
      'the fields you mean to change; pass an empty string to clear a text ' +
      'field. Every change is recorded as an append-only ledger event ' +
      '(attributed to "agent"), which the Knowledge Map renders live and a ' +
      'future Briefing Engine diffs against — so after substantive work on ' +
      'a matter, keep the ledger true: update the headline and next_action ' +
      'to reflect the new state of play. Deadlines are NOT set here — file ' +
      'those in the matter calendar (they are derived automatically).',
    inputSchema: {
      type: 'object',
      properties: {
        matter: { type: 'string', description: 'Matter short_code or UUID.' },
        status: {
          type: 'string',
          enum: ['active', 'urgent', 'waiting', 'dormant', 'archived'],
          description: 'Optional new status.',
        },
        headline: {
          type: 'string',
          description:
            'Optional one-line state of play, e.g. "Horski deposition 7/31 ' +
            '— outline in progress". Empty string clears.',
        },
        next_action: {
          type: 'string',
          description: 'Optional next concrete step. Empty string clears.',
        },
        next_action_owner: {
          type: 'string',
          description: 'Optional owner of the next step ("you", "agent", or a name).',
        },
        waiting_on: {
          type: 'string',
          description:
            'Optional: whose court the ball is in (a client, opposing ' +
            'counsel, a vendor). Empty string clears.',
        },
        note: {
          type: 'string',
          description:
            'Optional free-text note appended to the ledger log (does not ' +
            'change state fields).',
        },
      },
      required: ['matter'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_matter',
    description:
      'Create a new matter, sub-matter, or folder in Contextspaces. These ' +
      'are all the same container type: a "folder" inside a matter is ' +
      'simply a sub-matter — pass `parent` to nest inside an existing ' +
      'matter, or `serverspace` (by name, e.g. "Admin", or UUID) to create ' +
      'top-level. Call list_matters first to see the serverspaces and ' +
      'matters that already exist. Returns the new matter\'s short_code — ' +
      'use it as the `matter` argument of file_document, move_document, or ' +
      'search to work inside the new container. Only create a container ' +
      'when the user asks for a new one; to file into an existing matter, ' +
      'go straight to file_document or move_document.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Display name, e.g. "Engagement Letters".',
        },
        serverspace: {
          type: 'string',
          description:
            'Serverspace name or UUID for a TOP-LEVEL matter (names are ' +
            'shown by list_matters). Omit when passing parent.',
        },
        parent: {
          type: 'string',
          description:
            'Parent matter short_code or UUID — makes this a ' +
            'sub-matter/folder inside that matter. The serverspace is ' +
            'inherited from the parent.',
        },
        short_code: {
          type: 'string',
          description:
            'Optional URL slug (lowercase letters/digits/_/-, must start ' +
            'with a letter, globally unique). Auto-generated from name if ' +
            'omitted.',
        },
        description: {
          type: 'string',
          description: 'Optional description of the matter.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_document',
    description:
      'Move one or more documents that are ALREADY stored in Contextspaces ' +
      'into a different matter, sub-matter, or folder — the "put these ' +
      'drafts in that folder" action. Documents move intact: passages, ' +
      'page-accurate citations, and the stored original all follow. Get ' +
      'document UUIDs from list_matter_contents or search; name the ' +
      'destination by short_code or UUID (create it first with ' +
      'create_matter if it does not exist yet). For adding a NEW file, use ' +
      'file_document instead.',
    inputSchema: {
      type: 'object',
      properties: {
        document_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'UUIDs of the documents to move.',
        },
        to_matter: {
          type: 'string',
          description: 'Destination matter short_code or UUID.',
        },
      },
      required: ['document_ids', 'to_matter'],
      additionalProperties: false,
    },
  },
  {
    name: 'copy_document',
    description:
      'Copy one or more stored documents into another matter, sub-matter, ' +
      'or folder — the ORIGINALS STAY exactly where they are. Use this ' +
      'instead of move_document whenever the source should remain filed in ' +
      'its matter (working copies, staging material in the Sandbox). The ' +
      'copy includes the stored original file and the searchable passages, ' +
      'so it is immediately usable. Duplicate-safe: if the target already ' +
      'holds a copy with the same filename and size, that copy is returned ' +
      'rather than duplicated.',
    inputSchema: {
      type: 'object',
      properties: {
        document_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'UUIDs of the documents to copy.',
        },
        to_matter: {
          type: 'string',
          description: 'Destination matter short_code or UUID.',
        },
      },
      required: ['document_ids', 'to_matter'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_to_sandbox',
    description:
      'Copy documents into the user\'s Sandbox — the scratch workspace of ' +
      'the AI Workbench, for combining exhibits into one PDF, drafting, ' +
      'and other working-copy tasks. Each account has ONE Sandbox ' +
      '(a serverspace named "Sandbox"), subdivided into one mini-box ' +
      '(matter) per source matter so materials from different matters ' +
      'never mix. This tool does the whole flow: it creates the Sandbox ' +
      'and the right mini-box if they do not exist yet, then COPIES the ' +
      'documents in — originals stay filed where they are. Returns each ' +
      'mini-box\'s short_code; use it as the `matter` argument of ' +
      'assemble_documents, search, or file_document to work on the copies.',
    inputSchema: {
      type: 'object',
      properties: {
        document_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'UUIDs of the documents to stage in the Sandbox.',
        },
      },
      required: ['document_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'assemble_documents',
    description:
      'Merge two or more stored PDF documents from ONE matter into a single ' +
      'PDF, server-side, and file the result back into that matter. Use this ' +
      'whenever the user wants documents combined — exhibits into a filing, ' +
      'a compilation for service or production — instead of downloading the ' +
      'originals and merging them yourself: the merge happens next to the ' +
      'storage, so it works even when your environment cannot fetch ' +
      'stream_urls. Documents merge in the order given in document_ids. ' +
      'Returns the new document id, an exhibit manifest mapping each source ' +
      'to its page range in the merged PDF, and a short-lived download_url ' +
      'to give the user. PDFs only; sources must all belong to the target ' +
      'matter (send_to_sandbox or copy_document can stage cross-matter ' +
      'sources into one Sandbox box first).',
    inputSchema: {
      type: 'object',
      properties: {
        matter: {
          type: 'string',
          description: 'Matter short_code, id, or name — the matter the sources live in and the merged PDF is filed into.',
        },
        document_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          description: 'Document UUIDs to merge, in the exact order they should appear.',
        },
        filename: {
          type: 'string',
          description: 'Filename for the merged PDF (should end in .pdf). Default "assembled.pdf".',
        },
        title: {
          type: 'string',
          description: 'Optional display title for the merged document. Defaults to the filename without extension.',
        },
        doc_type: {
          type: 'string',
          description: 'Optional doc_type for the merged document (e.g. "exhibit"). Default "other".',
        },
      },
      required: ['matter', 'document_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_pdf',
    description:
      'Light PDF editing on a stored document: keep, reorder, delete, and ' +
      'rotate pages — saving the result as a NEW document in the same ' +
      'matter (the original is untouched). `pages` lists the OUTPUT pages ' +
      'in order using 1-based numbers and ranges, e.g. "3,1-2,5" = source ' +
      'page 3 first, then 1, 2, 5; omit it to keep every page (useful with ' +
      'rotate alone). Combine with assemble_documents for merge workflows: ' +
      'edit the copies first, then merge them. Returns the new document ' +
      'and a short-lived download_url.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'UUID of the stored PDF to edit.',
        },
        pages: {
          type: 'string',
          description:
            'Output pages in order, 1-based, e.g. "3,1-2,5" or "1-4,8". ' +
            'Pages not listed are dropped. Omit to keep all pages.',
        },
        rotate: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pages: { type: 'string', description: 'Which SOURCE pages to rotate, e.g. "2" or "1-3". Use "all" for every page.' },
              degrees: { type: 'number', enum: [90, 180, 270], description: 'Clockwise rotation added to the page.' },
            },
            required: ['pages', 'degrees'],
            additionalProperties: false,
          },
          description: 'Optional rotations applied before page selection.',
        },
        filename: {
          type: 'string',
          description: 'Filename for the edited PDF. Default "<original>-edited.pdf".',
        },
        title: {
          type: 'string',
          description: 'Optional display title. Defaults to the filename without extension.',
        },
      },
      required: ['document_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_deck',
    description:
      'Create a PowerPoint (.pptx) deck and file it into a matter, with a ' +
      'short-lived download_url. YOU author the content: retrieve material ' +
      'with search / get_passage / grep first, then pass finished slides. ' +
      'A cover slide is added automatically from title/subtitle. Each ' +
      'slide supports a title, short bullets (strings, or {text, indent} ' +
      'for sub-bullets), a table, a native editable chart (bar, line, pie, ' +
      'doughnut — up to 8 series, platform colors), and speaker notes. ' +
      'Keep bullets under ~12 words; put prose and citations in notes.',
    inputSchema: {
      type: 'object',
      properties: {
        matter: {
          type: 'string',
          description: 'Matter short_code or UUID to file the deck into (a Sandbox box is a natural home).',
        },
        title: { type: 'string', description: 'Deck title — becomes the cover slide.' },
        subtitle: { type: 'string', description: 'Optional cover subtitle (e.g. matter name and date).' },
        filename: { type: 'string', description: 'Filename ending in .pptx. Default derived from title.' },
        accent: { type: 'string', description: 'Optional accent color as 6-digit hex without "#". Default E8B84A.' },
        slides: {
          type: 'array',
          minItems: 1,
          description: 'Content slides, in order (cover slide not included here).',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              bullets: {
                type: 'array',
                items: {
                  anyOf: [
                    { type: 'string' },
                    {
                      type: 'object',
                      properties: {
                        text: { type: 'string' },
                        indent: { type: 'number', description: '0 = top level, 1-4 = nested.' },
                      },
                      required: ['text'],
                      additionalProperties: false,
                    },
                  ],
                },
              },
              table: {
                type: 'object',
                properties: {
                  headers: { type: 'array', items: { type: 'string' } },
                  rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                },
                required: ['headers', 'rows'],
                additionalProperties: false,
              },
              chart: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut'] },
                  title: { type: 'string' },
                  categories: { type: 'array', items: { type: 'string' } },
                  series: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        values: { type: 'array', items: { type: 'number' } },
                      },
                      required: ['name', 'values'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['type', 'categories', 'series'],
                additionalProperties: false,
              },
              notes: { type: 'string', description: 'Speaker notes — the right place for prose and citations.' },
            },
            additionalProperties: false,
          },
        },
      },
      required: ['matter', 'title', 'slides'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_chart',
    description:
      'Render a chart (bar, line, pie, doughnut) as a crisp SVG image ' +
      'filed into a matter, with a short-lived download_url. YOU supply ' +
      'the data — extract it from stored documents first (grep / search). ' +
      'Colors, axes, legend, and labels follow the platform chart style; ' +
      'up to 8 series or slices (fold the rest into "Other"). For a chart ' +
      'INSIDE a presentation, use create_deck with a chart slide instead.',
    inputSchema: {
      type: 'object',
      properties: {
        matter: { type: 'string', description: 'Matter short_code or UUID to file the chart into.' },
        title: { type: 'string', description: 'Chart title, drawn on the image.' },
        type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut'] },
        categories: { type: 'array', items: { type: 'string' }, description: 'Category labels (x-axis, or slice names).' },
        series: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              values: { type: 'array', items: { type: 'number' }, description: 'One value per category.' },
            },
            required: ['name', 'values'],
            additionalProperties: false,
          },
          description: 'Data series. Pie/doughnut take exactly one.',
        },
        y_label: { type: 'string', description: 'Optional y-axis label (bar/line).' },
        x_label: { type: 'string', description: 'Optional x-axis label (bar/line).' },
        filename: { type: 'string', description: 'Filename ending in .svg. Default derived from title.' },
      },
      required: ['matter', 'type', 'categories', 'series'],
      additionalProperties: false,
    },
  },
];


// -----------------------------------------------------------------------------
// Dispatcher
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// The SecureSpace seal (2026-08-22)
// -----------------------------------------------------------------------------
// A matter whose effective tier is B (sealed) or C (silo) must never reach
// an EXTERNAL connector — Claude Desktop / claude.ai / ChatGPT through
// api/mcp.mjs, or the local stdio server. Those callers pass
// `opts.sealConnector = true` and get:
//   - list_matters            → sealed matters are omitted (invisible);
//   - search with no matter   → sealed matters are excluded from the scope;
//   - any tool keyed by a matter, a document, or a passage that lives in a
//     sealed matter → refused with a plain explanation.
// The in-app Assistant does NOT set the flag: it governs itself by routing
// a sealed matter to a sealed pen (lib/assistant-core.mjs), which is the
// whole point of sealing — the work goes on, inside the room.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEAL_MATTER_ARGS = ['matter', 'to_matter', 'parent'];
const SEAL_DOC_ARGS = ['document_id', 'doc'];
const SEAL_DOC_LIST_ARGS = ['document_ids'];

export class SealedMatterError extends Error {
  constructor(what) {
    super(
      `${what} is in a sealed matter (SecureSpace) and is not available through ` +
      'external connectors. Open it in Contextspaces, where it is served by the sealed pen.',
    );
    this.code = 'sealed_matter';
  }
}

/**
 * Refuse a connector call that would touch a sealed matter. Returns the
 * sealed id set so the dispatcher can also filter listings and scopes.
 */
export async function enforceConnectorSeal(supabase, name, args = {}) {
  const sealed = await sealedMatterIds(supabase);
  if (sealed.size === 0) return sealed;

  for (const key of SEAL_MATTER_ARGS) {
    const v = args[key];
    if (typeof v !== 'string' || !v) continue;
    const m = await resolveMatter(supabase, v);
    if (sealed.has(m.id)) throw new SealedMatterError(`Matter "${m.name}"`);
  }

  const docIds = [];
  for (const key of SEAL_DOC_ARGS) {
    const v = args[key];
    if (typeof v === 'string' && UUID_RE.test(v)) docIds.push(v);
  }
  for (const key of SEAL_DOC_LIST_ARGS) {
    const v = args[key];
    if (!Array.isArray(v)) continue;
    for (const d of v) if (typeof d === 'string' && UUID_RE.test(d)) docIds.push(d);
  }
  if (docIds.length) {
    const { data, error } = await supabase
      .from('documents').select('id, matterspace_id').in('id', docIds);
    if (error) throw new Error(`seal check: ${error.message}`);
    for (const d of data ?? []) {
      if (sealed.has(d.matterspace_id)) throw new SealedMatterError('That document');
    }
  }

  if (name === 'get_passage' && typeof args.id === 'string' && UUID_RE.test(args.id)) {
    const { data, error } = await supabase
      .from('passages').select('matterspace_id').eq('id', args.id).maybeSingle();
    if (error) throw new Error(`seal check: ${error.message}`);
    if (data && sealed.has(data.matterspace_id)) throw new SealedMatterError('That passage');
  }

  return sealed;
}

export async function callTool(supabase, name, args = {}, opts = {}) {
  if (opts.sealConnector) {
    const sealed = await enforceConnectorSeal(supabase, name, args);
    if (sealed.size > 0) {
      const out = await dispatchTool(supabase, name, args, { ...opts, excludeMatterIds: sealed });
      if (name === 'list_matters' && Array.isArray(out)) {
        return out.filter((m) => !sealed.has(m.id));
      }
      return out;
    }
  }
  return dispatchTool(supabase, name, args, opts);
}

async function dispatchTool(supabase, name, args = {}, opts = {}) {
  switch (name) {
    case 'list_matters':         return handleListMatters(supabase);
    case 'list_matter_contents': return handleListMatterContents(supabase, args);
    case 'search':               return handleSearch(supabase, args, opts);
    case 'get_passage':          return handleGetPassage(supabase, args);
    case 'get_outline':          return handleGetOutline(supabase, args);
    case 'grep':                 return handleGrep(supabase, args);
    case 'file_document':        return handleFileDocument(supabase, args, opts);
    case 'ingest_document':      return handleIngestDocument(supabase, args);
    case 'check_ingest_status':  return handleCheckIngestStatus(supabase, args);
    case 'get_media':            return handleGetMedia(supabase, args);
    case 'get_matter_state':     return handleGetMatterState(supabase, args);
    case 'set_matter_state':     return handleSetMatterState(supabase, args, opts);
    case 'create_matter':        return handleCreateMatter(supabase, args);
    case 'move_document':        return handleMoveDocument(supabase, args);
    case 'copy_document':        return handleCopyDocument(supabase, args, opts);
    case 'send_to_sandbox':      return handleSendToSandbox(supabase, args, opts);
    case 'assemble_documents':   return handleAssembleDocuments(supabase, args, opts);
    case 'edit_pdf':             return handleEditPdf(supabase, args, opts);
    case 'create_deck':          return handleCreateDeck(supabase, args, opts);
    case 'create_chart':         return handleCreateChart(supabase, args, opts);
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

  // Serverspace names let agents route requests phrased as "in my Admin
  // serverspace" (create_matter / move_document) without a separate tool.
  const { data: spaces } = await supabase.from('serverspaces').select('id, name');
  const spaceById = new Map((spaces ?? []).map((s) => [s.id, s]));

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
      serverspace: spaceById.get(m.serverspace_id) ?? { id: m.serverspace_id },
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
      'author, publisher, processing_status, created_at, source_filename'
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
  if (!args.q) throw new Error('q is required');
  // The key is checked where it is used, not here: a search whose scope is
  // entirely sealed never embeds anything, so it must not be blocked by the
  // absence of a key it is forbidden to use.

  // Scope: one matter + its descendants — or, when matter is omitted,
  // every matterspace the caller can see (RLS decides), for app-wide
  // search from the Vault search box and "search everywhere" agent asks.
  let matter = null;
  let matterIds = [];
  if (args.matter) {
    matter = await resolveMatter(supabase, args.matter);
    // Tree-aware scope: expand the requested matter to itself + every
    // descendant. A search inside "History" then sees passages from
    // "One Hundred years inside quantum mechanics" too.
    const { data: descRows, error: descErr } = await supabase
      .rpc('matterspace_descendants', { p_root: matter.id });
    if (descErr) throw new Error(`matter scope: ${descErr.message}`);
    matterIds = (descRows ?? []).map((r) => r.id);
    if (matterIds.length === 0) matterIds.push(matter.id);
  } else {
    const { data: allMatters, error: allErr } = await supabase
      .from('matterspaces')
      .select('id');
    if (allErr) throw new Error(`matter scope: ${allErr.message}`);
    // The SecureSpace seal: an external connector never searches a sealed
    // matter, even "everywhere" (opts.excludeMatterIds from callTool).
    const exclude = opts.excludeMatterIds;
    matterIds = (allMatters ?? []).map((r) => r.id)
      .filter((id) => !(exclude && exclude.has(id)));
    if (matterIds.length === 0) {
      return { query: args.q, scope: 'all_matters', result_count: 0, results: [] };
    }
  }

  // The SecureSpace seal on the search pipe (lib/seal-pipes.mjs). Embedding the
  // query means posting it to OpenAI, so a scope that is entirely sealed is
  // searched WITHOUT an embedding: migration 056's stage B is pure Postgres
  // full-text and needs no network at all (Fleming, 100k passages: 99 ms). The
  // matter still answers — on words rather than on meaning — and says so.
  //
  // Mixed scopes (an app-wide search across sealed and unsealed matters) split:
  // the unsealed group is searched normally, the sealed group text-only. The
  // query still reaches OpenAI on behalf of the unsealed group, exactly as it
  // would have if the user had scoped the search to those matters by hand —
  // what the seal guarantees is that no sealed matter's content or index takes
  // part in it. Tighten this to "any sealed matter in scope ⇒ no embedding at
  // all" if the query text itself is ever deemed privileged.
  // Group the scope by the embedding route each matter's tier permits, not by
  // sealed-or-not. Usually that is one group. It becomes more than one when a
  // sealed matter has a zero-retention route of its own, and the two groups
  // then hold vectors in genuinely different spaces — so each is queried with
  // an embedding made by ITS model and told which model to filter stage A on.
  // Crossing those wires is the bug migration 061 exists to prevent.
  const tiers = await tierMap(supabase, matterIds);
  const byRoute = new Map();
  for (const id of matterIds) {
    const route = routeForTier(tiers.get(id));
    const k = route?.id ?? '__none__';
    if (!byRoute.has(k)) byRoute.set(k, { route, ids: [] });
    byRoute.get(k).ids.push(id);
  }

  const limit = args.limit ?? 5;

  // The embedding and the model name travel together, always. A group with no
  // route sends null for both halves of that pair, and search_passages then
  // skips stage A entirely and answers on full text.
  const rpcParams = (ids, embedding, model) => ({
    p_matterspace_ids: ids,
    p_query_text: args.q,
    p_query_embedding: embedding,
    p_doc_types: args.doc_types ?? null,
    p_witness_names: args.witnesses ?? null,
    p_document_ids: args.document_ids ?? null,
    p_summary_level: 0,
    p_limit: limit,
    ...(model ? { p_embedding_model: model } : {}),
  });

  // One query embedding per distinct route, computed once and shared by that
  // route's batches. A route that is not fully configured embeds nothing
  // rather than falling back — the pen's rule, applied to retrieval.
  //
  // A route that IS configured but fails at call time (endpoint stopped, key
  // revoked, provider outage) degrades that group to text-only WITH A NOTE
  // instead of failing the whole search. This is a read path: partial results
  // that say what is missing beat an error, and it is also what lets the
  // Voyage SageMaker endpoint be stopped when idle — searches over sealed
  // matters keep answering on words until it is up again.
  const groups = [];
  let embedFailNote = null;
  // Matters searched text-only BY POLICY — no route for their tier, or a
  // route whose credentials are not in place. Distinct from a call-time
  // failure (embedFailNote): policy is the steady state the seal explains,
  // an outage is news.
  let policyTextOnly = 0;
  for (const { route, ids } of byRoute.values()) {
    if (!route) {
      policyTextOnly += ids.length;
      groups.push({ ids, embedding: null, model: null });
      continue;
    }
    // The MCP caller's own OpenAI key still stands in for the environment's,
    // exactly as before the seal work.
    const env = route.provider === 'openai' && opts.openaiApiKey
      ? { ...process.env, [route.keyEnv]: opts.openaiApiKey }
      : process.env;
    if (!routeReady(route, env)) {
      // Refuse to guess. Text search still covers these matters completely.
      policyTextOnly += ids.length;
      groups.push({ ids, embedding: null, model: null });
      continue;
    }
    try {
      groups.push({
        ids,
        embedding: await embedOne(env[route.keyEnv], args.q, route),
        model: route.model,
      });
    } catch (err) {
      groups.push({ ids, embedding: null, model: null });
      embedFailNote =
        `The ${route.model} embedding step failed (${String(err.message).slice(0, 120)}), so ` +
        `${ids.length} matter(s) were searched by full text only for this query. ` +
        'Exact words and phrases rank normally; a paraphrase may not surface.';
    }
  }
  const sealedNote = policyTextOnly
    ? sealedSearchNote(policyTextOnly, matterIds.length)
    : null;

  let data;
  let partialNote = null;
  if (matter) {
    const settled = await Promise.all(
      groups.map((g) => supabase.rpc('search_passages', rpcParams(g.ids, g.embedding, g.model)))
    );
    const failed = settled.find((r) => r.error);
    if (failed) throw new Error(`search: ${failed.error.message}`);
    // Merging a text-only group with an embedded one ranks the text-only hits
    // lower by construction: their vector_score is 0, so their hybrid score is
    // the text half alone. That is a real limitation of a mixed tree in Phase
    // A, not a scoring bug — the note tells the reader which half is which,
    // and Phase B removes the asymmetry by giving the sealed group a sealed
    // embedding of its own.
    data = settled.length === 1
      ? settled[0].data ?? []
      : settled
        .flatMap((r) => r.data ?? [])
        .sort((a, b) => (b.hybrid_score ?? 0) - (a.hybrid_score ?? 0))
        .slice(0, limit);
  } else {
    // One RPC over every matter at once exceeds the Postgres statement
    // timeout on large corpora. Fan out in matter batches, run them in
    // parallel, and merge the per-batch top hits by hybrid score.
    const BATCH = 12;
    const batches = [];
    for (const g of groups) {
      for (let i = 0; i < g.ids.length; i += BATCH) {
        batches.push({ ids: g.ids.slice(i, i + BATCH), embedding: g.embedding, model: g.model });
      }
    }
    const settled = await Promise.all(
      batches.map((b) => supabase.rpc('search_passages', rpcParams(b.ids, b.embedding, b.model)))
    );
    const failed = settled.filter((r) => r.error);
    data = settled
      .flatMap((r) => r.data ?? [])
      .sort((a, b) => (b.hybrid_score ?? 0) - (a.hybrid_score ?? 0))
      .slice(0, limit);
    if (failed.length > 0) {
      // Report what actually went wrong. Calling every RPC failure a timeout
      // hid the shape of the 2026-08-22 search bug for weeks: the batches were
      // timing out, but so would a permission error, a schema drift, or a bad
      // embedding dimension, and all four read as "timed out and were skipped".
      const reasons = [...new Set(failed.map((r) => (
        r.error?.code === '57014'
          ? 'statement timeout — the scope is too large for one query'
          : `${r.error?.code ? r.error.code + ': ' : ''}${r.error?.message ?? String(r.error)}`.slice(0, 160)
      )))];
      partialNote =
        `${failed.length} of ${batches.length} matter groups failed and were skipped ` +
        `(${reasons.join(' · ')}) — results cover the rest. Re-run, or scope to a ` +
        'specific matter for full coverage there.';
    }
  }

  const fullText = args.full_text === true;

  // Global searches name each result's matter so the caller can route.
  let matterByDoc = new Map();
  if (!matter && data.length) {
    const docIds = [...new Set(data.map((r) => r.document_id))];
    const { data: docRows } = await supabase
      .from('documents').select('id, matterspace_id').in('id', docIds);
    const mIds = [...new Set((docRows ?? []).map((d) => d.matterspace_id))];
    const { data: mRows } = await supabase
      .from('matterspaces').select('id, short_code, name').in('id', mIds);
    const mById = new Map((mRows ?? []).map((m) => [m.id, m]));
    matterByDoc = new Map((docRows ?? []).map((d) => [d.id, mById.get(d.matterspace_id)]));
  }

  return {
    query: args.q,
    matter: matter
      ? { id: matter.id, short_code: matter.short_code, name: matter.name }
      : null,
    scope: matter ? 'matter_tree' : 'all_matters',
    result_count: data.length,
    preview_mode: !fullText,
    // All three notes can apply at once, and a caller that only ever reads
    // `note` must not have any one explanation silently displace the others.
    ...((partialNote || sealedNote || embedFailNote)
      ? { note: [sealedNote, embedFailNote, partialNote].filter(Boolean).join(' ') }
      : {}),
    ...(sealedNote ? { sealed_text_only: true } : {}),
    results: data.map((r) => {
      const rMatter = matterByDoc.get(r.document_id);
      const out = {
        ...(rMatter ? { matter: { id: rMatter.id, short_code: rMatter.short_code, name: rMatter.name } } : {}),
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

// Embed one query. The route decides the endpoint, the model and the wire
// format (lib/embed-routes.mjs); it defaults to Tier A's so every existing
// caller is unchanged. The vector this returns is only ever compared against
// passages stamped with the SAME route's model — see migration 061.
// inputType 'query': routes with asymmetric encoding (Voyage) embed queries
// differently from documents, into the same space, for better retrieval.
export async function embedOne(apiKey, text, route = ROUTES['openai-3-small']) {
  const req = route.buildRequest
    ? route.buildRequest([text], { inputType: 'query' })
    : {
      url: route.url,
      headers: route.headers(apiKey),
      body: JSON.stringify(route.body([text])),
    };
  const res = await fetchWithTimeout(20000, `${route.provider} embeddings`)(req.url, {
    method: 'POST',
    headers: req.headers,
    body: req.body,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embed: ${res.status} ${body.slice(0, 400)}`);
  }
  const [embedding] = route.parse(await res.json());
  return embedding;
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
  // Media originals are discoverable by filename so agents can locate "the
  // extraction video" and pass its id to get_media. Text docs skip these
  // fields to keep large listings lean.
  if (d.source_filename) {
    const ext = '.' + d.source_filename.split('.').pop().toLowerCase();
    const mime = MEDIA_MIME[ext];
    if (mime && !mime.startsWith('image/')) {
      base.source_filename = d.source_filename;
      base.media_kind = mime.split('/')[0];
    }
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
// get_media — short-lived streaming URL for a document's stored original.
// The document row is fetched through the caller's client, so RLS decides
// visibility; the signed URL is minted with that same client and inherits
// the same authority. Supabase Storage serves signed URLs with HTTP Range
// support. Fetchable by agents with open egress (Claude Code, Antigravity,
// browsers) — but NOT from claude.ai's hosted sandbox, whose egress proxy
// 403s this host (2026-08 field report). The tool description tells models
// to hand the link to the user when blocked; assemble_documents covers the
// merge-PDFs case entirely server-side.
// -----------------------------------------------------------------------------
export async function handleGetMedia(supabase, args) {
  if (!args.document_id) throw new Error('document_id is required');

  const { data: doc, error } = await supabase
    .from('documents')
    .select('id, title, doc_type, source_filename, storage_path, file_size_bytes')
    .eq('id', args.document_id)
    .maybeSingle();
  if (error) throw new Error(`get_media: ${error.message}`);
  if (!doc) {
    throw new Error('get_media: document not found (or not accessible to this account)');
  }
  if (!doc.storage_path) {
    throw new Error(
      'get_media: this document has no stored original file — it was ingested ' +
      'as text only. Only documents filed with their binary can be streamed.'
    );
  }

  const expires = Math.min(Math.max(Math.trunc(args.expires_in ?? 900), 60), 3600);
  const { data: signed, error: signErr } = await supabase.storage
    .from('vault-documents')
    .createSignedUrl(doc.storage_path, expires);
  if (signErr) throw new Error(`get_media: sign url: ${signErr.message}`);

  const name = doc.source_filename || doc.storage_path;
  const ext = '.' + (name.split('.').pop() || '').toLowerCase();
  const mime = MEDIA_MIME[ext] || mimeForExt(ext);
  const kind = mime.startsWith('video/') ? 'video'
    : mime.startsWith('audio/') ? 'audio'
    : mime.startsWith('image/') ? 'image'
    : 'document';

  return {
    document_id: doc.id,
    title: doc.title,
    source_filename: doc.source_filename,
    media_kind: kind,
    mime_type: mime,
    file_size_bytes: doc.file_size_bytes,
    stream_url: signed.signedUrl,
    expires_in_seconds: expires,
    note:
      'Fetch this URL directly to stream or download the file. It supports ' +
      'HTTP Range requests, so players can seek without downloading the ' +
      'whole file. The link expires; call get_media again for a fresh one. ' +
      'If your environment blocks the fetch (403 host_not_allowed from an ' +
      'egress proxy), the URL is still valid — give it to the user as a ' +
      'clickable link instead of retrying, and use assemble_documents for ' +
      'server-side PDF merging.',
  };
}


// -----------------------------------------------------------------------------
// Matter State Ledger (migration 042). get_matter_state assembles the same
// picture the Knowledge Map renders: ledger fields + calendar-derived
// deadlines + recent ledger events. set_matter_state routes edits through
// the set_matter_state RPC so every change leaves an append-only
// matter_state_events row — never write matter_state directly.
// -----------------------------------------------------------------------------
export async function handleGetMatterState(supabase, args) {
  if (!args.matter) throw new Error('matter is required');
  const matter = await resolveMatter(supabase, args.matter);

  const { data: state, error: stErr } = await supabase
    .from('matter_state')
    .select('*')
    .eq('matterspace_id', matter.id)
    .maybeSingle();
  if (stErr) throw new Error(`get_matter_state: ${stErr.message}`);

  const { data: openEvents, error: dlErr } = await supabase
    .from('matter_events')
    .select('title, event_date, event_type')
    .eq('matterspace_id', matter.id)
    .is('completed_at', null)
    .order('event_date', { ascending: true })
    .limit(20);
  if (dlErr) throw new Error(`get_matter_state: deadlines: ${dlErr.message}`);

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = (openEvents ?? []).filter((e) => e.event_date >= today);
  const overdue = (openEvents ?? []).filter((e) => e.event_date < today);

  const { data: ledger, error: evErr } = await supabase
    .from('matter_state_events')
    .select('event_type, payload, created_at')
    .eq('matterspace_id', matter.id)
    .order('created_at', { ascending: false })
    .limit(10);
  if (evErr) throw new Error(`get_matter_state: ledger: ${evErr.message}`);

  return {
    matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
    state: state ?? {
      status: 'active',
      headline: null,
      next_action: null,
      next_action_owner: null,
      note: 'No ledger row yet — defaults shown. set_matter_state creates one.',
    },
    next_deadline: upcoming[0] ?? null,
    upcoming_deadlines: upcoming,
    overdue_deadlines: overdue,
    recent_ledger_events: ledger ?? [],
  };
}

export async function handleSetMatterState(supabase, args, opts = {}) {
  if (!args.matter) throw new Error('matter is required');
  const hasEdit =
    args.status !== undefined ||
    args.headline !== undefined ||
    args.next_action !== undefined ||
    args.next_action_owner !== undefined ||
    args.waiting_on !== undefined;
  if (!hasEdit && !args.note) {
    throw new Error(
      'Provide at least one of status / headline / next_action / ' +
      'next_action_owner / waiting_on, or a note.'
    );
  }
  const matter = await resolveMatter(supabase, args.matter);

  let state = null;
  if (hasEdit) {
    // Only supplied fields are sent, so the call works against both the
    // 042 and 043 RPC signatures (042 predates p_waiting_on).
    const rpcArgs = { p_matter: matter.id, p_updated_by: 'agent' };
    if (args.status !== undefined) rpcArgs.p_status = args.status;
    if (args.headline !== undefined) rpcArgs.p_headline = args.headline;
    if (args.next_action !== undefined) rpcArgs.p_next_action = args.next_action;
    if (args.next_action_owner !== undefined) rpcArgs.p_next_action_owner = args.next_action_owner;
    if (args.waiting_on !== undefined) rpcArgs.p_waiting_on = args.waiting_on;
    const { data, error } = await supabase.rpc('set_matter_state', rpcArgs);
    if (error) throw new Error(`set_matter_state: ${error.message}`);
    state = data;
  }

  if (args.note) {
    const { error } = await supabase.from('matter_state_events').insert({
      matterspace_id: matter.id,
      event_type: 'note',
      payload: { text: args.note, source: 'mcp' },
      actor_id: opts.userId ?? null,
    });
    if (error) throw new Error(`set_matter_state: note: ${error.message}`);
  }

  return {
    matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
    state,
    note_logged: Boolean(args.note),
  };
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

  // Refuse before any bytes move — the same three checks the web Vault makes
  // at selection time (Phase 1 of the ingestion plan, 2026-09-04): size over
  // the bucket cap, an extension the pipeline cannot read, and a duplicate.
  // A .zip is accepted here too since Phase 3 (2026-09-04): it is queued for
  // the worker, which unpacks it into a folder and files each entry.
  const refusal = checkUpload({ name: filename, size: fileBuf.length });
  if (refusal) throw new Error(refusal.message);

  // Isolation guard: don't double-file the same bytes/name into one matter.
  // Refused, not silently linked (Eden's decision, 2026-09-04) — and the
  // answer names the copy that already exists so the caller can find it.
  // Only a copy whose bytes landed counts (storage_path set): a row left by
  // an upload that never finished must not block the re-upload.
  const { data: existing } = await supabase
    .from('documents')
    .select('id, title, processing_status, created_at')
    .eq('matterspace_id', matter.id)
    .eq('source_filename', filename)
    .eq('file_size_bytes', fileBuf.length)
    .not('storage_path', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1);
  if (existing && existing.length) {
    const dup = existing[0];
    const when = dup.created_at ? new Date(dup.created_at).toISOString().slice(0, 10) : 'an earlier date';
    return {
      document_id: dup.id,
      matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
      source_filename: filename,
      status: dup.processing_status,
      already_filed: true,
      note: `Already filed as "${dup.title || filename}" on ${when} (same filename and size in this matter); ` +
        'not re-filed. Use that document, or delete it first to replace it.',
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

  // 3. Run the ingest pipeline — or queue it. Files the serverless budget
  //    can't finish (big scans, long recordings, .wma needing ffmpeg) go to
  //    the always-on worker; everything else processes inline right here.
  const { processDocument, planPdfOcr, needsWorkerIngest, MEDIA_EXTENSIONS, OCRABLE_IMAGE_EXTENSIONS } = await import('./ingest-core.mjs');
  if (needsWorkerIngest(ext, fileBuf.length)) {
    const { job_id } = await enqueueIngestJob(supabase, { id: doc.id, matterspace_id: matter.id });
    return {
      document_id: doc.id,
      matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
      source_filename: filename,
      doc_type: docType,
      status: 'queued',
      job_id,
      note: ext === '.zip'
        ? 'Archive — stored and queued for the background worker, which unpacks it into a folder named after ' +
          'it and files each entry as its own document (Phase 3). Not searchable yet; use check_ingest_status ' +
          'on this document_id to see the children and their progress.'
        : 'Large file — stored and queued for the background worker (no time limit). ' +
          'Not searchable yet; use check_ingest_status to follow progress. ' +
          'Typical documents finish within minutes.',
    };
  }
  //    A PDF with scanned pages goes to the worker too (Phase 2, 2026-09-04):
  //    OCR has no business inside a 60 s function, whatever the file size.
  //    planPdfOcr reads the text layer once to decide; a born-digital PDF
  //    stays inline.
  if (ext === '.pdf') {
    const plan = await planPdfOcr(fileBuf);
    if (plan.ocrPages.length) {
      const { job_id } = await enqueueIngestJob(supabase, { id: doc.id, matterspace_id: matter.id });
      return {
        document_id: doc.id,
        matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
        source_filename: filename,
        doc_type: docType,
        status: 'queued',
        job_id,
        page_count: plan.pageCount,
        ocr_pages: plan.ocrPages.length,
        note: `${plan.ocrPages.length} of ${plan.pageCount} page(s) have no text layer and need OCR — stored and queued ` +
          'for the background worker, which OCRs with no time limit. Not searchable yet; use check_ingest_status ' +
          'to follow progress. Typical scans finish within minutes.',
      };
    }
  }

  //    Wire the hooks: OCR through the tier's routes (lib/ocr-routes.mjs —
  //    Gemini/Anthropic outside a SecureSpace, Textract inside, Phase 4) so a
  //    scanned PDF files with real text + page coordinates; Gemini
  //    transcription so audio/video files as a timestamped transcript.
  //    processDocument marks the row 'ready'.
  try {
    let ocr;
    let transcribe;
    if (ext === '.pdf' || OCRABLE_IMAGE_EXTENSIONS.includes(ext)) {
      ocr = makeOcrProvider({ ...process.env, ...(opts.googleApiKey ? { GOOGLE_API_KEY: opts.googleApiKey } : {}) });
    }
    if (opts.googleApiKey && MEDIA_EXTENSIONS.includes(ext)) {
      const { transcribeMedia, mimeForMediaExt } = await import('./transcribe-gemini.mjs');
      const mimeType = mimeForMediaExt(ext);
      if (mimeType) {
        transcribe = (buf, { kind }) => transcribeMedia(buf, { apiKey: opts.googleApiKey, mimeType, kind });
      }
    }
    const { passageCount, textStatus, ocrPending, ocr_route: ocrRoute, email_attachments: emailAttachments } = await processDocument(supabase, {
      documentId: doc.id,
      fileBuf,
      ext,
      openaiApiKey: opts.openaiApiKey,
      ocr,
      transcribe,
    });
    // Zero passages is a real outcome with a recorded reason, and the caller
    // must hear it: "ready" alone let an image-only exhibit read as indexed.
    // Pages still awaiting OCR are reported the same way — searchable for the
    // typed pages, with the scanned ones named.
    let stored = {};
    if (textStatus) {
      const d = describeTextStatus(textStatus);
      stored = { text_status: textStatus, searchable: false, note: `${d.label}. ${d.detail}` };
    }
    if (ocrPending) {
      const d = describeOcrPending(ocrPending);
      stored = { ...stored, ocr_pending: ocrPending, searchable: passageCount > 0, note: `${d.label}. ${d.detail}` };
    }
    // Which route read the scanned pages and roughly what it cost (Phase 4):
    // the Anthropic route is 5–15× the Gemini rate per page, so the number
    // is said out loud rather than discovered on an invoice.
    if (ocrRoute && typeof ocrRoute === 'object') {
      stored = { ...stored, ocr_route: ocrRoute, ocr_note: describeOcrRoute(ocrRoute) };
    }
    // An email's attachments were filed beside it (Phase 3): name them, each
    // queued for its own ingest, so the caller can follow them.
    let attachmentsNote = {};
    if (emailAttachments && typeof emailAttachments === 'object') {
      const kids = emailAttachments.children || [];
      attachmentsNote = {
        attachments: kids.map((c) => ({ document_id: c.id, title: c.title, filename: c.filename })),
        attachments_note: kids.length
          ? `${kids.length} attachment(s) filed beside this email and queued for ingest — use check_ingest_status on each document_id.`
          : `Attachments were not filed${emailAttachments.notes?.length ? ` (${emailAttachments.notes[0]})` : ''}.`,
      };
    }
    return {
      document_id: doc.id,
      matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
      source_filename: filename,
      doc_type: docType,
      passages: passageCount,
      status: 'ready',
      ...stored,
      ...attachmentsNote,
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

// -----------------------------------------------------------------------------
// ingest_document / check_ingest_status — the worker-queue surface
// -----------------------------------------------------------------------------

// Enqueue one ingest_document job, deduping against jobs already in flight.
// Used by handleIngestDocument and by handleFileDocument's heavy-file routing.
// RLS note: runs on whatever client the caller holds — user-scoped clients can
// only enqueue into matters they can access (migration 032).
async function enqueueIngestJob(supabase, doc) {
  const { data: existing } = await supabase.from('processing_jobs')
    .select('id, status, progress, progress_note')
    .eq('job_type', 'ingest_document')
    .in('status', ['queued', 'running'])
    .contains('payload', { document_id: doc.id })
    .limit(1);
  if (existing && existing.length) {
    return { job_id: existing[0].id, deduped: true, job: existing[0] };
  }
  const { data: job, error } = await supabase.from('processing_jobs').insert({
    matterspace_id: doc.matterspace_id,
    job_type: 'ingest_document',
    payload: { document_id: doc.id },
  }).select('id').single();
  if (error) throw new Error(`enqueue: ${error.message}`);
  await supabase.from('documents')
    .update({ processing_status: 'pending', processing_error: null })
    .eq('id', doc.id);
  return { job_id: job.id, deduped: false };
}

export async function handleIngestDocument(supabase, args) {
  if (!args.document_id) throw new Error('document_id is required');
  const { data: doc, error } = await supabase.from('documents')
    .select('id, matterspace_id, source_filename, processing_status, storage_path, text_status:metadata->>text_status, ocr_pending:metadata->ocr_pending')
    .eq('id', args.document_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!doc) throw new Error('document not found or no access');
  if (!doc.storage_path) throw new Error('document has no stored file to ingest');
  // 'ready' with a recorded text_status is stored-without-text, and 'ready'
  // with ocr_pending still owes OCR on some pages; a re-run is exactly what a
  // caller wants for either — only a ready document that is fully indexed
  // has nothing to do.
  if (doc.processing_status === 'ready' && !doc.text_status && !doc.ocr_pending) {
    return {
      document_id: doc.id,
      source_filename: doc.source_filename,
      status: 'ready',
      note: 'Already ingested and searchable — nothing to do.',
    };
  }
  const { job_id, deduped } = await enqueueIngestJob(supabase, doc);
  return {
    document_id: doc.id,
    source_filename: doc.source_filename,
    status: 'queued',
    job_id,
    ...(deduped ? { note: 'Already in the queue; not enqueued twice.' } : {}),
    next: 'The background worker will process it with no time limit. Call check_ingest_status to see progress; typical documents are searchable within a few minutes.',
  };
}

// For a container's row (metadata.archive / .portfolio / .email_attachments,
// written by the pipeline when it filed the children), the children with
// their current status. → { container: { kind, folder_id, folder_name,
// children: [{ document_id, title, status, searchable }] }, note } or null.
async function describeContainerChildren(supabase, metadata) {
  const kinds = [['archive', 'zip archive'], ['portfolio', 'PDF portfolio'], ['email_attachments', 'email']];
  const hit = kinds.find(([key]) => metadata?.[key] && typeof metadata[key] === 'object');
  if (!hit) return null;
  const [key, label] = hit;
  const summary = metadata[key];
  const ids = (summary.children || []).map((c) => c.id).filter(Boolean);
  let rows = [];
  if (ids.length) {
    const { data } = await supabase.from('documents')
      .select('id, title, processing_status, text_status:metadata->>text_status')
      .in('id', ids);
    rows = data || [];
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = (summary.children || []).map((c) => {
    const r = byId.get(c.id);
    return {
      document_id: c.id,
      title: c.title,
      status: r ? r.processing_status : 'deleted',
      searchable: Boolean(r && r.processing_status === 'ready' && !r.text_status),
    };
  });
  const ready = children.filter((c) => c.searchable).length;
  const skipped = Array.isArray(summary.skipped) ? summary.skipped.length : 0;
  const note = key === 'email_attachments'
    ? `${children.length} attachment(s) filed beside this email; ${ready} searchable so far.`
    : `This ${label} was unpacked: ${children.length} document(s) filed` +
      (summary.folder_name ? ` in the folder "${summary.folder_name}"` : '') +
      `; ${ready} searchable so far` + (skipped ? `; ${skipped} entr${skipped === 1 ? 'y' : 'ies'} skipped` : '') + '.';
  return {
    container: { kind: key === 'email_attachments' ? 'eml' : key === 'archive' ? 'zip' : 'portfolio', folder_id: summary.folder_id ?? null, folder_name: summary.folder_name ?? null, children },
    container_note: note,
  };
}

export async function handleCheckIngestStatus(supabase, args) {
  // Single-document report.
  if (args.document_id) {
    const { data: doc, error } = await supabase.from('documents')
      .select('id, source_filename, processing_status, processing_error, page_count, metadata')
      .eq('id', args.document_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!doc) throw new Error('document not found or no access');
    // A ready document with a recorded text_status is stored on purpose and
    // not searchable; say so in words rather than leaving "ready" to imply
    // "indexed".
    const textStatus = doc.processing_status === 'ready' ? doc.metadata?.text_status : null;
    let storedNote = {};
    if (textStatus) {
      const d = describeTextStatus(textStatus);
      storedNote = { text_status: textStatus, searchable: false, note: `${d.label}. ${d.detail}` };
    }
    // Pages still awaiting OCR (Phase 2): the typed pages are searchable, the
    // scanned ones are named with the reason and the retry state — or, when
    // nothing has been read yet, the same record explains the text_status.
    const ocrPending = doc.processing_status === 'ready' ? doc.metadata?.ocr_pending : null;
    if (ocrPending && typeof ocrPending === 'object') {
      const d = describeOcrPending(ocrPending);
      storedNote = { ...storedNote, ocr_pending: ocrPending, searchable: !textStatus, note: `${d.label}. ${d.detail}` };
    }
    // Which route read the scanned pages, and roughly what it cost (Phase 4).
    const ocrRoute = doc.processing_status === 'ready' ? doc.metadata?.ocr_route : null;
    if (ocrRoute && typeof ocrRoute === 'object') {
      storedNote = { ...storedNote, ocr_route: ocrRoute, ocr_note: describeOcrRoute(ocrRoute) };
    }
    // A container (Phase 3): the children are the documents to search. Name
    // them, with their own status, so the caller follows them rather than
    // the wrapper.
    const containerNote = doc.processing_status === 'ready' ? await describeContainerChildren(supabase, doc.metadata) : null;
    const { data: jobs } = await supabase.from('processing_jobs')
      .select('id, status, progress, progress_note, error, created_at')
      .eq('job_type', 'ingest_document')
      .contains('payload', { document_id: doc.id })
      .order('created_at', { ascending: false })
      .limit(1);
    const job = jobs?.[0] ?? null;
    return {
      document_id: doc.id,
      source_filename: doc.source_filename,
      status: doc.processing_status,
      ...(containerNote || {}),
      // A ready document must not display a leftover failure from an earlier
      // attempt the pipeline recovered from — pair the error with the status
      // it belongs to.
      ...(doc.processing_error && doc.processing_status !== 'ready'
        ? { error: doc.processing_error }
        : {}),
      ...(doc.processing_status === 'ready' ? { page_count: doc.page_count } : {}),
      ...storedNote,
      ...(job ? { job: jobSummary(job) } : {}),
    };
  }

  // Matter-wide report.
  if (!args.matter) throw new Error('matter or document_id is required');
  const matter = await resolveMatter(supabase, args.matter);

  const { count: readyCount } = await supabase.from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('matterspace_id', matter.id)
    .eq('processing_status', 'ready');
  // True count of everything not ready, independent of the sample below. The
  // listing has always been capped, but the cap was invisible: a matter with
  // 388 failures reported 30 of them and read as survivable. Counting
  // separately means the totals tell the truth even when the listing is
  // truncated.
  const SAMPLE = 30;
  const { count: notReadyCount } = await supabase.from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('matterspace_id', matter.id)
    .neq('processing_status', 'ready');
  const { data: notReady } = await supabase.from('documents')
    .select('id, source_filename, processing_status, processing_error, created_at')
    .eq('matterspace_id', matter.id)
    .neq('processing_status', 'ready')
    .order('created_at', { ascending: false })
    .limit(SAMPLE);
  const { data: activeJobs } = await supabase.from('processing_jobs')
    .select('id, job_type, status, progress, progress_note, created_at')
    .eq('matterspace_id', matter.id)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(10);

  const sample = notReady ?? [];
  const truncated = (notReadyCount ?? 0) > sample.length;

  // Classify the sample so the caller gets "12 are rate-limit retries, 3 need
  // OCR" instead of a wall of raw provider errors.
  const { summarize } = await import('./ingest-triage.mjs');
  const errorRows = sample.filter((d) => d.processing_status === 'error');
  const triage = summarize(errorRows.map((d) => ({ name: d.source_filename, error: d.processing_error })));

  return {
    matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
    ready: readyCount ?? 0,
    not_ready_total: notReadyCount ?? 0,
    still_processing: sample.filter((d) => d.processing_status !== 'error').map(docSummary),
    errors: errorRows.map(docSummary),
    ...(truncated ? {
      listing_truncated: `Showing ${sample.length} of ${notReadyCount} not-ready documents. ` +
        'Counts above are complete; the listing is a sample.',
    } : {}),
    ...(triage.groups.length ? {
      failure_summary: triage.groups.map((g) => ({
        problem: g.label, count_in_sample: g.count, severity: g.severity, what_to_do: g.action,
      })),
    } : {}),
    active_jobs: (activeJobs ?? []).map(jobSummary),
    ...(staleQueueNote(activeJobs) ? { note: staleQueueNote(activeJobs) } : {}),
  };
}

function docSummary(d) {
  return {
    document_id: d.id,
    source_filename: d.source_filename,
    status: d.processing_status,
    ...(d.processing_error ? { error: d.processing_error.slice(0, 200) } : {}),
  };
}

function jobSummary(j) {
  return {
    status: j.status,
    progress: j.progress,
    ...(j.progress_note ? { doing: j.progress_note } : {}),
    ...(j.error ? { error: j.error.slice(0, 200) } : {}),
  };
}

// Queued jobs that nothing has claimed for a while usually mean the worker
// isn't running — say so instead of letting the model promise progress.
function staleQueueNote(jobs) {
  const oldest = (jobs ?? []).filter((j) => j.status === 'queued')
    .map((j) => Date.now() - new Date(j.created_at).getTime())
    .sort((a, b) => b - a)[0];
  if (oldest > 3 * 60 * 1000) {
    return 'Queued jobs have been waiting over 3 minutes — the background worker may not be running. The work will start as soon as it is.';
  }
  return null;
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
    '.svg': 'image/svg+xml',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return m[ext] || MEDIA_MIME[ext] || 'application/octet-stream';
}


// -----------------------------------------------------------------------------
// create_matter / move_document — workspace organization.
//
// Matters, sub-matters, and "folders" are one container type (matterspaces
// rows); nesting is parent_matterspace_id, and a child always lives in its
// parent's serverspace (DB trigger, migration 008). On the hosted server
// these run through the user-scoped client, so RLS decides authority:
// creating requires owner/admin of the serverspace (migration 022), moving
// requires member+ of both source and destination (migration 005).
// -----------------------------------------------------------------------------

// Same slug rules as the web app's NewMatterModal.
function slugifyShortCode(s) {
  let out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (out && !/^[a-z]/.test(out)) out = 'm-' + out;
  return (out || 'matter').slice(0, 64);
}

export async function resolveServerspace(supabase, key) {
  const { data: spaces, error } = await supabase
    .from('serverspaces')
    .select('id, name')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`resolve serverspace: ${error.message}`);
  const all = spaces ?? [];

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    const hit = all.find((s) => s.id === key);
    if (hit) return hit;
    throw new Error(`No serverspace with id ${key} (or not accessible to this account).`);
  }

  const want = key.trim().toLowerCase();
  const names = all.map((s) => `"${s.name}"`).join(', ') || '(none visible)';
  const exact = all.filter((s) => (s.name || '').trim().toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`Serverspace name "${key}" matches more than one — pass its UUID instead.`);
  }
  const partial = all.filter((s) => (s.name || '').toLowerCase().includes(want));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`Serverspace "${key}" is ambiguous. Visible serverspaces: ${names}.`);
  }
  throw new Error(`No serverspace named "${key}". Visible serverspaces: ${names}.`);
}

export async function handleCreateMatter(supabase, args) {
  const name = (args.name || '').trim();
  if (!name) throw new Error('create_matter: name is required');

  // A parent pins the serverspace (the DB trigger requires the child to
  // live in its parent's serverspace); otherwise the caller names one.
  let parent = null;
  if (args.parent) parent = await resolveMatter(supabase, args.parent);

  let serverspace;
  if (parent) {
    const { data: ss, error } = await supabase
      .from('serverspaces')
      .select('id, name')
      .eq('id', parent.serverspace_id)
      .single();
    if (error) throw new Error(`create_matter: load parent serverspace: ${error.message}`);
    serverspace = ss;
    if (args.serverspace) {
      const named = await resolveServerspace(supabase, args.serverspace);
      if (named.id !== serverspace.id) {
        throw new Error(
          `create_matter: parent "${parent.short_code || parent.id}" lives in serverspace ` +
          `"${serverspace.name}", not "${named.name}" — a sub-matter always inherits its ` +
          'parent\'s serverspace. Omit serverspace, or pick a different parent.'
        );
      }
    }
  } else if (args.serverspace) {
    serverspace = await resolveServerspace(supabase, args.serverspace);
  } else {
    throw new Error(
      'create_matter: pass serverspace (name or UUID) for a top-level matter, ' +
      'or parent (matter short_code/UUID) for a sub-matter/folder. ' +
      'Call list_matters to see both.'
    );
  }

  const explicit = typeof args.short_code === 'string' && args.short_code.trim() !== '';
  const base = explicit ? args.short_code.trim() : slugifyShortCode(name);
  if (explicit && !/^[a-z][a-z0-9_-]{0,63}$/.test(base)) {
    throw new Error(
      'create_matter: short_code must be lowercase letters/digits/_/-, ' +
      'start with a letter, max 64 chars'
    );
  }

  // short_code is globally unique; auto-generated slugs retry with a
  // numeric suffix on collision, explicit ones fail loudly.
  const attempts = explicit
    ? [base]
    : [base, ...[2, 3, 4, 5].map((n) => `${base.slice(0, 61)}-${n}`)];
  let lastErr = null;
  for (const code of attempts) {
    const { data, error } = await supabase
      .from('matterspaces')
      .insert({
        serverspace_id: serverspace.id,
        parent_matterspace_id: parent ? parent.id : null,
        name,
        short_code: code,
        description: (args.description || '').trim() || null,
      })
      .select('id, short_code, name, description, parent_matterspace_id')
      .single();
    if (!error) {
      return {
        matter: data,
        serverspace: { id: serverspace.id, name: serverspace.name },
        ...(parent ? { parent: { id: parent.id, short_code: parent.short_code, name: parent.name } } : {}),
        note:
          `Created. Use matter: "${data.short_code}" in file_document, ` +
          'move_document, or search to work inside it.',
      };
    }
    lastErr = error;
    const dup = error.code === '23505' || /duplicate/i.test(error.message || '');
    if (dup && explicit) {
      throw new Error(`create_matter: short_code "${code}" is already taken — pick another or omit short_code.`);
    }
    if (!dup) break;
  }
  if (lastErr && /row-level security/i.test(lastErr.message || '')) {
    throw new Error(
      `create_matter: not permitted — creating here requires owner/admin ` +
      `rights on serverspace "${serverspace.name}".`
    );
  }
  throw new Error(`create_matter: ${lastErr ? lastErr.message : 'insert failed'}`);
}

export async function handleMoveDocument(supabase, args) {
  const ids = Array.isArray(args.document_ids) ? args.document_ids : [];
  if (ids.length === 0) throw new Error('move_document: document_ids (array of at least 1 UUID) is required');
  if (!args.to_matter) throw new Error('move_document: to_matter is required');

  const target = await resolveMatter(supabase, args.to_matter);

  const { data: rows, error } = await supabase
    .from('documents')
    .select('id, title, matterspace_id, storage_path, source_filename')
    .in('id', ids);
  if (error) throw new Error(`move_document: ${error.message}`);
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new Error(
      `move_document: not found (or not accessible): ${missing.join(', ')}. ` +
      'Use document UUIDs from list_matter_contents or search.'
    );
  }

  // Source-matter names for the report back to the user.
  const fromIds = [...new Set((rows ?? []).map((r) => r.matterspace_id))];
  const { data: fromMatters } = await supabase
    .from('matterspaces')
    .select('id, short_code, name')
    .in('id', fromIds);
  const fromById = new Map((fromMatters ?? []).map((m) => [m.id, m]));

  const moved = [];
  const alreadyThere = [];
  for (const id of ids) {
    const doc = byId.get(id);

    // Move the document row first, then sync the denormalized
    // matterspace_id on its passages — search/grep scope by
    // passages.matterspace_id, so the two must agree. Passages sync runs
    // even for a doc already in the target, which makes a re-run after a
    // partial failure self-healing.
    if (doc.matterspace_id !== target.id) {
      // Storage RLS scopes objects by their first path segment (the matter
      // id — convention {matterspace_id}/{document_id}/{filename}), so the
      // stored original must follow the document. Rename first; roll the
      // rename back if the row update then fails.
      let newPath = null;
      if (doc.storage_path) {
        const filename = doc.storage_path.split('/').slice(2).join('/') || (doc.source_filename ?? 'file');
        newPath = `${target.id}/${doc.id}/${filename}`;
        const { error: mvErr } = await supabase.storage
          .from('vault-documents')
          .move(doc.storage_path, newPath);
        if (mvErr) throw new Error(`move_document: storage move of "${doc.title}": ${mvErr.message}`);
      }
      const { data: upd, error: updErr } = await supabase
        .from('documents')
        .update({
          matterspace_id: target.id,
          ...(newPath ? { storage_path: newPath } : {}),
        })
        .eq('id', id)
        .select('id');
      if (updErr || !upd || upd.length === 0) {
        if (newPath) {
          try { await supabase.storage.from('vault-documents').move(newPath, doc.storage_path); } catch { /* best effort */ }
        }
        if (updErr) throw new Error(`move_document: "${doc.title}": ${updErr.message}`);
        throw new Error(
          `move_document: "${doc.title}": not permitted — moving requires ` +
          'member rights in both the source and destination matters.'
        );
      }
    }
    const { error: pasErr } = await supabase
      .from('passages')
      .update({ matterspace_id: target.id })
      .eq('document_id', id)
      .neq('matterspace_id', target.id);
    if (pasErr) throw new Error(`move_document: passages of "${doc.title}": ${pasErr.message}`);

    const from = fromById.get(doc.matterspace_id);
    if (doc.matterspace_id === target.id) {
      alreadyThere.push({ document_id: id, title: doc.title });
    } else {
      moved.push({
        document_id: id,
        title: doc.title,
        ...(from ? { from: { id: from.id, short_code: from.short_code, name: from.name } } : {}),
      });
    }
  }

  // Keep any queued/running ingest jobs pointed at the new matter so the
  // worker stamps fresh passages with the right scope. Best-effort.
  try {
    await supabase
      .from('processing_jobs')
      .update({ matterspace_id: target.id })
      .eq('job_type', 'ingest_document')
      .in('status', ['queued', 'running'])
      .in('payload->>document_id', ids);
  } catch { /* non-fatal */ }

  return {
    to: { id: target.id, short_code: target.short_code, name: target.name },
    moved,
    ...(alreadyThere.length ? { already_there: alreadyThere } : {}),
    note: moved.length
      ? 'Documents moved with their passages, citations, and stored originals intact.'
      : 'Nothing needed moving — the documents were already in the target matter.',
  };
}


// -----------------------------------------------------------------------------
// copy_document / send_to_sandbox — working copies and the Sandbox.
//
// The Sandbox is the AI Workbench's scratch workspace: one serverspace
// named "Sandbox" per account, subdivided into one mini-box (matter) per
// source matter so materials from different matters never mix. Everything
// that enters is a COPY — originals stay filed in their matters.
// -----------------------------------------------------------------------------

const SANDBOX_SERVERSPACE_NAME = 'Sandbox';

// Fields that must NOT be carried over when duplicating rows. Selecting *
// and stripping keeps the copy resilient to later added metadata columns.
const COPY_STRIP_DOC = ['id', 'matterspace_id', 'storage_path', 'created_by', 'created_at', 'updated_at'];
// text_length and tsv are generated columns; parent_passage_id points into
// the summary tree, which is regenerable and whose ids don't survive a copy.
const COPY_STRIP_PASSAGE = ['id', 'document_id', 'matterspace_id', 'text_length', 'tsv', 'parent_passage_id', 'created_at'];

// The acting user: explicit opts.userId (service-role/stdio callers) or the
// JWT behind the client (hosted server, app API routes).
async function resolveCallerId(supabase, opts = {}) {
  if (opts.userId) return opts.userId;
  try { return (await supabase.auth.getUser()).data.user?.id ?? null; } catch { return null; }
}

export async function handleCopyDocument(supabase, args, opts = {}) {
  const ids = Array.isArray(args.document_ids) ? args.document_ids : [];
  if (ids.length === 0) throw new Error('copy_document: document_ids (array of at least 1 UUID) is required');
  if (!args.to_matter) throw new Error('copy_document: to_matter is required');

  const target = await resolveMatter(supabase, args.to_matter);
  const createdBy = await resolveCallerId(supabase, opts);

  const copies = [];
  for (const id of ids) {
    const { data: src, error } = await supabase
      .from('documents').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`copy_document: ${error.message}`);
    if (!src) throw new Error(`copy_document: document ${id} not found (or not accessible)`);
    if (src.matterspace_id === target.id) {
      copies.push({ document_id: id, title: src.title, note: 'already in the target matter; not copied' });
      continue;
    }

    // Duplicate-safe, mirroring file_document's guard.
    if (src.source_filename != null) {
      const { data: existing } = await supabase
        .from('documents')
        .select('id, title')
        .eq('matterspace_id', target.id)
        .eq('source_filename', src.source_filename)
        .eq('file_size_bytes', src.file_size_bytes)
        .limit(1);
      if (existing && existing.length) {
        copies.push({ document_id: existing[0].id, title: existing[0].title, copied_from: id, already_copied: true });
        continue;
      }
    }

    const row = { ...src };
    for (const k of COPY_STRIP_DOC) delete row[k];
    row.matterspace_id = target.id;
    if (createdBy) row.created_by = createdBy;
    const { data: newDoc, error: insErr } = await supabase
      .from('documents').insert(row).select('id, title').single();
    if (insErr) throw new Error(`copy_document: "${src.title}": ${insErr.message}`);

    // Copy the stored original under the target matter's storage folder —
    // storage RLS scopes access by the first path segment (matter id).
    if (src.storage_path) {
      const filename = src.storage_path.split('/').slice(2).join('/') || (src.source_filename ?? 'file');
      const newPath = `${target.id}/${newDoc.id}/${filename}`;
      const { error: cpErr } = await supabase.storage
        .from('vault-documents').copy(src.storage_path, newPath);
      if (cpErr) {
        await supabase.from('documents').delete().eq('id', newDoc.id);
        throw new Error(`copy_document: storage copy of "${src.title}": ${cpErr.message}`);
      }
      await supabase.from('documents').update({ storage_path: newPath }).eq('id', newDoc.id);
    }

    // Copy the raw (summary_level 0) passages with their embeddings so the
    // copy is immediately searchable — no re-ingest, no re-embedding cost.
    const { data: passages, error: pasErr } = await supabase
      .from('passages')
      .select('*')
      .eq('document_id', id)
      .eq('summary_level', 0)
      .order('sequence_number', { ascending: true });
    if (pasErr) throw new Error(`copy_document: read passages of "${src.title}": ${pasErr.message}`);
    const batch = (passages ?? []).map((p) => {
      const np = { ...p };
      for (const k of COPY_STRIP_PASSAGE) delete np[k];
      np.document_id = newDoc.id;
      np.matterspace_id = target.id;
      return np;
    });
    // Batched: embedding vectors are ~12KB of JSON each.
    for (let i = 0; i < batch.length; i += 100) {
      const { error: batchErr } = await supabase.from('passages').insert(batch.slice(i, i + 100));
      if (batchErr) throw new Error(`copy_document: copy passages of "${src.title}": ${batchErr.message}`);
    }

    copies.push({ document_id: newDoc.id, title: newDoc.title, copied_from: id, passages: batch.length });
  }

  return {
    to: { id: target.id, short_code: target.short_code, name: target.name },
    copies,
    note: 'Copies created; the originals remain filed in their source matters.',
  };
}

async function ensureSandboxServerspace(supabase, opts = {}) {
  const { data: existing, error } = await supabase
    .from('serverspaces')
    .select('id, name')
    .ilike('name', SANDBOX_SERVERSPACE_NAME)
    .limit(1);
  if (error) throw new Error(`sandbox: ${error.message}`);
  if (existing && existing.length) return existing[0];

  const uid = await resolveCallerId(supabase, opts);
  let csQuery = supabase.from('clientspaces').select('id').limit(1);
  if (uid) csQuery = csQuery.eq('user_id', uid);
  const { data: cs, error: csErr } = await csQuery;
  if (csErr) throw new Error(`sandbox: clientspace lookup: ${csErr.message}`);
  if (!cs || !cs.length) {
    throw new Error('sandbox: no clientspace found for this account — cannot create the Sandbox serverspace');
  }
  const { data: ss, error: ssErr } = await supabase
    .from('serverspaces')
    .insert({
      clientspace_id: cs[0].id,
      name: SANDBOX_SERVERSPACE_NAME,
      description:
        'Scratch workspace for the AI Workbench. Everything here is a ' +
        'working copy — originals stay filed in their matters.',
    })
    .select('id, name')
    .single();
  if (ssErr) throw new Error(`sandbox: create serverspace: ${ssErr.message}`);
  // The owner-membership trigger keys off auth.uid(), which service-role
  // callers don't have — add membership explicitly so the space shows up
  // in the app. Hosted/user-scoped callers get it from the trigger.
  if (opts.userId) {
    try {
      await supabase.from('serverspace_members').insert({
        serverspace_id: ss.id, user_id: opts.userId, role: 'owner',
      });
    } catch { /* trigger may have beaten us to it */ }
  }
  return ss;
}

// One mini-box (matter) per source matter inside the Sandbox serverspace.
async function ensureSandboxBox(supabase, sandbox, sourceMatter) {
  const base = ('sbx-' + (sourceMatter.short_code || slugifyShortCode(sourceMatter.name))).slice(0, 61);
  for (const code of [base, `${base}-2`, `${base}-3`, `${base}-4`]) {
    const { data: existing } = await supabase
      .from('matterspaces')
      .select('id, short_code, name, serverspace_id')
      .eq('short_code', code)
      .maybeSingle();
    if (existing) {
      if (existing.serverspace_id === sandbox.id) return existing;
      continue; // short_code taken by an unrelated matter — try a suffix
    }
    const { data: box, error } = await supabase
      .from('matterspaces')
      .insert({
        serverspace_id: sandbox.id,
        parent_matterspace_id: null,
        name: sourceMatter.name,
        short_code: code,
        description: `Sandbox working copies from "${sourceMatter.name}" (${sourceMatter.short_code || sourceMatter.id})`,
      })
      .select('id, short_code, name')
      .single();
    if (!error) return box;
    if (error.code !== '23505') throw new Error(`sandbox: create box "${code}": ${error.message}`);
    // 23505 = raced with a concurrent creator — loop re-checks this code.
  }
  throw new Error(`sandbox: could not allocate a mini-box short_code for "${sourceMatter.name}"`);
}

export async function handleSendToSandbox(supabase, args, opts = {}) {
  const ids = Array.isArray(args.document_ids) ? args.document_ids : [];
  if (ids.length === 0) throw new Error('send_to_sandbox: document_ids (array of at least 1 UUID) is required');

  const sandbox = await ensureSandboxServerspace(supabase, opts);

  const { data: docs, error } = await supabase
    .from('documents')
    .select('id, title, matterspace_id')
    .in('id', ids);
  if (error) throw new Error(`send_to_sandbox: ${error.message}`);
  const byId = new Map((docs ?? []).map((d) => [d.id, d]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new Error(
      `send_to_sandbox: not found (or not accessible): ${missing.join(', ')}. ` +
      'Use document UUIDs from list_matter_contents or search.'
    );
  }

  // Group by source matter — one mini-box per source matter, so materials
  // from different matters never mix inside the Sandbox.
  const bySource = new Map();
  for (const id of ids) {
    const d = byId.get(id);
    if (!bySource.has(d.matterspace_id)) bySource.set(d.matterspace_id, []);
    bySource.get(d.matterspace_id).push(id);
  }

  const boxes = [];
  for (const [sourceId, docIds] of bySource) {
    const source = await resolveMatter(supabase, sourceId);
    if (source.serverspace_id === sandbox.id) {
      boxes.push({
        box: { id: source.id, short_code: source.short_code, name: source.name },
        documents: docIds.map((x) => ({ document_id: x, title: byId.get(x).title })),
        note: 'already in the Sandbox; not copied again',
      });
      continue;
    }
    const box = await ensureSandboxBox(supabase, sandbox, source);
    const copied = await handleCopyDocument(supabase, { document_ids: docIds, to_matter: box.id }, opts);
    boxes.push({
      source_matter: { id: source.id, short_code: source.short_code, name: source.name },
      box: { id: box.id, short_code: box.short_code, name: box.name },
      documents: copied.copies,
    });
  }

  return {
    sandbox: { serverspace_id: sandbox.id, name: sandbox.name },
    boxes,
    note:
      'Copies staged in the Sandbox; originals remain filed. Use each ' +
      "box's short_code as the matter argument for assemble_documents, " +
      'search, or file_document.',
  };
}


// -----------------------------------------------------------------------------
// assemble_documents — merge stored PDF originals into one PDF, server-side,
// and file the result back through the normal ingest pipeline. Exists because
// some agent sandboxes (claude.ai) cannot fetch signed storage URLs at all:
// the bytes never leave Supabase except as the finished, filed merge.
// -----------------------------------------------------------------------------

// Pure merge, factored out for testing: buffers in, merged bytes + per-source
// page ranges out. Ranges are 1-indexed and inclusive.
export async function mergePdfBuffers(buffers) {
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();
  const ranges = [];
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    const from = out.getPageCount() + 1;
    for (const p of pages) out.addPage(p);
    ranges.push({ from, to: out.getPageCount() });
  }
  // No object streams: pdf-parse 1.1.1 (the ingest pipeline's PDF reader,
  // bundling a 2017 pdf.js) reported "Invalid PDF structure" on pdf-lib's
  // default output for the text-page fixtures of the 2026-09-03 worker smoke
  // test (a raster page in an object stream did parse, so it is some object-
  // stream layouts, not all). Assembled PDFs carry arbitrary fonts and
  // objects from their sources; the classic xref layout is the one that
  // reader reads every time, at the cost of a slightly larger file.
  const bytes = await out.save({ useObjectStreams: false });
  return { bytes: Buffer.from(bytes), ranges };
}

const ASSEMBLE_MAX_TOTAL_BYTES = 100 * 1024 * 1024; // serverless memory guard

export async function handleAssembleDocuments(supabase, args, opts = {}) {
  if (!args.matter) throw new Error('matter is required');
  const ids = args.document_ids;
  if (!Array.isArray(ids) || ids.length < 2) {
    throw new Error('document_ids must be an array of at least 2 document UUIDs');
  }

  const matter = await resolveMatter(supabase, args.matter);

  // Resolve every source through the caller's RLS-scoped client AND pin it to
  // the target matter — assembly never crosses the matter-isolation boundary.
  const { data: rows, error } = await supabase
    .from('documents')
    .select('id, title, source_filename, storage_path, file_size_bytes')
    .eq('matterspace_id', matter.id)
    .in('id', ids);
  if (error) throw new Error(`assemble_documents: ${error.message}`);
  const byId = new Map((rows || []).map((r) => [r.id, r]));

  let totalBytes = 0;
  const sources = ids.map((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new Error(
        `assemble_documents: document ${id} not found in matter ` +
        `${matter.short_code || matter.id} (or not accessible to this account)`
      );
    }
    if (!row.storage_path) {
      throw new Error(
        `assemble_documents: "${row.title || id}" has no stored original — ` +
        'it was ingested as text only and cannot be merged'
      );
    }
    const name = row.source_filename || row.storage_path;
    if (!name.toLowerCase().endsWith('.pdf')) {
      throw new Error(
        `assemble_documents: "${row.title || name}" is not a PDF (${name}). ` +
        'Only PDF originals can be merged in this version.'
      );
    }
    totalBytes += row.file_size_bytes || 0;
    return row;
  });
  if (totalBytes > ASSEMBLE_MAX_TOTAL_BYTES) {
    throw new Error(
      `assemble_documents: sources total ${(totalBytes / 1048576).toFixed(0)}MB — ` +
      `over the ${ASSEMBLE_MAX_TOTAL_BYTES / 1048576}MB limit. Assemble in smaller batches.`
    );
  }

  const buffers = [];
  for (const row of sources) {
    const { data, error: dlErr } = await supabase.storage
      .from('vault-documents')
      .download(row.storage_path);
    if (dlErr) throw new Error(`assemble_documents: download "${row.title}": ${dlErr.message}`);
    buffers.push(Buffer.from(await data.arrayBuffer()));
  }

  let merged;
  try {
    merged = await mergePdfBuffers(buffers);
  } catch (err) {
    throw new Error(`assemble_documents: merge failed: ${err.message || String(err)}`);
  }

  const filename = (args.filename || 'assembled.pdf').replace(/\.pdf$/i, '') + '.pdf';
  const mergedPages = merged.ranges.length ? merged.ranges[merged.ranges.length - 1].to : 0;
  // Deliverable artifact, filed store-and-display (like create_deck): the
  // sources are already the searchable copies, and the old pdfjs in the
  // ingest path can't parse pdf-lib output anyway — re-ingesting the merge
  // marked every assembled exhibit "error" despite a perfectly good file.
  const filed = await fileGenerated(supabase, args.matter, filename, merged.bytes, {
    title: args.title,
    docType: args.doc_type || 'other',
    ingest: false,
    pageCount: mergedPages,
    opts,
  });
  const downloadUrl = await signDownloadUrl(supabase, filed.document_id);

  return {
    document_id: filed.document_id,
    matter: filed.matter,
    filename,
    page_count: mergedPages,
    manifest: sources.map((row, i) => ({
      document_id: row.id,
      title: row.title,
      source_filename: row.source_filename,
      pages_from: merged.ranges[i].from,
      pages_to: merged.ranges[i].to,
    })),
    ingest_status: filed.status,
    download_url: downloadUrl,
    expires_in_seconds: downloadUrl ? 900 : undefined,
    note:
      'Merged PDF filed into the matter as a viewable copy; its source ' +
      'documents remain the searchable versions. Give download_url to the ' +
      'user as a clickable link — it works in their browser even if your ' +
      'own environment cannot fetch it. It expires; call get_media with ' +
      'the new document_id for a fresh one.',
  };
}


// -----------------------------------------------------------------------------
// Document tasks — edit_pdf / create_deck / create_chart (Sandbox Phase 2).
// Heavy renderers (pdf-lib, pptxgenjs) are lazy-imported so retrieval-only
// callers stay light.
// -----------------------------------------------------------------------------

// Store a generated artifact as a document. ingest=true routes through the
// full file_document pipeline (searchable); ingest=false stores it directly
// as 'ready' — right for artifacts like .pptx/.svg deliverables the ingest
// extractors don't handle, which would otherwise land in status 'error'.
async function fileGenerated(supabase, matterKey, filename, buf, { title, docType, ingest, pageCount, opts = {} }) {
  if (ingest) {
    const filed = await handleFileDocument(supabase, {
      matter: matterKey,
      filename,
      title,
      doc_type: docType || 'other',
      content: buf.toString('base64'),
      encoding: 'base64',
    }, opts);
    return filed;
  }

  const matter = await resolveMatter(supabase, matterKey);
  const createdBy = await resolveCallerId(supabase, opts);
  const { data: doc, error: insErr } = await supabase
    .from('documents')
    .insert({
      matterspace_id: matter.id,
      title: title || filename.replace(/\.[^.]+$/, ''),
      doc_type: docType || 'other',
      source_filename: filename,
      file_size_bytes: buf.length,
      processing_status: 'ready',
      ...(pageCount ? { page_count: pageCount } : {}),
      ...(createdBy ? { created_by: createdBy } : {}),
    })
    .select('id')
    .single();
  if (insErr) throw new Error(`store artifact: ${insErr.message}`);
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const ext = '.' + (filename.split('.').pop() || '').toLowerCase();
  const storagePath = `${matter.id}/${doc.id}/${safeName}`;
  const { error: upErr } = await supabase.storage
    .from('vault-documents')
    .upload(storagePath, buf, { contentType: mimeForExt(ext), upsert: true });
  if (upErr) {
    await supabase.from('documents').delete().eq('id', doc.id);
    throw new Error(`store artifact upload: ${upErr.message}`);
  }
  await supabase.from('documents').update({ storage_path: storagePath }).eq('id', doc.id);
  return {
    document_id: doc.id,
    matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
    source_filename: filename,
    status: 'ready',
  };
}

async function signDownloadUrl(supabase, documentId) {
  const { data: doc } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('id', documentId)
    .maybeSingle();
  if (!doc?.storage_path) return null;
  const { data: signed } = await supabase.storage
    .from('vault-documents')
    .createSignedUrl(doc.storage_path, 900);
  return signed?.signedUrl ?? null;
}

// "3,1-2,5" -> [3,1,2,5] (1-based), validated against pageCount.
// "all" -> every page in order.
function parsePageSpec(spec, pageCount, label) {
  if (spec == null || spec === '' || spec === 'all') {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const out = [];
  for (const part of String(spec).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(p);
    if (!m) throw new Error(`${label}: bad page spec "${p}" — use numbers and ranges like "3,1-2,5"`);
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (a < 1 || b < 1 || a > pageCount || b > pageCount) {
      throw new Error(`${label}: page ${a > pageCount ? a : b} is out of range — the document has ${pageCount} pages`);
    }
    if (b >= a) { for (let i = a; i <= b; i++) out.push(i); }
    else { for (let i = a; i >= b; i--) out.push(i); }
  }
  if (out.length === 0) throw new Error(`${label}: page spec selected no pages`);
  return out;
}

export async function handleEditPdf(supabase, args, opts = {}) {
  if (!args.document_id) throw new Error('edit_pdf: document_id is required');

  const { data: src, error } = await supabase
    .from('documents')
    .select('id, title, doc_type, matterspace_id, source_filename, storage_path')
    .eq('id', args.document_id)
    .maybeSingle();
  if (error) throw new Error(`edit_pdf: ${error.message}`);
  if (!src) throw new Error('edit_pdf: document not found (or not accessible)');
  if (!src.storage_path) throw new Error('edit_pdf: this document has no stored original file');
  const srcName = src.source_filename || src.storage_path;
  if (!srcName.toLowerCase().endsWith('.pdf')) {
    throw new Error(`edit_pdf: "${src.title}" is not a PDF (${srcName})`);
  }

  const { data: blob, error: dlErr } = await supabase.storage
    .from('vault-documents')
    .download(src.storage_path);
  if (dlErr) throw new Error(`edit_pdf: download: ${dlErr.message}`);

  const { PDFDocument, degrees } = await import('pdf-lib');
  const pdf = await PDFDocument.load(Buffer.from(await blob.arrayBuffer()), { ignoreEncryption: true });
  const pageCount = pdf.getPageCount();

  // Rotations first (they reference SOURCE page numbers), then selection.
  for (const rot of args.rotate ?? []) {
    if (![90, 180, 270].includes(rot?.degrees)) {
      throw new Error('edit_pdf: rotate degrees must be 90, 180, or 270');
    }
    for (const p of parsePageSpec(rot.pages, pageCount, 'edit_pdf rotate')) {
      const page = pdf.getPage(p - 1);
      page.setRotation(degrees(((page.getRotation().angle + rot.degrees) % 360 + 360) % 360));
    }
  }

  const order = parsePageSpec(args.pages, pageCount, 'edit_pdf');
  const out = await PDFDocument.create();
  const copied = await out.copyPages(pdf, order.map((p) => p - 1));
  for (const p of copied) out.addPage(p);
  // No object streams — see mergePdfBuffers: the pipeline's pdf-parse cannot
  // read pdf-lib's default output, and an edited copy must stay ingestable.
  const bytes = Buffer.from(await out.save({ useObjectStreams: false }));

  const base = (src.source_filename || src.title || 'document').replace(/\.pdf$/i, '');
  const filename = (args.filename || `${base}-edited.pdf`).replace(/\.pdf$/i, '') + '.pdf';

  // Deliverable artifact, filed store-and-display (like create_deck): the
  // untouched original stays the searchable copy, and the ingest path's old
  // pdfjs can't parse pdf-lib output — re-ingesting marked every edited
  // copy "error" despite a perfectly good file.
  const filed = await fileGenerated(supabase, src.matterspace_id, filename, bytes, {
    title: args.title,
    docType: src.doc_type,
    ingest: false,
    pageCount: order.length,
    opts,
  });
  const downloadUrl = await signDownloadUrl(supabase, filed.document_id);

  return {
    document_id: filed.document_id,
    matter: filed.matter,
    filename,
    source_document_id: src.id,
    page_count: order.length,
    pages_kept: order,
    ingest_status: filed.status,
    download_url: downloadUrl,
    expires_in_seconds: downloadUrl ? 900 : undefined,
    note: 'Edited copy filed alongside the original (which is unchanged and remains the searchable version). Give download_url to the user as a clickable link.',
  };
}

export async function handleCreateDeck(supabase, args, opts = {}) {
  if (!args.matter) throw new Error('create_deck: matter is required');
  const { renderDeck, validateDeckSpec } = await import('./deck-render.mjs');
  validateDeckSpec(args);

  const buf = await renderDeck(args);
  const base = (args.filename || args.title).replace(/\.pptx$/i, '').replace(/[^\w\s.-]+/g, '').trim() || 'deck';
  const filename = `${base}.pptx`;

  const filed = await fileGenerated(supabase, args.matter, filename, buf, {
    title: args.title,
    docType: 'other',
    ingest: false, // deliverable artifact — the pptx extractors aren't in the ingest path
    opts,
  });
  const downloadUrl = await signDownloadUrl(supabase, filed.document_id);

  return {
    document_id: filed.document_id,
    matter: filed.matter,
    filename,
    slide_count: args.slides.length + 1, // + cover
    download_url: downloadUrl,
    expires_in_seconds: downloadUrl ? 900 : undefined,
    note:
      'Deck filed into the matter. Give download_url to the user as a ' +
      'clickable link — it opens in PowerPoint/Keynote/Slides. Charts are ' +
      'native and editable. The link expires; call get_media with the ' +
      'document_id for a fresh one.',
  };
}

export async function handleCreateChart(supabase, args, opts = {}) {
  if (!args.matter) throw new Error('create_chart: matter is required');
  const { renderChartSvg } = await import('./chart-svg.mjs');
  const svg = renderChartSvg(args);
  const buf = Buffer.from(svg, 'utf8');

  const base = (args.filename || args.title || `${args.type}-chart`).replace(/\.svg$/i, '').replace(/[^\w\s.-]+/g, '').trim() || 'chart';
  const filename = `${base}.svg`;

  const filed = await fileGenerated(supabase, args.matter, filename, buf, {
    title: args.title,
    docType: 'other',
    ingest: false, // visual artifact — nothing to index
    opts,
  });
  const downloadUrl = await signDownloadUrl(supabase, filed.document_id);

  return {
    document_id: filed.document_id,
    matter: filed.matter,
    filename,
    download_url: downloadUrl,
    expires_in_seconds: downloadUrl ? 900 : undefined,
    note:
      'Chart filed into the matter as an SVG image. Give download_url to ' +
      'the user as a clickable link — it renders in any browser and ' +
      'inserts cleanly into Word/Google Docs. The link expires; call ' +
      'get_media with the document_id for a fresh one.',
  };
}
