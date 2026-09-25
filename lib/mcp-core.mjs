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

import {
  sealedMatterIds, pausedMatterIds, matterPauseWithClient, aiPausedMessage,
} from './ai-tier-policy.mjs';
import { record, recordCrossMatter, redactToolArgs, scrubArgValues } from './ledger.mjs';
import { sealedSearchNote, tierMap } from './seal-pipes.mjs';
import { ROUTES, routeForTier, routeReady, EmbedRouteUnavailableError, isEmbedRouteUnavailable } from './embed-routes.mjs';
import { makeOcrProvider, describeOcrRoute } from './ocr-routes.mjs';
// Dependency-free: the accepted-types list, storage cap, and the
// "stored without text" vocabulary shared with the pipeline and the browser.
import { checkUpload, describeTextStatus, describeOcrPending, describeEmbeddingPending, TEXT_STATUS } from './ingest-formats.mjs';
// Which page a citation shows — the reporter's printed page where it is known,
// the PDF's page WITH a caveat where the detector looked and declined, and
// today's number, silently, where nothing is recorded. Shared with the app so
// an outline and a connector cite the same transcript the same way.
import { citePage, pageBasis, hasPrintedLineNumbers } from './cite-page.mjs';
// Matter conversations (migration 091): how a thread message is cited.
import { conversationCitation } from './conversation-cite.mjs';

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
      'The map of everything stored in Contextspaces. Call this first in any ' +
      'session, before retrieving, filing, or organizing. It answers with a ' +
      'compact tree — serverspace → matter → sub-matter, one line per matter ' +
      'reading "name | short_code | documents | id", indent meaning ' +
      'sub-matter — so the whole workspace fits in a glance and either the ' +
      'short_code or the id can be handed to any other tool. Narrow it when ' +
      'you already know where you are going: `serverspace` (its name or id) ' +
      'or `parent` (a matter\'s short_code or id) for one branch, `query` for ' +
      'a name/short_code substring. Descriptions are left out of the map; add ' +
      '`include_descriptions: true` (best together with `parent` or ' +
      '`serverspace`) to read a branch\'s descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        serverspace: {
          type: 'string',
          description: 'Optional. One serverspace only, by name (e.g. "Litigation") or id.',
        },
        parent: {
          type: 'string',
          description:
            'Optional. One matter and its sub-matters, by short_code (e.g. "webster") or UUID.',
        },
        query: {
          type: 'string',
          description:
            'Optional. Keep only matters whose name or short_code contains this text ' +
            '(case-insensitive), with the matters above and below them.',
        },
        include_descriptions: {
          type: 'boolean',
          description:
            'Optional. Add each matter\'s description after " :: " on its line. Large ' +
            'across the whole workspace — pair it with serverspace, parent or query.',
        },
        format: {
          type: 'string',
          enum: ['tree', 'full'],
          description:
            'Optional. "tree" (default) is the compact map. "full" returns one verbose ' +
            'object per matter with every field — large, and only for a narrowed branch.',
        },
      },
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
      'exhibits exist before you query the corpus. Paged: document_count is ' +
      'the true total; when next_offset is set, call again with that offset ' +
      'to see the rest (a large matter holds thousands).',
    inputSchema: {
      type: 'object',
      properties: {
        matter: {
          type: 'string',
          description: 'Matter short_code (e.g. "webster") or UUID.',
        },
        limit: {
          type: 'integer', minimum: 1, maximum: 1000,
          description: 'Documents per page (default and maximum 1000).',
        },
        offset: {
          type: 'integer', minimum: 0,
          description: 'Where the page starts — the next_offset of the previous call.',
        },
        sort: {
          type: 'string', enum: ['type', 'title', 'created_at_desc', 'created_at_asc'],
          description: 'Order: "type" (by document type, then volume, date, title — the default), "title", or by upload time, newest ("created_at_desc") or oldest first.',
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
      '-exclusions, OR). Messages from the matter\'s Thread conversations ' +
      'that are open to AI come back separately under `correspondence`, ' +
      'each cited "Thread › <conversation>, <author>, <date>".\n\n' +
      'READ THE PAGE NUMBER LITERALLY. On a transcript, a citation names ' +
      "the court reporter's printed page wherever the index was able to " +
      'read it. Where it was not, the citation carries the PDF page and ' +
      'says so in parentheses — quote that parenthetical if you repeat ' +
      'the cite, and never strip it. `page_basis` (present only where ' +
      'something is known) names which of the two the citation shows and ' +
      'gives `reader_page`, the PDF page that opens the file.\n\n' +
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
      'sub-matters), returning every occurrence with its page — and its ' +
      'line, on a transcript whose line numbers were read off the page — ' +
      'and surrounding context. Unlike `search`, results ' +
      'are in document order (not relevance order) and the result set ' +
      'is the COMPLETE set of matches up to max_matches — `match_count` ' +
      'always reports the true total. Messages from the matter\'s Thread ' +
      'conversations that are open to AI are matched too and come back ' +
      'separately under `correspondence_matches` (with ' +
      '`correspondence_match_count`), each cited "Thread › <conversation>, ' +
      '<author>, <date>"; a grep scoped to one `doc` does not include them.\n\n' +
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
      'file_document instead. A document that is already "ready" is only re-run with ' +
      'force: true — use it when a ready document\'s text is wrong (for example its passages ' +
      'hold nothing but a court filing stamp, or every passage cites page 1).',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'UUID of the stored document, from list_matter_contents / check_ingest_status / search results.',
        },
        force: {
          type: 'boolean',
          description: 'Optional. Re-run a document that is already ready and searchable. Its current text stays searchable until the new run succeeds, and is kept if the re-run fails. Default false.',
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
      'rotate pages, and put in pages from OTHER stored PDFs (`inserts`) — ' +
      'saving the result as a NEW document in the same ' +
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
        inserts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              at: {
                type: 'number',
                description:
                  '1-based position in the OUTPUT (after `pages` is applied) that these pages go in before; ' +
                  'a position past the end appends them.',
              },
              document_id: { type: 'string', description: 'UUID of the stored PDF the pages come from.' },
              pages: { type: 'string', description: 'Which pages of that PDF, e.g. "12-15" or "3,7".' },
              degrees: { type: 'number', enum: [0, 90, 180, 270], description: 'Optional clockwise rotation added to the inserted pages.' },
            },
            required: ['at', 'document_id', 'pages'],
            additionalProperties: false,
          },
          description:
            'Optional pages from other stored PDFs, placed among the output pages — a cleaner copy of a ' +
            'page from another edition, an exhibit into a filing. Inserts sharing an `at` keep their listed order.',
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
  // ---------------------------------------------------------------------------
  // The task board (migration 085; any connection since 089). Listed for every
  // connector. A task can be assigned to an agent, to a full-access token, or
  // to a full-assistant OAuth sign-in (Claude, ChatGPT, Grok …); a connection
  // with none is told so in one line. The loop: my_tasks → claim_task → work
  // with the normal tools inside the task's matter → ask_human if blocked →
  // post_result.
  // ---------------------------------------------------------------------------
  {
    name: 'my_tasks',
    description:
      'The task board: the tasks a person in Contextspaces has delegated to THIS ' +
      'connection (an agent, or you as their assistant), newest first. When the user ' +
      'asks you to check their Contextspaces tasks, call this, then claim_task, do the ' +
      'work, ask_human if blocked, and post_result. An agent starts every session here ' +
      'and polls it while it waits for an answer to ask_human. Default shows the live ones ' +
      '(open, claimed, needs_input). Each task gives its title, instructions, matter ' +
      '(short_code + name — pass the short_code as `matter` to search, grep, ' +
      'list_matter_contents, file_document …), due_at, the latest question and ' +
      'answer, and its attachments: a document attachment is a document id that ' +
      'works with get_outline (doc), grep (doc), search (document_ids) and get_media ' +
      '(document_id); a page/list or calendar attachment comes with its text inline. ' +
      'Next step for an open task: claim_task.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'open', 'claimed', 'needs_input', 'done', 'failed', 'cancelled', 'all'],
          description:
            'Which tasks. "active" (default) = open + claimed + needs_input. "all" includes ' +
            'finished and cancelled ones.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'claim_task',
    description:
      'Take an open task from my_tasks before working on it ' +
      '(open → claimed). Safe to repeat: claiming a task you already claimed just ' +
      'returns it. Then do the work with the normal tools inside the task\'s matter, ' +
      'call ask_human if you are blocked, and finish with post_result.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task id from my_tasks.' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_human',
    description:
      'Ask the person who delegated a task ONE clear question ' +
      'when you cannot go on without them (the task becomes needs_input). Their answer ' +
      'arrives on the task in my_tasks (status back to claimed, `answer` filled in) — ' +
      'poll my_tasks, then carry on. Asking again replaces the previous question.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task id from my_tasks.' },
        question: { type: 'string', description: 'The question, in plain words. Max 4,000 characters.' },
      },
      required: ['task_id', 'question'],
      additionalProperties: false,
    },
  },
  {
    name: 'post_result',
    description:
      'Finish a task: store your result (the answer, summary or ' +
      'report, in plain text or Markdown) and mark it done — or status "failed" with the ' +
      'reason if you could not do it. If you filed documents into the matter with ' +
      'file_document, list them in result_refs so the person can open them from the task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task id from my_tasks.' },
        result: { type: 'string', description: 'The result, or why it failed. Max 100,000 characters.' },
        result_refs: {
          type: 'array',
          description: 'Optional. Items you produced or relied on, e.g. a document you filed.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['document', 'content_item', 'calendar_event'] },
              id: { type: 'string', description: 'The item\'s id (a document id from file_document).' },
              label: { type: 'string', description: 'Optional short label.' },
            },
            required: ['kind', 'id'],
            additionalProperties: false,
          },
        },
        status: {
          type: 'string',
          enum: ['done', 'failed'],
          description: 'Default "done". "failed" when the task could not be completed.',
        },
      },
      required: ['task_id', 'result'],
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

/**
 * The documents edit_pdf's `inserts` bring pages FROM. They are as much a part
 * of the call as `document_id` — their pages land in the output — so every
 * gate that asks "which documents does this call touch" (the seal, the pause,
 * the agent grant, the Record's document list) must see them. Before
 * 2026-09-25 only the agent grant did.
 */
function insertDocumentIds(args = {}) {
  if (!Array.isArray(args.inserts)) return [];
  const ids = [];
  for (const ins of args.inserts) {
    if (ins && typeof ins === 'object' && typeof ins.document_id === 'string') ids.push(ins.document_id);
  }
  return ids;
}

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
  // edit_pdf's inserts carry another document's pages into the output.
  for (const d of insertDocumentIds(args)) if (UUID_RE.test(d)) docIds.push(d);
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

// -----------------------------------------------------------------------------
// The AI pause (migration 070) — the same door, one question earlier
// -----------------------------------------------------------------------------
// A paused matter is as invisible to a connected AI as a sealed one, and the
// refusal is deliberately total: reads as well as writes.
//
// Why reads too. It is tempting to refuse only the tools that change something
// and let a connector keep reading. But an MCP tool call is not a person
// reading a file — the result goes straight into an outside model's context
// window, which is the one thing "pause all AI on this matter" is a request to
// stop. `search`, `get_passage` and `get_outline` are the tools that move the
// matter's own words; refusing the writes and permitting those would pause the
// harmless half. So every tool keyed to a paused matter refuses, and a paused
// matter drops out of `list_matters` and out of any cross-matter scope — on
// the connector path AND the in-app path, because a global search run from an
// unpaused matter would otherwise carry a paused matter's passages to a model
// just the same.
//
// The cost is stated plainly: while a matter is paused, a connected assistant
// cannot see it at all, and the user is told why in one sentence.

export class AiPausedMatterError extends Error {
  constructor(pause) {
    super(aiPausedMessage(pause));
    this.name = 'AiPausedMatterError';
    this.code = 'ai_paused';
    this.pausedMatterId = pause?.matterId ?? null;
  }
}

/** Every matter id this call is keyed to — the seal's own arg vocabulary. */
async function matterIdsTouchedBy(supabase, name, args = {}, opts = {}) {
  const ids = new Set();
  if (typeof opts.matterId === 'string' && opts.matterId) ids.add(opts.matterId);
  for (const key of SEAL_MATTER_ARGS) {
    const v = args[key];
    if (typeof v !== 'string' || !v) continue;
    try {
      const m = await resolveMatter(supabase, v);
      if (m?.id) ids.add(m.id);
    } catch { /* an unresolvable name is the handler's error to report */ }
  }
  const docIds = documentIdsIn(args);
  if (docIds.length) {
    const { data } = await supabase
      .from('documents').select('id, matterspace_id').in('id', docIds);
    for (const d of data ?? []) if (d?.matterspace_id) ids.add(d.matterspace_id);
  }
  if (name === 'get_passage' && typeof args.id === 'string' && UUID_RE.test(args.id)) {
    const { data } = await supabase
      .from('passages').select('matterspace_id').eq('id', args.id).maybeSingle();
    if (data?.matterspace_id) ids.add(data.matterspace_id);
  }
  return ids;
}

/**
 * Refuse a tool call that would touch a paused matter. Returns the paused id
 * set so the dispatcher can also drop those matters from listings and scopes.
 *
 * Costed like enforceConnectorSeal: one small indexed query answers "is
 * anything paused at all", and on the overwhelmingly common answer (nothing)
 * it returns immediately and this whole module behaves exactly as before. A
 * database without migration 070 takes the same early exit.
 */
export async function enforceAiPause(supabase, name, args = {}, opts = {}) {
  const { ids: paused } = await pausedMatterIds(supabase);
  if (paused.size === 0) return paused;

  const touched = await matterIdsTouchedBy(supabase, name, args, opts);
  for (const id of touched) {
    if (!paused.has(id)) continue;
    // Read the pause's byline from the matter that actually carries it, so the
    // sentence names a person and a date rather than saying "someone".
    const pause = await matterPauseWithClient(supabase, id);
    throw new AiPausedMatterError(pause?.paused ? pause : { matterId: id });
  }
  return paused;
}

// -----------------------------------------------------------------------------
// Agent scope (migration 085) — the seal's door, asked from the other side
// -----------------------------------------------------------------------------
// A USER connector sees every matter RLS shows the user, minus the sealed and
// the paused ones. An AGENT connector (a csp_ token with kind 'agent') sees
// only the matters in its grant and their sub-matters — and still never a
// sealed or paused one, granted or not: the seal wins. The privilege default
// is OFF: an agent with scope '{}' reaches nothing.
//
// It is the same machinery, not a parallel one:
//   * refusing — a call that NAMES a matter, a document or a passage outside
//     the grant is refused before the handler runs, like a sealed one, with a
//     typed error (code 'agent_scope') that never repeats the matter's name;
//   * hiding — the set every handler already honours as `excludeMatterIds`
//     (list_matters, all-matters search, a parent's sub-matters in search and
//     grep, the Record's fan-out) becomes AgentScopeHidden: "everything
//     outside the grant, plus the sealed and the paused". It is a complement,
//     answered by membership, so it never has to be built from a list of every
//     matter — a list PostgREST would truncate at 1,000 rows and so fail open.
//
// Fails CLOSED throughout: an agent call that names no matter at all is
// refused unless the tool is one that reads the hidden set (list_matters,
// search); a document id that does not come back, or comes back with no
// matter, is refused; a malformed agent token is refused.

export const AGENT_TASK_TOOLS = new Set(['my_tasks', 'claim_task', 'ask_human', 'post_result']);
// Migration 089: every connection can receive tasks, so a caller that is not
// one (the in-app Assistant, a pre-065 OAuth token) simply has none.
export const NO_TASKS_MESSAGE = 'You have no Contextspaces tasks.';
// Tools that may run for an agent with no matter named: each one narrows what
// it reads by the hidden set.
const AGENT_UNKEYED_OK = new Set(['list_matters', 'search']);
// Tools that write OUTSIDE the matter they are handed (send_to_sandbox makes
// a box in the Sandbox serverspace) — never for an agent.
const AGENT_REFUSED_TOOLS = new Set(['send_to_sandbox']);
const AGENT_SCOPE_MESSAGE =
  'This agent connection has not been granted that matter (or the item is in a matter it ' +
  'has not been granted, or does not exist). An agent sees only the matters it was given ' +
  'under Connections → Agents, and their sub-matters; list_matters shows them.';

export class AgentScopeError extends Error {
  constructor(message = AGENT_SCOPE_MESSAGE) {
    super(message);
    this.name = 'AgentScopeError';
    this.code = 'agent_scope';
  }
}

/** "Hidden" for an agent: outside the grant, or denied (sealed / paused). */
export class AgentScopeHidden {
  constructor(allowed, deny) {
    this.allowed = allowed;
    this.deny = deny ?? new Set();
  }
  has(id) { return !this.allowed.has(id) || this.deny.has(id); }
  // Every consumer asks `.size` only as "is anything hidden?". For an agent
  // the answer is always yes: everything outside the grant.
  get size() { return Number.MAX_SAFE_INTEGER; }
}

/**
 * The "allowed" set of an agent given "All my matters (except SecureSpaces)"
 * (migration 088): every matter the owner's own RLS shows, minus the sealed.
 * Answered by membership in the SEALED set, never built from a list of all
 * matters (PostgREST would cut that list at 1,000 rows and so fail open or
 * shut at random). RLS already hides what the owner cannot open, so a matter
 * id that resolves at all is one the owner can see. A Set subclass so every
 * `allowed.has(...)` and `instanceof Set` check made for a listed grant
 * works on it unchanged.
 */
export class AgentScopeAll extends Set {
  constructor(sealed) {
    super();
    this.sealed = sealed ?? new Set();
  }
  has(id) { return typeof id === 'string' && id.length > 0 && !this.sealed.has(id); }
}

const AGENT_ALL_SCOPE_MESSAGE =
  'This agent connection cannot reach that (it is in a SecureSpace, or it does not exist). ' +
  'An agent given "All my matters" sees every matter its owner can open except SecureSpaces; ' +
  'list_matters shows them.';

/**
 * Who a task on this call is for, when the caller is NOT an agent (089): the
 * full-access connector token it arrived on, or the OAuth grant of a
 * full-assistant sign-in. api/mcp.mjs callToolOptsFor sets it; nothing else
 * does, so the in-app Assistant has none. Malformed = none (no tasks), never
 * someone else's.
 */
function taskRecipientOf(opts = {}) {
  const r = opts?.taskRecipient;
  if (!r || typeof r !== 'object') return null;
  if ((r.kind !== 'token' && r.kind !== 'grant') || typeof r.id !== 'string' || !UUID_RE.test(r.id)) return null;
  return { kind: r.kind, id: r.id, userId: typeof r.userId === 'string' ? r.userId : null };
}

/** The agent token on this call, or null for every other caller. */
function agentTokenOf(opts = {}) {
  const a = opts?.agentToken;
  if (a === undefined || a === null) return null;
  if (typeof a !== 'object' || typeof a.id !== 'string' || !UUID_RE.test(a.id)) {
    throw new AgentScopeError('This agent connection could not be identified; reconnect it under Connections → Agents.');
  }
  const scope = Array.isArray(a.matterScope)
    ? [...new Set(a.matterScope.filter((id) => typeof id === 'string' && UUID_RE.test(id)))]
    : [];
  return {
    id: a.id,
    userId: typeof a.userId === 'string' ? a.userId : null,
    matterScope: scope,
    // 088: strictly true, or it is a listed grant (fails closed).
    scopeAll: a.scopeAll === true,
  };
}

/**
 * Every matter the agent may reach: each granted matter and its descendants,
 * minus the sealed ones. Walks down from the grant (never scans the table).
 */
async function agentAllowedMatterIds(supabase, agent, sealed) {
  const allowed = new Set();
  for (const root of agent.matterScope) {
    allowed.add(root);
    const { data, error } = await supabase.rpc('matterspace_descendants', { p_root: root });
    if (error) throw new Error(`agent scope lookup failed: ${error.message}`);
    for (const r of data ?? []) if (r?.id) allowed.add(r.id);
  }
  for (const id of sealed) allowed.delete(id);
  return allowed;
}

/** Document ids an agent call names, including edit_pdf's inserts. */
function agentDocArgs(args = {}) {
  const ids = [];
  let malformed = false;
  const take = (v) => {
    if (typeof v !== 'string' || !v) return;
    if (UUID_RE.test(v)) ids.push(v); else malformed = true;
  };
  for (const key of SEAL_DOC_ARGS) take(args[key]);
  for (const key of SEAL_DOC_LIST_ARGS) {
    if (Array.isArray(args[key])) for (const d of args[key]) take(d);
  }
  for (const d of insertDocumentIds(args)) take(d);
  return { ids: [...new Set(ids)], malformed };
}

/**
 * Refuse an agent call that reaches outside its grant. Runs BEFORE the pause
 * and the seal, so a refusal never names a matter the agent may not see.
 */
export async function enforceAgentScope(supabase, name, args = {}, allowed) {
  if (AGENT_REFUSED_TOOLS.has(name)) {
    throw new AgentScopeError(
      `${name} writes outside the matters this agent has been granted, so agent connections cannot use it.`,
    );
  }
  // "All my matters" (088): no matter restriction beyond the owner's own RLS,
  // so a top-level create_matter and a call that names no matter are the
  // user connector's, not refused. The seal is still enforced below: a named
  // sealed matter, document or passage is refused, like one outside a grant.
  const all = allowed instanceof AgentScopeAll;
  const refuse = () => new AgentScopeError(all ? AGENT_ALL_SCOPE_MESSAGE : undefined);
  if (!all && name === 'create_matter' && !(typeof args.parent === 'string' && args.parent)) {
    throw new AgentScopeError(
      'An agent connection can create a matter only inside one it has been granted: pass `parent` ' +
      '(a granted matter\'s short_code or id). It cannot create a top-level matter.',
    );
  }
  // The task tools check their own task's matter (handleClaimTask et al.).
  if (AGENT_TASK_TOOLS.has(name)) return;

  let touched = 0;
  for (const key of SEAL_MATTER_ARGS) {
    const v = args[key];
    if (typeof v !== 'string' || !v) continue;
    let m = null;
    try { m = await resolveMatter(supabase, v); } catch { m = null; }
    if (!m?.id || !allowed.has(m.id)) throw refuse();
    touched += 1;
  }

  const docs = agentDocArgs(args);
  if (docs.malformed) throw refuse();
  if (docs.ids.length) {
    const { data, error } = await supabase
      .from('documents').select('id, matterspace_id').in('id', docs.ids);
    if (error) throw new Error(`agent scope check: ${error.message}`);
    const byId = new Map((data ?? []).map((d) => [d.id, d.matterspace_id]));
    for (const id of docs.ids) {
      const mid = byId.get(id);
      if (!mid || !allowed.has(mid)) throw refuse();
    }
    touched += docs.ids.length;
  }

  if (name === 'get_passage' && typeof args.id === 'string' && args.id) {
    if (!UUID_RE.test(args.id)) throw refuse();
    const { data, error } = await supabase
      .from('passages').select('matterspace_id').eq('id', args.id).maybeSingle();
    if (error) throw new Error(`agent scope check: ${error.message}`);
    if (!data?.matterspace_id || !allowed.has(data.matterspace_id)) throw refuse();
    touched += 1;
  }

  if (touched === 0 && !all && !AGENT_UNKEYED_OK.has(name)) throw new AgentScopeError();
}

/**
 * The one door every tool call passes through — api/mcp.mjs, the in-app
 * Assistant, scripts/mcp-server.mjs and api/sandbox.mjs all arrive here.
 *
 * W1 (migration 064): a call that resolves to a matter leaves exactly one
 * `tool.invoked` row in that matter's Record, whether it succeeded, failed,
 * or was refused by the seal. Metadata only — the tool's name, the matter,
 * the documents touched, who asked, and how it ended; lib/ledger.mjs strips
 * anything that looks like content or a secret before it leaves this
 * process. Recording is best-effort: it is never the reason a tool call
 * fails, and it never runs on a matter-less call.
 *
 * `opts.actor` is the W1/W2 contract:
 *   {kind:'user'|'charter'|'connector'|'system', ref, user_id?, label?,
 *    session_id?}. Callers that do not set it are recorded as
 *   {kind:'user', ref:<auth.uid()>} — existing call sites keep working
 *   unchanged until W2 supplies the connector identity.
 */
export async function callTool(supabase, name, args = {}, opts = {}) {
  const startedAt = Date.now();
  try {
    const out = await dispatchWithSeal(supabase, name, args, opts);
    await recordToolInvoked(supabase, name, args, opts, { ok: true, ms: Date.now() - startedAt, result: out });
    return out;
  } catch (err) {
    await recordToolInvoked(supabase, name, args, opts, {
      ok: false,
      ms: Date.now() - startedAt,
      refused: err?.code === 'sealed_matter' ? 'sealed'
        : err?.code === 'ai_paused' ? 'paused'
        : err?.code === 'agent_scope' ? 'agent_scope'
        : null,
      error: err?.message,
    });
    throw err;
  }
}

async function dispatchWithSeal(supabase, name, args = {}, opts = {}) {
  // An agent connection (migration 085) is scoped to its grant; see
  // enforceAgentScope. Every other caller takes the path below, unchanged.
  const agent = agentTokenOf(opts);
  // 089: any connection can be handed a task. Not an agent → the full-access
  // token or OAuth grant it came in on; neither → it has no tasks.
  const recipient = agent || !AGENT_TASK_TOOLS.has(name) ? null : taskRecipientOf(opts);
  if (AGENT_TASK_TOOLS.has(name) && !agent && !recipient) return noTasksAnswer(name);

  let agentAllowed = null;
  let agentSealed = null;
  if (agent) {
    // The grant first, before the pause or the seal can say anything about a
    // matter by name. Sealed matters leave the grant here, so the seal's own
    // named-matter refusal (enforceConnectorSeal) is subsumed: every matter an
    // agent call may name is already known to be unsealed.
    agentSealed = await sealedMatterIds(supabase);
    // 088: "All my matters" is everything not sealed — a membership test on
    // the sealed set, never a list of every matter.
    agentAllowed = agent.scopeAll
      ? new AgentScopeAll(agentSealed)
      : await agentAllowedMatterIds(supabase, agent, agentSealed);
    await enforceAgentScope(supabase, name, args, agentAllowed);
  }

  // The pause is asked on EVERY path, not only the connector's: it is the one
  // gate the in-app assistant, an agent charter, the sandbox and a connected
  // assistant all share, which is what lets a later meeting surface inherit it
  // without adding a check of its own.
  const paused = await enforceAiPause(supabase, name, args, opts);
  const sealed = agent ? agentSealed
    : opts.sealConnector || recipient
      ? await enforceConnectorSeal(supabase, name, args)
      : new Set();
  const denied = paused.size === 0 ? sealed
    : sealed.size === 0 ? paused
    : new Set([...sealed, ...paused]);
  // An agent with "All my matters" (088) hides exactly what a user connector
  // hides — the sealed and the paused — so "outside the grant" is empty.
  const hidden = agent && !agent.scopeAll ? new AgentScopeHidden(agentAllowed, denied) : denied;
  if (agent) {
    opts = {
      ...opts,
      agentScope: {
        token: agent, allowed: agentAllowed, paused, sealed,
        recipient: { kind: 'token', id: agent.id, userId: agent.userId, agent: true },
      },
    };
  } else if (recipient) {
    // A full assistant sees what its user sees, minus the sealed and the
    // paused — so a task's matter passes the same seal/pause check as any
    // matter it names. AgentScopeAll is exactly "not sealed" by membership.
    opts = {
      ...opts,
      agentScope: {
        token: null, allowed: new AgentScopeAll(sealed), paused, sealed,
        recipient: { ...recipient, agent: false },
      },
    };
  }

  if (hidden.size > 0) {
    const out = await dispatchTool(supabase, name, args, { ...opts, excludeMatterIds: hidden });
    // handleListMatters prunes the hidden ids AND everything under them before
    // it counts a single document, which is the only way the TREE shape can be
    // filtered at all (it is text, not rows). This stays as the last gate on
    // the `format:'full'` array — a second pass over a list that is already
    // clean, kept because a listing is the one place a leak would be silent.
    if (name === 'list_matters' && Array.isArray(out)) {
      return out.filter((m) => !hidden.has(m.id));
    }
    return out;
  }
  return dispatchTool(supabase, name, args, opts);
}

/** Document ids named anywhere in a tool's arguments. */
function documentIdsIn(args = {}) {
  const ids = [];
  for (const key of [...SEAL_DOC_ARGS, 'id']) {
    const v = args[key];
    if (typeof v === 'string' && UUID_RE.test(v)) ids.push(v);
  }
  for (const key of SEAL_DOC_LIST_ARGS) {
    const v = args[key];
    if (!Array.isArray(v)) continue;
    for (const d of v) if (typeof d === 'string' && UUID_RE.test(d)) ids.push(d);
  }
  for (const d of insertDocumentIds(args)) if (UUID_RE.test(d)) ids.push(d);
  return [...new Set(ids)];
}

/**
 * Which matter this call belongs to, or null. `opts.matterId` short-circuits
 * it (the in-app Assistant already knows), so the extra lookup only happens
 * on the connector path.
 */
async function matterIdForTool(supabase, name, args = {}, opts = {}) {
  if (typeof opts.matterId === 'string' && opts.matterId) return opts.matterId;
  for (const key of SEAL_MATTER_ARGS) {
    const v = args[key];
    if (typeof v !== 'string' || !v) continue;
    try {
      const m = await resolveMatter(supabase, v);
      if (m?.id) return m.id;
    } catch { /* an unresolvable name is the handler's error to report, not ours */ }
  }
  const docs = documentIdsIn(args);
  if (docs.length) {
    try {
      const { data } = await supabase
        .from('documents').select('matterspace_id').in('id', docs).limit(1);
      if (data?.[0]?.matterspace_id) return data[0].matterspace_id;
    } catch { /* ignore */ }
  }
  // The task board: a connection's call on one of ITS tasks belongs to that
  // task's matter Record. A task assigned to some other token or grant is not
  // looked up further — the call is refused, and goes on the account chain.
  const taskFor = typeof opts.agentToken?.id === 'string'
    ? { kind: 'token', id: opts.agentToken.id }
    : taskRecipientOf(opts);
  if (AGENT_TASK_TOOLS.has(name) && taskFor
      && typeof args.task_id === 'string' && UUID_RE.test(args.task_id)) {
    try {
      const col = taskRecipientColumn(taskFor);
      const { data } = await supabase
        .from('agent_tasks').select(`matterspace_id, ${col}`)
        .eq('id', args.task_id).maybeSingle();
      if (data?.matterspace_id && data[col] === taskFor.id) {
        return data.matterspace_id;
      }
    } catch { /* ignore */ }
  }
  return null;
}

async function recordToolInvoked(supabase, name, args, opts, outcome) {
  try {
    const matterId = await matterIdForTool(supabase, name, args, opts);
    // 072: a call that reached beyond one matter. Either it resolved to no
    // matter at all — a connector's `search` with `matter` omitted, or
    // list_matters — in which case it goes on the caller's own account
    // chain; or it returned passages from matters other than this one, in
    // which case each of those matters gets a row of its own saying so.
    // Counts only on the account row, this matter's own count on each
    // matter row: no matter's Record ever mentions another. See lib/ledger.mjs.
    await recordCrossMatter(supabase, {
      tool: name, args, result: outcome.result ?? null,
      actor: opts.actor ?? null,
      sessionId: opts.actor?.session_id ?? opts.sessionId ?? null,
      primaryMatterId: matterId,
      connector: opts.sealConnector === true,
      excludeMatterIds: opts.excludeMatterIds ?? null,
      ok: outcome.ok === true, refused: outcome.refused ?? null,
      ms: outcome.ms ?? null, error: outcome.error ?? null,
    });
    if (!matterId) return;   // a matter-less call has no matter Record to go in
    const actor = opts.actor ?? null;
    await record(supabase, {
      kind: 'tool.invoked',
      matterId,
      sessionId: actor?.session_id ?? opts.sessionId ?? null,
      actor,
      payload: {
        tool: name,
        // An ALLOW-list, not redact()'s deny-list: a tool's arguments are
        // named by whoever wrote the tool, so only ids, enums, numbers and
        // booleans survive and every other string becomes its length. See
        // redactToolArgs in lib/ledger.mjs.
        args: redactToolArgs(args),
        document_ids: documentIdsIn(args),
        connector: opts.sealConnector === true,
        connector_client_id: actor?.kind === 'connector' ? (actor.ref ?? null) : null,
        charter_id: actor?.kind === 'charter' ? (actor.ref ?? null) : null,
        ok: outcome.ok === true,
        refused: outcome.refused ?? null,
        ms: outcome.ms ?? null,
        // A handler is free to quote an argument back at us; the shaped args
        // above would then be undone by the error beside them.
        ...(outcome.error
          ? { error: scrubArgValues(outcome.error, args).slice(0, 200) }
          : {}),
      },
    });
  } catch {
    // The Record is never the reason a tool call fails.
  }
}

async function dispatchTool(supabase, name, args = {}, opts = {}) {
  switch (name) {
    case 'list_matters':         return handleListMatters(supabase, args, opts);
    case 'list_matter_contents': return handleListMatterContents(supabase, args);
    case 'search':               return handleSearch(supabase, args, opts);
    case 'get_passage':          return handleGetPassage(supabase, args);
    case 'get_outline':          return handleGetOutline(supabase, args);
    case 'grep':                 return handleGrep(supabase, args, opts);
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
    case 'my_tasks':             return handleMyTasks(supabase, args, opts);
    case 'claim_task':           return handleClaimTask(supabase, args, opts);
    case 'ask_human':            return handleAskHuman(supabase, args, opts);
    case 'post_result':          return handlePostResult(supabase, args, opts);
    default:                     throw new Error(`Unknown tool: ${name}`);
  }
}


// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// list_matters — the map of the workspace
// -----------------------------------------------------------------------------
// Measured in production on 2026-09-20 through a claude.ai connector: 296
// matters answered with 112,790 characters of pretty-printed JSON — one
// object per matter, each carrying its description and a repeated copy of its
// serverspace. The client refused to load it and spilled it to a file; the
// in-app assistant truncated it at TOOL_RESULT_CHAR_CAP. A map that does not
// fit in the context it exists to orient is not a map.
//
// The default is therefore a TREE: one line per matter under its serverspace
// and its parent, carrying the four things the rest of the toolset needs —
// name, short_code, how many documents are filed in it, and its id. No
// descriptions, no repeated serverspace objects, no pretty-print padding.
// `format: 'full'` returns the old array of objects, unchanged, for callers
// that parse fields rather than read.

const TREE_DESC_CHARS = 180;      // a description line, trimmed to a sentence or two
const TREE_QUERY_CHARS = 200;     // longest substring filter we will consider
const TREE_CHAR_BUDGET = 80_000;  // ~20k tokens: the last stop before a client refuses
const COUNT_BATCH = 8;            // document counts, a few at a time

/**
 * Read list_matters' arguments defensively. Everything is optional, anything
 * malformed is ignored rather than argued with, and nothing here reaches a
 * query unparsed: `serverspace` is matched in memory against the serverspace
 * rows we already read, `parent` goes through resolveMatter like every other
 * matter argument, and `query` is a JavaScript substring test.
 */
function listMattersView(args = {}) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const str = (v, max) => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t ? t.slice(0, max) : null;
  };
  return {
    format: a.format === 'full' ? 'full' : 'tree',
    serverspace: str(a.serverspace, 200),
    parent: str(a.parent, 200),
    query: str(a.query, TREE_QUERY_CHARS),
    descriptions: a.include_descriptions === true,
  };
}

/**
 * The seal and the pause, applied to a TREE.
 *
 * `excludeMatterIds` already carries each hidden matter's descendants
 * (sealedMatterIds / pausedMatterIds both walk `matterspace_descendants`).
 * This walks the parent chain as well, so a child stays hidden even if that
 * walk came back short — the #181 leak class, from both ends: a child nested
 * under a hidden parent, and a hidden child under a visible parent. A parent
 * that is merely invisible to RLS does not hide anyone; a cycle fails closed.
 */
function visibleMatters(rows, excludeMatterIds) {
  // An agent's hidden set (AgentScopeHidden) hides everything outside its
  // grant — including a granted sub-matter's own PARENT. Walking the parent
  // chain against that set would hide the granted child with it, so the grant
  // is applied by membership (it already lists every descendant) and only the
  // denied part (sealed, paused) takes the chain walk below.
  if (excludeMatterIds instanceof AgentScopeHidden) {
    return visibleMatters(rows, excludeMatterIds.deny)
      .filter((r) => excludeMatterIds.allowed.has(r.id));
  }
  const hidden = excludeMatterIds && typeof excludeMatterIds.has === 'function'
    ? excludeMatterIds : null;
  if (!hidden || hidden.size === 0) return rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cache = new Map();
  const hiddenChain = (id, seen) => {
    if (!id) return false;
    if (cache.has(id)) return cache.get(id);
    if (hidden.has(id)) { cache.set(id, true); return true; }
    if (seen.has(id)) return true;            // a cycle in the tree fails closed
    seen.add(id);
    const row = byId.get(id);
    const v = row ? hiddenChain(row.parent_matterspace_id, seen) : false;
    seen.delete(id);
    cache.set(id, v);
    return v;
  };
  return rows.filter((r) => !hiddenChain(r.id, new Set()));
}

/** A matter and everything under it, out of an already-visible set. */
function subtreeOf(rows, rootId) {
  if (!rows.some((r) => r.id === rootId)) return [];
  const kept = new Set([rootId]);
  // Parents always precede their children in no particular order here, so
  // sweep until the set stops growing (depth is small; matters nest 2–3 deep).
  for (let pass = 0; pass < 64; pass += 1) {
    let grew = false;
    for (const r of rows) {
      if (kept.has(r.id)) continue;
      if (r.parent_matterspace_id && kept.has(r.parent_matterspace_id)) { kept.add(r.id); grew = true; }
    }
    if (!grew) break;
  }
  return rows.filter((r) => kept.has(r.id));
}

/** Matters whose name or short_code contains `q`, plus their ancestors and descendants. */
function matchQuery(rows, q) {
  const needle = q.toLowerCase();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hit = rows.filter((r) => (
    (r.name || '').toLowerCase().includes(needle) ||
    (r.short_code || '').toLowerCase().includes(needle)
  ));
  const kept = new Set();
  for (const r of hit) {
    for (const d of subtreeOf(rows, r.id)) kept.add(d.id);
    let cur = r.parent_matterspace_id ? byId.get(r.parent_matterspace_id) : null;
    for (let depth = 0; cur && depth < 64; depth += 1) {
      if (kept.has(cur.id)) break;
      kept.add(cur.id);
      cur = cur.parent_matterspace_id ? byId.get(cur.parent_matterspace_id) : null;
    }
  }
  return rows.filter((r) => kept.has(r.id));
}

/**
 * How many documents are filed in each of these matters. Per matter, never
 * rolled up: a visible parent's number must not count a hidden child's
 * documents, which is why this runs AFTER the seal has pruned the list — a
 * hidden matter's id never reaches a `documents` query at all.
 */
async function matterDocumentCounts(supabase, rows) {
  const counts = new Map();
  for (let i = 0; i < rows.length; i += COUNT_BATCH) {
    const slice = rows.slice(i, i + COUNT_BATCH);
    const got = await Promise.all(slice.map(async (m) => {
      const { count } = await supabase
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .eq('matterspace_id', m.id);
      return [m.id, count || 0];
    }));
    for (const [id, n] of got) counts.set(id, n);
  }
  return counts;
}

const byName = (a, b) => String(a || '').localeCompare(String(b || ''), 'en', { numeric: true, sensitivity: 'base' });

function oneLineDescription(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > TREE_DESC_CHARS ? `${t.slice(0, TREE_DESC_CHARS - 1)}…` : t;
}

/** serverspace → matter → sub-matter, one line each. */
function renderMatterTree(rows, { spaceById, counts, descriptions, filtered }) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map();
  const roots = [];
  for (const r of rows) {
    const parentId = r.parent_matterspace_id && byId.has(r.parent_matterspace_id)
      ? r.parent_matterspace_id : null;
    if (parentId) {
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(r);
    } else {
      roots.push(r);
    }
  }
  for (const list of children.values()) list.sort((a, b) => byName(a.name, b.name));

  const groups = new Map();
  for (const r of roots) {
    const key = r.serverspace_id ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const headings = [...groups.keys()].sort((a, b) => byName(
    spaceById.get(a)?.name ?? a, spaceById.get(b)?.name ?? b,
  ));

  const lines = [];
  let chars = 0;
  let shown = 0;
  let truncated = false;
  const emit = (text) => {
    if (truncated) return false;
    if (chars + text.length + 1 > TREE_CHAR_BUDGET) { truncated = true; return false; }
    lines.push(text);
    chars += text.length + 1;
    return true;
  };
  const walk = (m, depth) => {
    if (truncated) return;
    const bits = [
      m.name || '(untitled)',
      m.short_code || '-',
      String(counts.get(m.id) ?? 0),
      m.id,
    ];
    let line = `${'  '.repeat(depth + 1)}${bits.join(' | ')}`;
    // A sub-matter whose parent is not on this list. Inside a branch or a
    // query that is ordinary; in the whole-workspace map it means the parent
    // is one RLS does not show this caller, and saying so beats implying the
    // matter is top-level.
    if (depth === 0 && m.parent_matterspace_id && !filtered) line += ' | (sub-matter; parent not listed)';
    if (descriptions) {
      const d = oneLineDescription(m.description);
      if (d) line += ` :: ${d}`;
    }
    if (!emit(line)) return;
    shown += 1;
    for (const c of children.get(m.id) ?? []) walk(c, depth + 1);
  };

  for (const key of headings) {
    const group = groups.get(key).sort((a, b) => byName(a.name, b.name));
    const name = spaceById.get(key)?.name ?? (key ? `serverspace ${key}` : '(no serverspace)');
    if (!emit(`${name}`)) break;
    for (const r of group) walk(r, 0);
    if (truncated) break;
  }

  return { text: lines.join('\n'), shown, truncated };
}

export async function handleListMatters(supabase, args = {}, opts = {}) {
  const view = listMattersView(args);

  const { data: matters, error } = await supabase
    .from('matterspaces')
    .select('id, name, short_code, description, serverspace_id, parent_matterspace_id, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`list_matters: ${error.message}`);

  // Serverspace names let agents route requests phrased as "in my Admin
  // serverspace" (create_matter / move_document) without a separate tool.
  const { data: spaces } = await supabase.from('serverspaces').select('id, name');
  const spaceList = spaces ?? [];
  const spaceById = new Map(spaceList.map((s) => [s.id, s]));

  // The seal and the pause come first, before any narrowing and before the
  // counts: everything downstream then works on a list that no hidden matter
  // is on.
  let scoped = visibleMatters(Array.isArray(matters) ? matters : [], opts.excludeMatterIds);

  if (view.serverspace) {
    const wanted = view.serverspace.toLowerCase();
    const space = spaceList.find((s) => s.id === view.serverspace)
      ?? spaceList.find((s) => String(s.name ?? '').toLowerCase() === wanted)
      ?? spaceList.find((s) => String(s.name ?? '').toLowerCase().includes(wanted));
    if (!space) {
      const names = spaceList.map((s) => s.name).filter(Boolean).sort(byName).join(', ');
      throw new Error(
        `list_matters: no serverspace matching "${view.serverspace}"` +
        (names ? `. Serverspaces here: ${names}.` : '.'),
      );
    }
    scoped = scoped.filter((m) => m.serverspace_id === space.id);
  }
  if (view.parent) {
    const parent = await resolveMatter(supabase, view.parent);
    scoped = subtreeOf(scoped, parent.id);
  }
  if (view.query) scoped = matchQuery(scoped, view.query);

  const counts = await matterDocumentCounts(supabase, scoped);

  if (view.format === 'full') {
    return scoped.map((m) => ({
      id: m.id,
      short_code: m.short_code,
      name: m.name,
      description: m.description,
      serverspace: spaceById.get(m.serverspace_id) ?? { id: m.serverspace_id },
      parent_matterspace_id: m.parent_matterspace_id,
      document_count: counts.get(m.id) ?? 0,
    }));
  }

  const filtered = Boolean(view.serverspace || view.parent || view.query);
  const tree = renderMatterTree(scoped, {
    spaceById, counts, descriptions: view.descriptions, filtered,
  });

  return {
    format: 'tree',
    legend:
      'One line per matter: name | short_code | documents | id. Indent = sub-matter. ' +
      'Documents are the ones filed in that matter itself, never its sub-matters. ' +
      'Pass the short_code or the id to any tool that takes a matter, a parent or a destination. ' +
      'A matter with no short_code shows "-" there; use its id.' +
      (view.descriptions ? ' "::" introduces the matter\'s description.' : ''),
    matter_count: scoped.length,
    // The account-chain row reads this key (lib/ledger.mjs): how much came
    // back, as a count, with no matter named. Counts only.
    result_count: tree.shown,
    serverspace_count: new Set(scoped.map((m) => m.serverspace_id ?? '')).size,
    ...(filtered ? {
      scope: {
        ...(view.serverspace ? { serverspace: view.serverspace } : {}),
        ...(view.parent ? { parent: view.parent } : {}),
        ...(view.query ? { query: view.query } : {}),
      },
    } : {}),
    ...(tree.truncated ? {
      truncated: true,
      not_shown: scoped.length - tree.shown,
      hint: 'Too large to send whole. Narrow it with serverspace, parent or query.',
    } : {}),
    ...(view.descriptions ? {} : {
      more: 'Descriptions are omitted. For one branch with them: parent:"<short_code>", include_descriptions:true.',
    }),
    tree: tree.text || '(no matters are visible here.)',
  };
}

// Until 2026-09-24 this returned whatever one unpaginated select returned —
// and PostgREST stops at 1,000 rows, so on DeCamara v. Bryn Mawr it said
// "document_count: 1000" and every document past the thousandth was
// invisible, with nothing saying so (reported from the brief). Now: pages of
// `limit` (default and max 1,000) from `offset`, the TRUE total, a
// `next_offset` while more remain, and a `sort` an agent can ask for.
const LIST_SORTS = Object.freeze({
  type: [['doc_type', true], ['volume_number', true], ['deposition_date', true], ['title', true]],
  title: [['title', true]],
  created_at_desc: [['created_at', false]],
  created_at_asc: [['created_at', true]],
});

export async function handleListMatterContents(supabase, args) {
  if (!args.matter) throw new Error('matter is required');
  const matter = await resolveMatter(supabase, args.matter);
  const limit = Math.min(1000, Math.max(1, Number(args.limit) || 1000));
  const offset = Math.max(0, Number(args.offset) || 0);
  const sortKey = Object.hasOwn(LIST_SORTS, args.sort ?? '') ? args.sort : 'type';
  let q = supabase
    .from('documents')
    .select(
      'id, title, doc_type, witness_name, deposition_date, volume_number, ' +
      'exhibit_number, bates_prefix, bates_start, bates_end, page_count, ' +
      'author, publisher, processing_status, created_at, source_filename',
      { count: 'exact' },
    )
    .eq('matterspace_id', matter.id);
  for (const [col, asc] of LIST_SORTS[sortKey]) q = q.order(col, { ascending: asc, nullsFirst: true });
  // `id` last: a stable order, so paging never skips or repeats a row.
  const { data: docs, error, count } = await q.order('id', { ascending: true }).range(offset, offset + limit - 1);
  if (error) throw new Error(`list_matter_contents: ${error.message}`);
  const total = typeof count === 'number' ? count : offset + docs.length;
  const nextOffset = offset + docs.length < total ? offset + docs.length : null;

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
    // `document_count` is the matter's true total; `returned` is this page.
    document_count: total,
    returned: docs.length,
    offset,
    sort: sortKey,
    next_offset: nextOffset,
    ...(nextOffset !== null && {
      more: `${total - nextOffset} more document(s): call again with offset: ${nextOffset}.`,
    }),
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
    // A DESCENDANT can be excluded while its parent is not: a sealed
    // sub-matter inside an open one, or (2026-09-20) a paused sub-matter
    // inside a running one. The named matter passed the gate in callTool;
    // the tree it expands to has not. Without this line, searching the parent
    // returns the excluded child's passages — the one thing both the seal and
    // the pause exist to prevent. The all-matters branch below has always
    // filtered; this branch never did.
    if (opts.excludeMatterIds?.size) {
      matterIds = matterIds.filter((id) => !opts.excludeMatterIds.has(id));
      if (matterIds.length === 0) {
        return { query: args.q, scope: matter.name ?? 'matter', result_count: 0, results: [] };
      }
    }
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
      // The parked endpoint is a typed answer from the route and is said in
      // its own words; anything else is an outage and says so.
      embedFailNote = (isEmbedRouteUnavailable(err)
        ? `${err.message} So `
        : `The ${route.model} embedding step failed (${String(err.message).slice(0, 120)}), so `) +
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
    // ONE call per route over every matter in it, not a fan-out of 12-matter
    // batches.
    //
    // The fan-out was right before migration 078 and wrong after it. Measured
    // 2026-09-24 as the real connector role, 312 matters, 438k passages:
    //
    //   27 batches in parallel      10–14 s, 11–15 of 27 batches 57014 → skipped
    //   27 batches one at a time    37 s of database work, none failed
    //   one call, 310 matters       0.86 s cold, 0.17 s warm, none failed
    //
    // A 12-matter batch is under search_passages' 15,000-passage threshold, so
    // each one runs the EXACT vector scan over its matters — 27 exact scans
    // add up to the whole table, and in parallel on this instance every one
    // of them slows past the 8 s timeout together. One call over all of them
    // is over the threshold and takes the HNSW branch, which 078 made
    // reachable for the authenticated role; before 078 that branch
    // collapsed to brute force under RLS, and this comment used to say one
    // RPC over everything timed out. It no longer does.
    //
    // The cost is HNSW recall. Against the exact scan, same day, top-10
    // agreement was 10/10 on six of eight legal queries, 7/10 on one, and
    // 0/10 on the bare name "Sterling" — where the exact nearest neighbours
    // were loose semantic matches and the keyword half surfaces passages that
    // actually say "Sterling". A single large matter already accepts that
    // trade (074); a search that silently dropped half the matters was worse.
    //
    // If the one call fails anyway (a cold index after idle, a bigger corpus
    // than today's), that group falls back to the old batches — at most
    // FALLBACK_CONCURRENCY at a time, so they queue instead of timing each
    // other out.
    const BATCH = 12;
    const FALLBACK_CONCURRENCY = 4;
    const call = (ids, g) => supabase.rpc('search_passages', rpcParams(ids, g.embedding, g.model));
    const searchGroup = async (g) => {
      const whole = await call(g.ids, g);
      if (!whole.error) return [whole];
      const chunks = [];
      for (let i = 0; i < g.ids.length; i += BATCH) chunks.push(g.ids.slice(i, i + BATCH));
      const out = [];
      let next = 0;
      const lane = async () => {
        while (next < chunks.length) out.push(await call(chunks[next++], g));
      };
      await Promise.all(Array.from({ length: Math.min(FALLBACK_CONCURRENCY, chunks.length) }, lane));
      return out;
    };
    const settled = (await Promise.all(groups.map(searchGroup))).flat();
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
        `${failed.length} of ${settled.length} matter groups failed and were skipped ` +
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

  // One query, for the ids this search is returning and no others. The RPC
  // cannot carry `passages.metadata` (fixed return type), and that is where
  // the reporter's printed page lives.
  const metaById = await fetchPassageMetadata(supabase, data.map((r) => r.passage_id));

  // Thread messages (migration 091), through the AI door only. Document
  // filters name documents, and a message is not one, so a filtered search
  // does not reach the thread at all.
  const documentFiltered = Boolean(args.document_ids?.length || args.doc_types?.length || args.witnesses?.length);
  const thread = documentFiltered
    ? { rows: [], note: null }
    : await searchCorrespondenceForAi(supabase, matterIds, args.q, limit);
  if (thread.note) partialNote = [partialNote, thread.note].filter(Boolean).join(' ');

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
      // null when the metadata query found nothing, was not needed, or failed
      // — and then the row is exactly the row the RPC returned.
      const row = { ...r, metadata: metaById.get(r.passage_id) ?? null };
      const basis = pageBasis(citePage(row));
      const out = {
        ...(rMatter ? { matter: { id: rMatter.id, short_code: rMatter.short_code, name: rMatter.name } } : {}),
        passage_id: r.passage_id,
        document_id: r.document_id,
        document_title: r.document_title,
        doc_type: r.doc_type,
        citation: formatCitation(row),
        // `coordinates` keeps naming the columns as stored — page_start is
        // still the PDF's page. `page_basis` (present only where something is
        // known) says which number the citation above is showing and which
        // one opens the file.
        coordinates: {
          page_start: r.page_start,
          page_end: r.page_end,
          line_start: r.line_start,
          line_end: r.line_end,
        },
        ...(basis ? { page_basis: basis } : {}),
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
    ...(thread.rows.length
      ? { correspondence: thread.rows.map((m) => correspondenceResult(m, fullText)) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Matter conversations (migration 091) — the AI door.
//
// EVERY path through this file is an AI path: the hosted connector, the
// in-app assistant and the agents all reach search/grep through callTool, and
// so does /api/sandbox. So these helpers call ONLY the database functions
// whose names end in _for_ai, which return a message only when its
// conversation's "AI may read this" switch is on, only where the caller is in
// the conversation's audience (RLS), and never from a sealed or paused matter
// or one beneath it — and the id array handed to them is already cut by
// opts.excludeMatterIds. The person's own search (the Thread tab, the Vault
// box) calls public.search_conversations from the browser and never passes
// through here. scripts/_verify-matter-conversations.mjs fails the build if
// this file ever names the non-AI function or reads the tables directly.
// ---------------------------------------------------------------------------
const THREAD_FN_MISSING = /PGRST202|could not find the function|does not exist|42883/i;

async function threadRpcForAi(supabase, fn, params) {
  try {
    const res = await supabase.rpc(fn, params);
    if (!res || typeof res !== 'object') return { rows: [], note: null };
    const { data, error } = res;
    if (error) {
      // Before 091 is applied the function does not exist: say nothing, and
      // the answer is exactly what it was.
      if (THREAD_FN_MISSING.test(`${error.code ?? ''} ${error.message ?? ''}`)) return { rows: [], note: null };
      return { rows: [], note: `Thread messages could not be searched (${String(error.message).slice(0, 120)}).` };
    }
    return { rows: Array.isArray(data) ? data : [], note: null };
  } catch (err) {
    return { rows: [], note: `Thread messages could not be searched (${String(err?.message ?? err).slice(0, 120)}).` };
  }
}

async function searchCorrespondenceForAi(supabase, matterIds, q, limit) {
  if (!matterIds?.length || typeof q !== 'string' || !q.trim()) return { rows: [], note: null };
  return threadRpcForAi(supabase, 'search_conversations_for_ai', {
    p_matterspace_ids: matterIds,
    p_query: q,
    p_limit: Math.min(Math.max(1, Number(limit) || 5), 20),
  });
}

async function grepCorrespondenceForAi(supabase, matterIds, { pattern, useRegex, caseSensitive }) {
  if (!matterIds?.length || typeof pattern !== 'string' || !pattern) return { rows: [], note: null };
  return threadRpcForAi(supabase, 'grep_conversations_for_ai', {
    p_matterspace_ids: matterIds,
    p_pattern: pattern,
    p_regex: useRegex,
    p_case_sensitive: caseSensitive,
    p_limit: 200,
  });
}

/** The text a thread message is searched and grepped as: its subject line
 *  (a pasted email's) above its body — the same string the database's grep
 *  branch matches against. */
function correspondenceText(m) {
  return `${m.email_subject ?? ''}\n${m.body ?? ''}`;
}

function correspondenceHeader(m) {
  return {
    comment_id: m.comment_id,
    conversation: { id: m.conversation_id, title: m.conversation_title },
    matter: { id: m.matterspace_id, name: m.matter_name ?? null },
    kind: m.kind,
    citation: conversationCitation(m),
    author: m.author_name ?? null,
    posted_at: m.created_at,
    ...(m.kind === 'email'
      ? { email: { from: m.email_from ?? null, to: m.email_to ?? null, cc: m.email_cc ?? null,
        subject: m.email_subject ?? null, date: m.email_date ?? null } }
      : {}),
  };
}

function correspondenceResult(m, fullText) {
  const text = m.body ?? '';
  const out = { ...correspondenceHeader(m), text_full_length: text.length };
  if (fullText || text.length <= PREVIEW_CHARS) out.text = text;
  else {
    out.text_preview = text.slice(0, PREVIEW_CHARS);
    out.text_truncated = true;
  }
  return out;
}

export async function handleGetPassage(supabase, args) {
  if (!args.id) throw new Error('id is required');

  const { data: p, error } = await supabase
    .from('passages')
    .select(
      'id, document_id, matterspace_id, sequence_number, ' +
      'page_start, page_end, line_start, line_end, ' +
      'witness_name, examination_type, speaker, ' +
      // metadata carries the reporter's printed page (PR #205) and the
      // line_numbers flag (#138). This select already names its columns, so
      // it costs no extra round trip — unlike search and grep, which need one.
      'text, passage_type, parent_passage_id, summary_level, metadata'
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

  const basis = pageBasis(citePage(p));

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
      ...(basis ? { page_basis: basis } : {}),
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


// ---------------------------------------------------------------------------
// grep: finding the candidate passages without timing out
// ---------------------------------------------------------------------------
//
// Until 2026-09-24 grep was one query: every passage in the matter tree,
// filtered with ILIKE (no index can serve a %substring%), ORDER BY document
// and sequence, LIMIT 2000. On DeCamara v. Bryn Mawr (46 matters, 53,734
// passages) that read every passage's text and took 60 s — the statement
// timeout cancelled it every time (reported from the brief, 2026-09-24).
// Three routes now, fastest first:
//   1. one document named: its passages, by the document index;
//   2. a literal with words in it: the full-text index narrows to passages
//      holding those words as a phrase, and the exact substring confirms
//      (DeCamara: 60 s → 1.1 s);
//   3. otherwise (a regex, a fragment of a word, or the index found nothing):
//      the matter's documents in batches, several at once, under a time
//      budget — and if the budget runs out the answer says the scan was
//      incomplete instead of failing or pretending it looked everywhere.
const GREP_CANDIDATE_CAP = 2000;
const GREP_SCAN_BUDGET_MS = 40_000;
const GREP_DOC_BATCH = 120;
const GREP_PARALLEL = 6;
const GREP_COLS = 'id, document_id, matterspace_id, sequence_number, page_start, page_end, line_start, text';

function grepFilter(q, { pattern, useRegex, caseSensitive }) {
  if (useRegex) return q.filter('text', caseSensitive ? 'match' : 'imatch', pattern);
  if (caseSensitive) return q.like('text', `%${escapeLikePattern(pattern)}%`);
  return q.ilike('text', `%${escapeLikePattern(pattern)}%`);
}

// Reading order, as the single query used to return it.
function sortPassages(rows) {
  return rows.sort((a, b) => (a.document_id < b.document_id ? -1 : a.document_id > b.document_id ? 1
    : (a.sequence_number ?? 0) - (b.sequence_number ?? 0)));
}

export async function grepCandidates(supabase, { matterIds, doc, pattern, useRegex, caseSensitive }) {
  const f = { pattern, useRegex, caseSensitive };
  // summary_level = 0: raw passages only, so text that also appears in a
  // summarised rollup is not counted twice.
  if (doc) {
    const { data, error } = await grepFilter(
      supabase.from('passages').select(GREP_COLS).eq('document_id', doc).eq('summary_level', 0), f,
    ).limit(GREP_CANDIDATE_CAP);
    if (error) throw new Error(`grep: ${error.message}`);
    return { candidates: sortPassages(data ?? []), scan: { method: 'document' } };
  }

  if (!useRegex && /[\p{L}\p{N}]{2,}/u.test(pattern)) {
    const { data, error } = await grepFilter(
      supabase.from('passages').select(GREP_COLS)
        .in('matterspace_id', matterIds).eq('summary_level', 0)
        .textSearch('tsv', pattern, { type: 'phrase', config: 'english' }), f,
    ).limit(GREP_CANDIDATE_CAP);
    // Nothing from the index can still mean a fragment of a word ("judg") or
    // a pattern of stopwords, which the index does not hold: scan for those.
    if (!error && data && data.length > 0) {
      return { candidates: sortPassages(data), scan: { method: 'index' } };
    }
  }

  // The documents in scope, then their passages a batch at a time.
  const docIds = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('documents').select('id')
      .in('matterspace_id', matterIds).order('id').range(from, from + 999);
    if (error) throw new Error(`grep: ${error.message}`);
    docIds.push(...(data ?? []).map((d) => d.id));
    if (!data || data.length < 1000) break;
  }
  const batches = [];
  for (let i = 0; i < docIds.length; i += GREP_DOC_BATCH) batches.push(docIds.slice(i, i + GREP_DOC_BATCH));
  const started = Date.now();
  const found = [];
  let scanned = 0;
  let next = 0;
  let stop = false;
  let firstError = null;
  const worker = async () => {
    while (!stop && next < batches.length) {
      if (Date.now() - started > GREP_SCAN_BUDGET_MS) { stop = true; break; }
      const batch = batches[next++];
      const { data, error } = await grepFilter(
        supabase.from('passages').select(GREP_COLS).in('document_id', batch).eq('summary_level', 0), f,
      ).limit(GREP_CANDIDATE_CAP);
      if (error) { firstError ??= error; stop = true; break; }
      found.push(...(data ?? []));
      scanned += batch.length;
      if (found.length >= GREP_CANDIDATE_CAP) stop = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(GREP_PARALLEL, batches.length) }, worker));
  if (firstError && found.length === 0) throw new Error(`grep: ${firstError.message}`);
  const incomplete = scanned < docIds.length && found.length < GREP_CANDIDATE_CAP;
  return {
    candidates: sortPassages(found).slice(0, GREP_CANDIDATE_CAP),
    scan: { method: 'scan', documents_scanned: scanned, documents_total: docIds.length, incomplete },
  };
}

export async function handleGrep(supabase, args, opts = {}) {
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
  let matterIds = (descRows ?? []).map((r) => r.id);
  if (matterIds.length === 0) matterIds.push(matter.id);
  // Same descendant hole as handleSearch, same fix: grep inside an open
  // parent must not read a sealed or paused child.
  if (opts.excludeMatterIds?.size) {
    matterIds = matterIds.filter((id) => !opts.excludeMatterIds.has(id));
    if (matterIds.length === 0) {
      return {
        pattern: args.pattern,
        matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
        document_count: 0, passage_count: 0, match_count: 0, returned: 0,
        truncated: false, matches: [],
      };
    }
  }

  const { candidates, scan } = await grepCandidates(supabase, {
    matterIds, doc: args.doc, pattern: args.pattern, useRegex, caseSensitive,
  });

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

  // Hits are collected first and cited afterwards, so the citations can be
  // built from one metadata query over the passages that actually matched
  // rather than one per hit or one over all 2000 candidates.
  const hits = [];
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
      if (hits.length >= maxMatches) continue;
      const beforeStart = Math.max(0, pos.start - contextChars);
      const afterEnd = Math.min(text.length, pos.start + pos.length + contextChars);
      // How far down the PASSAGE the hit falls. On a transcript passage whose
      // lines were read off the page this converts to a real line number; on
      // prose it is a count of newlines in a chunk and names nothing, which is
      // why it no longer reaches the citation.
      const lineWithin = countNewlinesBefore(text, pos.start) + 1;
      hits.push({
        passage: p,
        doc: docsById.get(p.document_id) ?? null,
        lineWithin,
        before: text.slice(beforeStart, pos.start),
        match: text.slice(pos.start, pos.start + pos.length),
        after: text.slice(pos.start + pos.length, afterEnd),
      });
    }
  }

  // ONE query, for the passages that matched — never per hit, never for the
  // candidates that produced nothing. A failure here costs the printed page
  // and the inferred-lines check, not the grep.
  const grepMeta = await fetchPassageMetadata(supabase, hits.map((h) => h.passage.id));

  const matches = hits.map(({ passage: p, doc, lineWithin, before, match, after }) => {
    const row = { ...p, metadata: grepMeta.get(p.id) ?? null };
    // A line number is cited only where the reporter printed one. Prose has no
    // line_start at all, and a transcript indexed with `line_numbers:
    // 'inferred'` (PR #138) has numbers the chunker counted by position —
    // neither is a coordinate a witness can be taken to, and grep's own
    // newline count on top of them would compound the guess. Until this
    // branch, every grep hit on a memo was cited "p. 3:1".
    const printedLines = hasPrintedLineNumbers(row);
    const absLine = printedLines ? p.line_start + lineWithin - 1 : null;
    const basis = pageBasis(citePage(row));
    return {
      passage_id: p.id,
      document_id: p.document_id,
      document_title: doc?.title ?? null,
      citation: formatCitation({
        ...row,
        line_start: absLine,
        line_end: absLine,
        witness_name: doc?.witness_name ?? null,
        volume_number: doc?.volume_number ?? null,
        document_title: doc?.title ?? null,
        doc_type: doc?.doc_type ?? null,
      }),
      page: p.page_start,
      line: absLine,
      ...(basis ? { page_basis: basis } : {}),
      before,
      match,
      after,
    };
  });

  const candidatesTruncated = candidates.length >= 2000;

  // Thread messages (migration 091), AI door only; a grep scoped to one
  // document (`doc`) is about that document and does not reach the thread.
  const thread = args.doc
    ? { rows: [], note: null }
    : await grepCorrespondenceForAi(supabase, matterIds, { pattern: args.pattern, useRegex, caseSensitive });
  const correspondenceMatches = [];
  let correspondenceMatchCount = 0;
  for (const m of thread.rows) {
    const text = correspondenceText(m);
    const positions = [];
    if (regex) {
      regex.lastIndex = 0;
      let hit;
      while ((hit = regex.exec(text)) !== null) {
        positions.push({ start: hit.index, length: hit[0].length });
        if (hit[0].length === 0) regex.lastIndex++;
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
      correspondenceMatchCount++;
      if (correspondenceMatches.length >= maxMatches) continue;
      correspondenceMatches.push({
        ...correspondenceHeader(m),
        before: text.slice(Math.max(0, pos.start - contextChars), pos.start),
        match: text.slice(pos.start, pos.start + pos.length),
        after: text.slice(pos.start + pos.length, Math.min(text.length, pos.start + pos.length + contextChars)),
      });
    }
  }

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
    // How the passages were found, and — when the time budget ran out before
    // every document was read — that the answer is partial. "No matches" from
    // an incomplete scan is not "not in the matter".
    search_method: scan.method,
    ...(scan.incomplete && {
      scan_incomplete: true,
      scan_note:
        `Only ${scan.documents_scanned} of ${scan.documents_total} documents were read before the time limit. ` +
        'Narrow the scope (a sub-matter, or `doc: <uuid>`), or use whole words so the full-text index can be used.',
    }),
    ...(candidatesTruncated && {
      hint:
        'More than 2000 passages matched at the SQL level — narrow the ' +
        'pattern or scope to a single doc with `doc: <uuid>`. The match ' +
        'set you see only reflects the first 2000 candidate passages.',
    }),
    matches,
    ...(correspondenceMatches.length
      ? {
        correspondence_match_count: correspondenceMatchCount,
        correspondence_matches: correspondenceMatches,
      }
      : {}),
    ...(thread.note ? { correspondence_note: thread.note } : {}),
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
    // A parked sealed endpoint (400 NO_SUCH_ENDPOINT) is a typed answer the
    // search path degrades on gracefully; every other status is an error.
    const parked = typeof route.unavailable === 'function' ? route.unavailable(res.status, body) : null;
    if (parked) throw new EmbedRouteUnavailableError(route, parked);
    throw new Error(`embed: ${res.status} ${body.slice(0, 400)}`);
  }
  const [embedding] = route.parse(await res.json());
  return embedding;
}

export function formatCitation(row) {
  const docTitle = row.document_title || 'Document';
  const docType = row.doc_type;
  // A Westlaw opinion's passage carries its full Bluebook cite, pinpoint
  // included (lib/bluebook.mjs, written with its star pages). It is the cite.
  const bb = typeof row.metadata === 'object' && row.metadata ? row.metadata.bluebook_cite : null;
  if (typeof bb === 'string' && bb && docType !== 'transcript' && docType !== 'deposition') return bb;
  // The page the cite NAMES. `citePage` returns row.page_start/page_end
  // untouched for a passage that carries no printed-page metadata — which is
  // every passage in the corpus until its document is re-indexed — so the
  // three lines below are byte-for-byte what they were before PR #205.
  const where = citePage(row);
  const page = where.pageStart === where.pageEnd
    ? where.pageStart
    : `${where.pageStart}-${where.pageEnd}`;
  const line = row.line_start
    ? row.line_start === row.line_end
      ? `:${row.line_start}`
      : `:${row.line_start}-${row.line_end}`
    : '';
  // Only ever set in the 'pdf_index_declined' state: the detector looked at
  // this page and would not claim a printed number. A printed page never
  // appears beside a caveat, and a page nothing is known about says nothing
  // new — the standing note at the head of an outline is still its home.
  const caveat = where.caveat ? ` (${where.caveat})` : '';
  if (docType === 'transcript' || docType === 'deposition') {
    return `${docTitle}, ${page}${line}${caveat}`;
  }
  if (docType === 'book') {
    // page_start is the chapter_number (no real pagination in EPUBs).
    // Footnotes carry their own [fn N] marker in the text already.
    return `${docTitle}, Ch. ${page}`;
  }
  return `${docTitle}, p. ${page}${line}${caveat}`;
}

/**
 * `id → metadata` for exactly the passages a handler is about to cite.
 *
 * Why a second query rather than a wider first one: the hybrid-search RPC's
 * return type is fixed in migration 002 and re-declared in 074/078, and those
 * functions were just rebuilt against a statement timeout on a 2.5 GB index.
 * Widening them is a migration and a risk to the one query in this system that
 * must not get slower. So the citation metadata is fetched afterwards, for the
 * ids that actually came back — at most the caller's own result limit — in ONE
 * round trip, through THE SAME client the handler already holds. Same
 * authorization, same RLS, same seal: a passage this client could not have
 * read is not readable here either.
 *
 * It never fails a read. A citation that cannot learn what kind of page number
 * it is holding falls back to the one it has always shown; losing a search
 * because a decoration could not be fetched would be the worse bug.
 */
async function fetchPassageMetadata(supabase, ids) {
  const unique = [...new Set((ids ?? []).filter(Boolean))];
  if (unique.length === 0) return new Map();
  try {
    const { data, error } = await supabase
      .from('passages')
      .select('id, metadata')
      .in('id', unique);
    if (error) return new Map();
    return new Map((data ?? [])
      .filter((r) => r && r.metadata)
      .map((r) => [r.id, r.metadata]));
  } catch {
    return new Map();
  }
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
  const { processDocument, planPdfOcr, needsWorkerIngest, isPdfStructureError, MEDIA_EXTENSIONS, OCRABLE_IMAGE_EXTENSIONS } = await import('./ingest-core.mjs');
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
    const { passageCount, textStatus, ocrPending, embeddingPending, ocr_route: ocrRoute, email_attachments: emailAttachments } = await processDocument(supabase, {
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
    // Vectors owed — the sealed endpoint was parked: searchable by words now,
    // by meaning after the backfill. Said in words so "ready" is not read as
    // fully indexed.
    if (embeddingPending) {
      const d = describeEmbeddingPending(embeddingPending);
      stored = {
        ...stored, embedding_pending: embeddingPending, searchable: passageCount > 0, semantic_search: false,
        note: [stored.note, `${d.label}. ${d.detail}`].filter(Boolean).join(' '),
      };
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
    // A PDF the serverless parser rejected goes to the worker, whose parsers
    // (modern pdfjs among them) read what pdf-parse's 2017 build will not —
    // ten Huddleston cover pages failed here on 2026-09-07 and read fine
    // everywhere else. Only a file the worker rejects too ends in 'error'.
    if (ext === '.pdf' && isPdfStructureError(err)) {
      try {
        const { job_id } = await enqueueIngestJob(supabase, { id: doc.id, matterspace_id: matter.id });
        return {
          document_id: doc.id,
          matter: { id: matter.id, short_code: matter.short_code, name: matter.name },
          source_filename: filename,
          status: 'pending',
          job_id,
          queued: true,
          note: `The PDF could not be read in this run (${msg.slice(0, 80)}); it is stored and queued for the background worker, which reads it with a second parser. Not searchable yet; use check_ingest_status.`,
        };
      } catch { /* the queue failed — record the error as before */ }
    }
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
// `force` (ingest_document force: true) re-runs a READY document: the job
// carries force so the worker does not skip it, and the row stays 'ready' —
// still searchable on its current text — until the worker swaps the new text
// in (lib/reprocess.mjs). A forced request dedupes only against forced jobs:
// an unforced job already queued for a ready document would be skipped.
async function enqueueIngestJob(supabase, doc, { force = false } = {}) {
  const { data: existing } = await supabase.from('processing_jobs')
    .select('id, status, progress, progress_note')
    .eq('job_type', 'ingest_document')
    .in('status', ['queued', 'running'])
    .contains('payload', force ? { document_id: doc.id, force: true } : { document_id: doc.id })
    .limit(1);
  if (existing && existing.length) {
    return { job_id: existing[0].id, deduped: true, job: existing[0] };
  }
  const { data: job, error } = await supabase.from('processing_jobs').insert({
    matterspace_id: doc.matterspace_id,
    job_type: 'ingest_document',
    payload: force ? { document_id: doc.id, force: true } : { document_id: doc.id },
  }).select('id').single();
  if (error) throw new Error(`enqueue: ${error.message}`);
  if (!(force && doc.processing_status === 'ready')) {
    await supabase.from('documents')
      .update({ processing_status: 'pending', processing_error: null })
      .eq('id', doc.id);
  }
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
  // caller wants for either. A ready document that is fully indexed is re-run
  // only on force: until 2026-09-18 it could not be re-run at all, so a
  // document indexed with the wrong text (a scan read as its CM/ECF stamp)
  // could not be repaired through the API.
  const force = args.force === true;
  const readyIndexed = doc.processing_status === 'ready' && !doc.text_status && !doc.ocr_pending;
  if (readyIndexed && !force) {
    return {
      document_id: doc.id,
      source_filename: doc.source_filename,
      status: 'ready',
      note: 'Already ingested and searchable — nothing to do. If its text is wrong (for example its passages hold only a court filing stamp, or every passage cites page 1), call ingest_document again with force: true; the current text stays searchable until the re-run succeeds.',
    };
  }
  const { job_id, deduped } = await enqueueIngestJob(supabase, doc, { force: force && readyIndexed });
  return {
    document_id: doc.id,
    source_filename: doc.source_filename,
    status: 'queued',
    job_id,
    ...(force && readyIndexed ? { forced: true } : {}),
    ...(deduped ? { note: 'Already in the queue; not enqueued twice.' } : {}),
    next: force && readyIndexed
      ? 'Queued for a forced re-run. The document stays searchable on its current text until the new text replaces it; if the re-run fails, the current text is kept. Call check_ingest_status to see progress.'
      : 'The background worker will process it with no time limit. Call check_ingest_status to see progress; typical documents are searchable within a few minutes.',
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
    // Vectors owed (the sealed endpoint was parked when this was indexed):
    // searchable by words now, by meaning once reembed-matter has run.
    const embeddingPending = doc.processing_status === 'ready' ? doc.metadata?.embedding_pending : null;
    if (embeddingPending && typeof embeddingPending === 'object') {
      const d = describeEmbeddingPending(embeddingPending);
      storedNote = {
        ...storedNote, embedding_pending: embeddingPending, searchable: !textStatus, semantic_search: false,
        note: [storedNote.note, `${d.label}. ${d.detail}`].filter(Boolean).join(' '),
      };
    }
    // Which route read the scanned pages, and roughly what it cost (Phase 4).
    const ocrRoute = doc.processing_status === 'ready' ? doc.metadata?.ocr_route : null;
    if (ocrRoute && typeof ocrRoute === 'object') {
      storedNote = { ...storedNote, ocr_route: ocrRoute, ocr_note: describeOcrRoute(ocrRoute) };
    }
    // How a PDF's text was read (2026-09-18): text layer, OCR, or both, and
    // the PDF's own page count. A ready PDF with no record was indexed before
    // the record existed — say so, because that is exactly the population in
    // which a scan indexed as its filing stamp (or collapsed onto "page 1")
    // still hides, and force is how it is repaired.
    if (doc.processing_status === 'ready') {
      const outcome = doc.metadata?.ingest_outcome;
      if (outcome && typeof outcome === 'object') {
        storedNote = { ...storedNote, ingest_outcome: outcome };
      } else if (/\.pdf$/i.test(doc.source_filename || '')) {
        storedNote = {
          ...storedNote,
          ingest_outcome: null,
          ingest_outcome_note: 'No record of how this PDF was read (indexed before 2026-09-18). If its passages hold only a court filing stamp, or all cite page 1, re-run it with ingest_document force: true.',
        };
      }
      const rerun = doc.metadata?.reprocess;
      if (rerun && typeof rerun === 'object') storedNote = { ...storedNote, last_rerun: rerun };
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
  // The assembled exhibit is the filed thing: it goes through the ingest
  // pipeline so it is searchable and citable by ITS page numbers, like any
  // upload. (Until 2026-09-07 it was stored ready with no passages and no
  // recorded reason — the old pdfjs choked on pdf-lib output; that parser
  // now retries, falls back, and hands a refusal to the worker.)
  const filed = await fileGenerated(supabase, args.matter, filename, merged.bytes, {
    title: args.title,
    docType: args.doc_type || 'other',
    ingest: true,
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
      'Merged PDF filed into the matter and indexed by its own page numbers ' +
      '(ingest_status says where it stands). Give download_url to the ' +
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
async function fileGenerated(supabase, matterKey, filename, buf, { title, docType, ingest, pageCount, opts = {}, metadata = {} }) {
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
      // Why this row holds no passages — otherwise "ready" with nothing
      // searchable reads as a failure to the monitor and to the Vault.
      metadata: { text_status: TEXT_STATUS.GENERATED, text_status_at: new Date().toISOString(), ...metadata },
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

// A stored PDF, fetched for editing: its row (RLS decides who may see it),
// its bytes, and the parsed document.
async function loadStoredPdf(supabase, documentId, label) {
  const { data: src, error } = await supabase
    .from('documents')
    .select('id, title, doc_type, matterspace_id, source_filename, storage_path')
    .eq('id', documentId)
    .maybeSingle();
  if (error) throw new Error(`${label}: ${error.message}`);
  if (!src) throw new Error(`${label}: document not found (or not accessible)`);
  if (!src.storage_path) throw new Error(`${label}: this document has no stored original file`);
  const srcName = src.source_filename || src.storage_path;
  if (!srcName.toLowerCase().endsWith('.pdf')) {
    throw new Error(`${label}: "${src.title}" is not a PDF (${srcName})`);
  }

  const { data: blob, error: dlErr } = await supabase.storage
    .from('vault-documents')
    .download(src.storage_path);
  if (dlErr) throw new Error(`${label}: download: ${dlErr.message}`);

  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.load(Buffer.from(await blob.arrayBuffer()), { ignoreEncryption: true });
  return { row: src, pdf };
}

export async function handleEditPdf(supabase, args, opts = {}) {
  if (!args.document_id) throw new Error('edit_pdf: document_id is required');

  const { row: src, pdf } = await loadStoredPdf(supabase, args.document_id, 'edit_pdf');
  const { PDFDocument, degrees } = await import('pdf-lib');
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

  // Pages from other stored PDFs, placed among the kept pages. Each insert
  // names a position in the OUTPUT (1-based; past the end appends) and the
  // pages it brings; inserts sharing a position keep their listed order.
  // Every source is fetched once, however many inserts draw on it.
  const inserts = Array.isArray(args.inserts) ? args.inserts : [];
  const sources = new Map();
  for (const ins of inserts) {
    if (!ins || typeof ins !== 'object' || !ins.document_id || !ins.pages) {
      throw new Error('edit_pdf: each insert needs at, document_id and pages');
    }
    if (!Number.isInteger(ins.at) || ins.at < 1) {
      throw new Error('edit_pdf: insert `at` must be a page position, 1 or more');
    }
    if (ins.degrees != null && ![0, 90, 180, 270].includes(ins.degrees)) {
      throw new Error('edit_pdf: insert degrees must be 0, 90, 180, or 270');
    }
    if (!sources.has(ins.document_id)) {
      sources.set(ins.document_id, await loadStoredPdf(supabase, ins.document_id, 'edit_pdf insert'));
    }
  }

  const out = await PDFDocument.create();
  // One copy call per source keeps what its pages share — fonts, resources —
  // shared in the output too.
  const own = await out.copyPages(pdf, order.map((p) => p - 1));
  const brought = new Map();
  for (const ins of inserts) {
    const source = sources.get(ins.document_id);
    const want = parsePageSpec(ins.pages, source.pdf.getPageCount(), `edit_pdf insert from "${source.row.title}"`);
    const pages = await out.copyPages(source.pdf, want.map((p) => p - 1));
    for (const page of pages) {
      if (ins.degrees) page.setRotation(degrees(((page.getRotation().angle + ins.degrees) % 360 + 360) % 360));
    }
    brought.set(ins, pages);
  }
  // Where each output page came from: the source page number, or null for
  // a page brought in from elsewhere. Kept on the copy so a reader of it —
  // the companion, chiefly — can find the same text in the indexed original.
  let inserted = 0;
  const sourcePages = [];
  for (let pos = 1; pos <= order.length + 1; pos += 1) {
    const past = pos > order.length;
    for (const ins of inserts) {
      if (ins.at === pos || (past && ins.at > order.length)) {
        for (const page of brought.get(ins)) { out.addPage(page); inserted += 1; sourcePages.push(null); }
      }
    }
    if (!past) { out.addPage(own[pos - 1]); sourcePages.push(order[pos - 1]); }
  }
  const outCount = out.getPageCount();
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
    pageCount: outCount,
    opts,
    metadata: { source_document_id: src.id, source_pages: sourcePages },
  });
  const downloadUrl = await signDownloadUrl(supabase, filed.document_id);

  return {
    document_id: filed.document_id,
    matter: filed.matter,
    filename,
    source_document_id: src.id,
    page_count: outCount,
    pages_kept: order,
    pages_inserted: inserted,
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


// -----------------------------------------------------------------------------
// The task board (migration 085): my_tasks, claim_task, ask_human, post_result
// -----------------------------------------------------------------------------
// A person delegates a task to one of their connected AIs; the AI, which can
// only call out, picks it up here. Since migration 089 the recipient is any
// connection: an agent token (as before), a full-access user token, or a
// full-assistant OAuth grant — `scope.recipient` says which, and which
// column of agent_tasks names it. A full assistant's reach is its user's,
// minus the sealed and the paused (dispatchWithSeal). Every handler:
//   * answers only to the calling connection — a task assigned to any other
//     token or grant is "not found", never "not yours";
//   * re-checks the task's matter against the grant, the seal and the pause,
//     because the task is named by id and not by matter, so the generic scope
//     check in dispatchWithSeal cannot see which matter it is;
//   * writes one agent_task_events row for every change it makes — the
//     matter's own account of what the agent did.
// The queries run through the caller's user-scoped client, so RLS (085) holds
// as well: an agent can only ever touch tasks its owner could.

const TASK_COLS =
  'id, matterspace_id, assigned_token_id, title, instructions, attachments, due_at, status, ' +
  'question, answer, result, result_refs, claimed_at, completed_at, created_at, updated_at';
const TASK_LIVE = ['open', 'claimed', 'needs_input'];
const TASK_STATUSES = ['open', 'claimed', 'needs_input', 'done', 'failed', 'cancelled'];
const TASK_ITEM_KINDS = ['document', 'content_item', 'calendar_event'];
const TASK_LIST_LIMIT = 100;
const TASK_QUESTION_MAX = 4000;
const TASK_RESULT_MAX = 100_000;
const TASK_REFS_MAX = 50;
const TASK_ITEM_TEXT_MAX = 20_000;
const TASK_NOT_FOUND = 'No task with that id is assigned to this connection. Call my_tasks for the list.';

/** The agent_tasks column that names this kind of recipient (089). */
function taskRecipientColumn(r) {
  return r?.kind === 'grant' ? 'assigned_grant_id' : 'assigned_token_id';
}

/**
 * The columns a handler reads. assigned_grant_id is named only for a grant
 * recipient: before 089 the column does not exist, and an agent's or a
 * token's my_tasks must keep working in the window between merge and paste.
 */
function taskColsFor(r) {
  return r?.kind === 'grant' ? `${TASK_COLS}, assigned_grant_id` : TASK_COLS;
}

/** A caller with no task identity (the in-app Assistant, a pre-065 token). */
function noTasksAnswer(name) {
  if (name === 'my_tasks') {
    return { task_count: 0, result_count: 0, tasks: [], note: NO_TASKS_MESSAGE };
  }
  return { error: `${NO_TASKS_MESSAGE} ${TASK_NOT_FOUND}` };
}

/** The task scope dispatchWithSeal attached, or a refusal. */
function taskScopeOf(opts = {}) {
  const s = opts.agentScope;
  const r = s?.recipient;
  if (!r?.id || (r.kind !== 'token' && r.kind !== 'grant') || !(s.allowed instanceof Set)) {
    throw new Error(`${NO_TASKS_MESSAGE} ${TASK_NOT_FOUND}`);
  }
  return s;
}

/** May this agent see matter `id` right now (granted, not sealed, not paused)? */
function taskMatterVisible(scope, id) {
  return typeof id === 'string' && scope.allowed.has(id)
    && !scope.sealed?.has?.(id) && !scope.paused?.has?.(id);
}

/** Refuse a task whose matter is outside the grant, sealed, or paused. */
async function taskMatterGate(supabase, scope, matterId) {
  if (typeof matterId === 'string' && scope.allowed.has(matterId) && scope.paused?.has?.(matterId)) {
    const pause = await matterPauseWithClient(supabase, matterId);
    throw new AiPausedMatterError(pause?.paused ? pause : { matterId });
  }
  if (!taskMatterVisible(scope, matterId)) {
    // A full assistant's task in a sealed matter is simply not there: the
    // seal hides sealed matters from every connector, tasks included.
    if (scope.recipient?.agent === false) throw new Error(TASK_NOT_FOUND);
    throw new AgentScopeError(scope.allowed instanceof AgentScopeAll ? AGENT_ALL_SCOPE_MESSAGE : undefined);
  }
}

/** A column 089 adds, asked for before 089 is applied. */
function isMissingTaskColumn(error) {
  const msg = String(error?.message ?? '');
  return error?.code === '42703' || error?.code === 'PGRST204'
    || /assigned_grant_id|actor_grant_id/.test(msg);
}

/** 085 (or 089) not applied yet reads as a sentence, not as a Postgres code. */
function taskTableError(error) {
  const msg = String(error?.message ?? error ?? '');
  if (error?.code === '42P01' || error?.code === 'PGRST205'
      || (/agent_tasks|agent_task_events/.test(msg) && /does not exist|not find/i.test(msg))) {
    return 'The task board is not set up on this Contextspaces server yet (migration 085).';
  }
  if (isMissingTaskColumn(error)) {
    return 'Tasks for this kind of connection are not set up on this Contextspaces server yet (migration 089).';
  }
  return msg || 'task query failed';
}

async function loadOwnTask(supabase, scope, taskId) {
  if (typeof taskId !== 'string' || !UUID_RE.test(taskId)) {
    throw new Error('task_id must be a task id from my_tasks.');
  }
  const r = scope.recipient;
  const col = taskRecipientColumn(r);
  const { data, error } = await supabase
    .from('agent_tasks').select(taskColsFor(r))
    .eq('id', taskId)
    .eq(col, r.id)
    .maybeSingle();
  if (error) throw new Error(taskTableError(error));
  if (!data || data[col] !== r.id) throw new Error(TASK_NOT_FOUND);
  await taskMatterGate(supabase, scope, data.matterspace_id);
  return data;
}

/** Append to the task's log. Returns whether the row was written. */
async function logTaskEvent(supabase, scope, taskId, kind, body = null) {
  try {
    const r = scope.recipient;
    const actorUser = r.userId ?? await resolveCallerId(supabase, {});
    const { error } = await supabase.from('agent_task_events').insert({
      task_id: taskId,
      // An AI did it, whichever kind of connection it came in on.
      actor_kind: 'agent',
      actor_user: actorUser,
      actor_token_id: r.kind === 'token' ? r.id : null,
      // Named only for a grant: the column is 089's.
      ...(r.kind === 'grant' ? { actor_grant_id: r.id } : {}),
      kind,
      body: typeof body === 'string' ? body.slice(0, TASK_RESULT_MAX) : null,
    });
    return !error;
  } catch {
    return false;
  }
}

/** Plain text out of a page/list's stored JSON (Tiptap-shaped or not). */
function contentItemText(content) {
  const out = [];
  let chars = 0;
  const walk = (node, depth) => {
    if (chars >= TASK_ITEM_TEXT_MAX || depth > 40 || node === null || node === undefined) return;
    if (typeof node === 'string') return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
    if (typeof node !== 'object') return;
    for (const key of ['text', 'title', 'label']) {
      if (typeof node[key] === 'string' && node[key].trim()) {
        out.push(node[key]);
        chars += node[key].length;
      }
    }
    if (typeof node.checked === 'boolean') out.push(node.checked ? '[x]' : '[ ]');
    for (const [k, v] of Object.entries(node)) {
      if (k === 'text' || k === 'title' || k === 'label' || k === 'attrs' || k === 'marks') continue;
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
    if (node.type && /paragraph|heading|listItem|taskItem|item|row|blockquote/i.test(String(node.type))) out.push('\n');
  };
  walk(content, 0);
  const text = out.join(' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > TASK_ITEM_TEXT_MAX ? `${text.slice(0, TASK_ITEM_TEXT_MAX)}…` : text;
}

/**
 * Attachments (or result_refs) as the agent should see them: each item it may
 * see comes back with enough to use it; each one it may not see is named only
 * by kind and id, with no label and no content.
 */
async function resolveTaskItems(supabase, scope, lists) {
  const want = { document: new Set(), content_item: new Set(), calendar_event: new Set() };
  for (const list of lists) {
    for (const it of Array.isArray(list) ? list : []) {
      if (it && TASK_ITEM_KINDS.includes(it.kind) && typeof it.id === 'string' && UUID_RE.test(it.id)) {
        want[it.kind].add(it.id);
      }
    }
  }
  const found = new Map();   // `${kind}:${id}` -> resolved item
  const read = async (table, cols, ids) => {
    if (ids.size === 0) return [];
    try {
      const { data, error } = await supabase.from(table).select(cols).in('id', [...ids]);
      return error ? [] : (data ?? []);
    } catch { return []; }
  };
  for (const d of await read('documents', 'id, title, doc_type, matterspace_id, processing_status, page_count', want.document)) {
    if (!taskMatterVisible(scope, d.matterspace_id)) continue;
    found.set(`document:${d.id}`, {
      title: d.title ?? null, doc_type: d.doc_type ?? null, page_count: d.page_count ?? null,
      processing_status: d.processing_status ?? null,
      how_to_read: 'get_outline {doc}, grep {matter, pattern, doc}, search {q, document_ids:[id]}, get_media {document_id}',
    });
  }
  for (const c of await read('content_items', 'id, title, content_type, content, space_id, space_type', want.content_item)) {
    if (c.space_type !== 'matterspace' || !taskMatterVisible(scope, c.space_id)) continue;
    found.set(`content_item:${c.id}`, {
      title: c.title ?? null, content_type: c.content_type ?? null, text: contentItemText(c.content),
    });
  }
  for (const e of await read('calendar_events',
    'id, title, notes, location, start_date, start_time, end_date, end_time, event_type, matterspace_id',
    want.calendar_event)) {
    if (!taskMatterVisible(scope, e.matterspace_id)) continue;
    found.set(`calendar_event:${e.id}`, {
      title: e.title ?? null, event_type: e.event_type ?? null,
      start_date: e.start_date ?? null, start_time: e.start_time ?? null,
      end_date: e.end_date ?? null, end_time: e.end_time ?? null,
      location: e.location ?? null, notes: e.notes ?? null,
    });
  }
  return (list) => (Array.isArray(list) ? list : [])
    .filter((it) => it && typeof it === 'object')
    .map((it) => {
      const hit = found.get(`${it.kind}:${it.id}`);
      if (!hit) {
        return { kind: it.kind ?? null, id: it.id ?? null, available: false,
          note: 'Not available to this connection (outside its matters, sealed, or no longer there).' };
      }
      return { kind: it.kind, id: it.id, ...(typeof it.label === 'string' ? { label: it.label } : {}), available: true, ...hit };
    });
}

function taskNextStep(t) {
  switch (t.status) {
    case 'open': return 'claim_task, then do the work.';
    case 'claimed': return t.answer
      ? 'Your question was answered (see `answer`). Carry on, then post_result.'
      : 'Do the work inside this matter, then post_result (or ask_human if blocked).';
    case 'needs_input': return 'Waiting for the person to answer your question. Poll my_tasks.';
    case 'cancelled': return 'Cancelled by the person who delegated it. Stop work on it.';
    default: return 'Finished.';
  }
}

export async function handleMyTasks(supabase, args = {}, opts = {}) {
  const scope = taskScopeOf(opts);
  const wanted = args.status ?? 'active';
  if (wanted !== 'active' && wanted !== 'all' && !TASK_STATUSES.includes(wanted)) {
    throw new Error(`status must be one of: active, all, ${TASK_STATUSES.join(', ')}.`);
  }
  const r = scope.recipient;
  const col = taskRecipientColumn(r);
  let q = supabase.from('agent_tasks').select(taskColsFor(r)).eq(col, r.id);
  if (wanted === 'active') q = q.in('status', TASK_LIVE);
  else if (wanted !== 'all') q = q.eq('status', wanted);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(TASK_LIST_LIMIT);
  if (error) {
    // Before 089 no task can be assigned to an OAuth assistant: it has none.
    if (r.kind === 'grant' && isMissingTaskColumn(error)) return noTasksAnswer('my_tasks');
    throw new Error(taskTableError(error));
  }

  // A task in a matter this connection may not see right now (the grant
  // changed, a seal went on, the matter is paused) is left out entirely.
  const rows = (data ?? []).filter((t) => t[col] === r.id
    && taskMatterVisible(scope, t.matterspace_id));

  const mids = [...new Set(rows.map((t) => t.matterspace_id))];
  const matters = new Map();
  if (mids.length) {
    const { data: ms } = await supabase
      .from('matterspaces').select('id, name, short_code').in('id', mids);
    for (const m of ms ?? []) matters.set(m.id, m);
  }
  const shape = await resolveTaskItems(supabase, scope, rows.flatMap((t) => [t.attachments, t.result_refs]));

  return {
    status_filter: wanted,
    task_count: rows.length,
    result_count: rows.length,
    tasks: rows.map((t) => {
      const m = matters.get(t.matterspace_id);
      const finished = t.status === 'done' || t.status === 'failed';
      return {
        task_id: t.id,
        title: t.title,
        status: t.status,
        matter: { id: t.matterspace_id, short_code: m?.short_code ?? null, name: m?.name ?? null },
        instructions: t.instructions ?? '',
        due_at: t.due_at ?? null,
        question: t.question ?? null,
        answer: t.answer ?? null,
        attachments: shape(t.attachments),
        ...(finished ? { result: t.result ?? null, result_refs: shape(t.result_refs) } : {}),
        created_at: t.created_at ?? null,
        claimed_at: t.claimed_at ?? null,
        completed_at: t.completed_at ?? null,
        next: taskNextStep(t),
      };
    }),
    ...(rows.length === 0
      ? { note: r.agent === false ? NO_TASKS_MESSAGE : 'No tasks right now. Poll again later.' }
      : {}),
  };
}

export async function handleClaimTask(supabase, args = {}, opts = {}) {
  const scope = taskScopeOf(opts);
  const task = await loadOwnTask(supabase, scope, args.task_id);
  const brief = (t, extra = {}) => ({
    task_id: t.id, status: t.status, title: t.title, matter_id: t.matterspace_id, ...extra,
    next: 'Do the work with the normal tools inside this matter; ask_human if blocked; finish with post_result.',
  });
  if (task.status === 'claimed' || task.status === 'needs_input') return brief(task, { already_claimed: true });
  if (task.status !== 'open') {
    throw new Error(`This task is ${task.status}; only an open task can be claimed.`);
  }
  const { data, error } = await supabase
    .from('agent_tasks')
    .update({ status: 'claimed', claimed_at: new Date().toISOString() })
    .eq('id', task.id)
    .eq(taskRecipientColumn(scope.recipient), scope.recipient.id)
    .eq('status', 'open')
    .select(TASK_COLS)
    .maybeSingle();
  if (error) throw new Error(taskTableError(error));
  if (!data) {
    // Lost a race with ourselves (two polls), or the person cancelled it.
    const again = await loadOwnTask(supabase, scope, task.id);
    if (again.status === 'claimed' || again.status === 'needs_input') return brief(again, { already_claimed: true });
    throw new Error(`This task is ${again.status}; only an open task can be claimed.`);
  }
  const logged = await logTaskEvent(supabase, scope, task.id, 'claimed');
  return brief(data, logged ? {} : { warning: 'Claimed, but the task log could not be written.' });
}

export async function handleAskHuman(supabase, args = {}, opts = {}) {
  const scope = taskScopeOf(opts);
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question) throw new Error('question is required.');
  if (question.length > TASK_QUESTION_MAX) {
    throw new Error(`question is too long (${question.length} characters; max ${TASK_QUESTION_MAX}).`);
  }
  const task = await loadOwnTask(supabase, scope, args.task_id);
  if (!TASK_LIVE.includes(task.status)) {
    throw new Error(`This task is ${task.status}; questions can only be asked on an open or claimed task.`);
  }
  const { data, error } = await supabase
    .from('agent_tasks')
    .update({
      status: 'needs_input',
      question,
      answer: null,
      ...(task.claimed_at ? {} : { claimed_at: new Date().toISOString() }),
    })
    .eq('id', task.id)
    .eq(taskRecipientColumn(scope.recipient), scope.recipient.id)
    .in('status', TASK_LIVE)
    .select(TASK_COLS)
    .maybeSingle();
  if (error) throw new Error(taskTableError(error));
  if (!data) throw new Error('The task changed while you were asking (it may have been cancelled). Call my_tasks.');
  const logged = await logTaskEvent(supabase, scope, task.id, 'asked', question);
  return {
    task_id: data.id,
    status: data.status,
    question: data.question,
    ...(logged ? {} : { warning: 'Asked, but the task log could not be written.' }),
    next: 'Poll my_tasks. When the person answers, the task returns to "claimed" with `answer` filled in.',
  };
}

/** Every result_ref must be well-formed and inside the agent's matters. */
async function checkResultRefs(supabase, scope, refs) {
  if (refs === undefined || refs === null) return [];
  if (!Array.isArray(refs)) throw new Error('result_refs must be an array of {kind, id, label?}.');
  if (refs.length > TASK_REFS_MAX) throw new Error(`result_refs: at most ${TASK_REFS_MAX} items.`);
  const clean = refs.map((r, i) => {
    if (!r || typeof r !== 'object' || !TASK_ITEM_KINDS.includes(r.kind)
        || typeof r.id !== 'string' || !UUID_RE.test(r.id)) {
      throw new Error(`result_refs[${i}] must be {kind: ${TASK_ITEM_KINDS.join('|')}, id: <uuid>, label?}.`);
    }
    return {
      kind: r.kind, id: r.id,
      ...(typeof r.label === 'string' && r.label.trim() ? { label: r.label.trim().slice(0, 200) } : {}),
    };
  });
  const shape = await resolveTaskItems(supabase, scope, [clean]);
  const seen = shape(clean);
  seen.forEach((it, i) => {
    if (!it.available) throw new AgentScopeError(`result_refs[${i}] is not in a matter this connection can see.`);
  });
  return clean;
}

export async function handlePostResult(supabase, args = {}, opts = {}) {
  const scope = taskScopeOf(opts);
  const result = typeof args.result === 'string' ? args.result.trim() : '';
  if (!result) throw new Error('result is required (for a failure, say why).');
  if (result.length > TASK_RESULT_MAX) {
    throw new Error(`result is too long (${result.length} characters; max ${TASK_RESULT_MAX}). File it with file_document and reference it in result_refs.`);
  }
  const status = args.status ?? 'done';
  if (status !== 'done' && status !== 'failed') throw new Error('status must be "done" or "failed".');
  const task = await loadOwnTask(supabase, scope, args.task_id);
  if (!TASK_LIVE.includes(task.status)) {
    throw new Error(`This task is ${task.status}; a result can only be posted on an open or claimed task.`);
  }
  const refs = await checkResultRefs(supabase, scope, args.result_refs);
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('agent_tasks')
    .update({
      status,
      result,
      result_refs: refs,
      completed_at: now,
      ...(task.claimed_at ? {} : { claimed_at: now }),
    })
    .eq('id', task.id)
    .eq(taskRecipientColumn(scope.recipient), scope.recipient.id)
    .in('status', TASK_LIVE)
    .select(TASK_COLS)
    .maybeSingle();
  if (error) throw new Error(taskTableError(error));
  if (!data) throw new Error('The task changed before the result was saved (it may have been cancelled). Call my_tasks.');
  const logged = await logTaskEvent(supabase, scope, task.id, status === 'failed' ? 'failed' : 'result', result);
  return {
    task_id: data.id,
    status: data.status,
    result_refs: refs,
    completed_at: data.completed_at ?? now,
    ...(logged ? {} : { warning: 'Saved, but the task log could not be written.' }),
    next: 'Done. Call my_tasks for the next task.',
  };
}
