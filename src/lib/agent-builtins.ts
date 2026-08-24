// The "On duty" docket — agents that exist as standing things rather than
// as something a user wrote.
//
// This file is the DISPLAY side. The charters themselves live server-side in
// lib/agent-charter.mjs (BUILTIN_CHARTERS), keyed by the same `key` values,
// so the prose that shapes a run never travels from the browser. "Ask it"
// sends `charterId: "builtin:<key>"` and the server loads the charter.
// scripts/_verify-agent-tools.mjs checks the two files stay in step.
//
// Honesty rule for this list: `activity` says where a row's live reading
// comes from. Where there is no source, the row says "not yet scheduled" —
// there is no scheduler and no document-landed hook in this codebase, and a
// row that implied background work would be a lie about the product.

export type BuiltinActivity = 'ingest_queue' | 'none';

export interface BuiltinAgent {
  key: string;
  name: string;
  /** What it watches — the second column of the docket. */
  watches: string;
  /** Its job in one sentence, for the expanded row. */
  purpose: string;
  /** Tool names, mirroring the server-side charter. */
  tools: string[];
  /** Where a live "last run" reading comes from, if anywhere. */
  activity: BuiltinActivity;
  /** The standing question "Ask it" hands the Orchestrator. */
  ask: string;
}

export const BUILTIN_AGENTS: BuiltinAgent[] = [
  {
    key: 'support',
    name: 'Support',
    watches: 'This instance — what is failing and why',
    purpose:
      'Diagnoses what is actually happening in your instance, fixes what is safe and reversible, '
      + 'and says plainly when something needs a person.',
    tools: ['list_matters', 'list_matter_contents', 'check_ingest_status', 'ingest_document', 'get_outline', 'search'],
    activity: 'none',
    ask: 'Something is not working the way I expect. Ask me what I am seeing and where, then work out what is actually going on.',
  },
  {
    key: 'ingestion',
    name: 'Ingestion watcher',
    watches: 'The import queue and everything landing in the vault',
    purpose:
      'Watches what is coming in: what is still processing, what failed and why, and what is worth re-queueing.',
    tools: ['check_ingest_status', 'ingest_document', 'list_matter_contents', 'list_matters'],
    activity: 'ingest_queue',
    ask: 'Where does ingestion stand right now — what is still processing, what failed, and what should I retry?',
  },
  {
    key: 'morning_brief',
    name: 'Morning brief',
    watches: 'The practice: what moved, what is due, what is waiting',
    purpose:
      'One short brief on where the practice stands — overdue first, then waiting-on, then what actually moved.',
    tools: ['get_matter_state', 'list_matters', 'search', 'get_passage'],
    activity: 'none',
    ask: 'Give me the brief: what is overdue or due today, what is waiting on someone, and what actually moved.',
  },
  {
    key: 'docket_monitor',
    name: 'Docket monitor',
    watches: 'The Practice Docket — stale entries and approaching dates',
    purpose:
      'Keeps the docket honest: which entries have gone stale, what they should say, and what is about to come due.',
    tools: ['get_matter_state', 'set_matter_state', 'list_matters', 'search'],
    activity: 'none',
    ask: 'Go through my docket entries and tell me which ones have gone stale, and what each should say instead.',
  },
];
