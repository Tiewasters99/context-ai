// The tool menu a charter picks from.
//
// These are exactly the tools the Orchestrator already permits — the
// ALLOWED_TOOLS set in lib/assistant-core.mjs, which is itself a filtered,
// mostly read-only slice of lib/mcp-core.mjs's TOOLS. This file is the
// DISPLAY side of that list: the same names, with a plain-English label and
// one line saying what the tool actually does, so a charter reads like a
// document rather than a config screen.
//
// It is deliberately not the authority. At run time the server intersects
// whatever a charter asked for with ALLOWED_TOOLS ∩ mcp-core's TOOLS
// (lib/agent-charter.mjs, narrowToolNames) — so a name that drifts out of
// this list is silently dropped rather than granted. Drift only ever fails
// closed. `scripts/_verify-agent-tools.mjs` checks the two stay in step.

export interface CharterTool {
  name: string;
  label: string;
  /** One line, plain English: what the agent can do with it. */
  does: string;
  /** True when the tool changes something rather than only reading. */
  writes?: boolean;
}

export interface CharterToolGroup {
  heading: string;
  note: string;
  tools: CharterTool[];
}

export const CHARTER_TOOL_GROUPS: CharterToolGroup[] = [
  {
    heading: 'Reading the record',
    note: 'Read-only. Everything here runs under your own permissions and stays inside the matter the agent is scoped to.',
    tools: [
      {
        name: 'search',
        label: 'Search the matter',
        does: 'Find passages across the matter’s documents and get them back with page citations.',
      },
      {
        name: 'grep',
        label: 'Exact-phrase search',
        does: 'Find a literal string or pattern — names, Bates numbers, defined terms.',
      },
      {
        name: 'get_passage',
        label: 'Read a passage in full',
        does: 'Pull the full text around a search hit before quoting it.',
      },
      {
        name: 'get_outline',
        label: 'Read a document’s outline',
        does: 'See the structure of a long document without reading all of it.',
      },
      {
        name: 'list_matter_contents',
        label: 'List what is filed',
        does: 'See the documents and sub-matters filed in the matter.',
      },
      {
        name: 'list_matters',
        label: 'List matters',
        does: 'See the matters you have access to. Needed only for an agent that is not scoped to one matter.',
      },
    ],
  },
  {
    heading: 'The ingestion queue',
    note: 'Reading the queue is safe; re-queueing only asks the background worker to try again — it never alters a document.',
    tools: [
      {
        name: 'check_ingest_status',
        label: 'Check import status',
        does: 'See what is still processing, what failed, and whether the worker is running.',
      },
      {
        name: 'ingest_document',
        label: 'Re-queue a document',
        does: 'Ask the worker to import or re-import a stored document.',
        writes: true,
      },
    ],
  },
  {
    heading: 'The Practice Docket',
    note: 'Docket state is versioned: every change lands as an append-only ledger entry you can read back.',
    tools: [
      {
        name: 'get_matter_state',
        label: 'Read the docket entry',
        does: 'See where a thread stands: status, headline, next step, deadline, waiting-on.',
      },
      {
        name: 'set_matter_state',
        label: 'Update the docket entry',
        does: 'Write a new status, headline, next step or deadline onto the thread.',
        writes: true,
      },
    ],
  },
];

export const CHARTER_TOOLS: CharterTool[] = CHARTER_TOOL_GROUPS.flatMap((g) => g.tools);

const BY_NAME = new Map(CHARTER_TOOLS.map((t) => [t.name, t]));

export function charterTool(name: string): CharterTool | undefined {
  return BY_NAME.get(name);
}

/** Labels for a list of tool names, in menu order, unknown names dropped. */
export function toolLabels(names: string[] | null | undefined): string[] {
  const asked = new Set(names ?? []);
  return CHARTER_TOOLS.filter((t) => asked.has(t.name)).map((t) => t.label);
}
