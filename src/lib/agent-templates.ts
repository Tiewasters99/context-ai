// Prebuilt charters.
//
// These are starting points, not agents: picking one fills the editor and
// nothing is written until the user saves. Every word is meant to be edited
// — a charter the user has rewritten in their own terms is a better charter
// than one they accepted, and the whole point of the tab is that an agent
// reads as a document you wrote.
//
// Each one describes a job that these tools can actually do against
// documents already filed in the matter. None of them reaches outside
// Contextspaces — there is no mailbox connector, no citator, no external
// research here — and the instructions say so where it matters, so an agent
// never promises a capability the run does not have.

import type { CharterDraft, TriggerKind } from '@/lib/agent-charters';

export interface CharterTemplate {
  key: string;
  /** What the row says in the "start from" list. */
  title: string;
  blurb: string;
  draft: Omit<CharterDraft, 'matterspace_id' | 'enabled'> & { trigger_kind: TriggerKind };
}

export const CHARTER_TEMPLATES: CharterTemplate[] = [
  {
    key: 'email_sweep',
    title: 'Sweep these emails into the matter summary',
    blurb: 'Reads the correspondence filed in a matter and turns it into a dated summary of what was said and what was asked for.',
    draft: {
      name: 'Email sweep',
      purpose: 'Turn the correspondence filed in this matter into a dated summary of what was said and what each side asked for.',
      instructions:
        'Work only from correspondence already filed in this matter — you have no mailbox access, so if the emails have not been '
        + 'brought into the vault, say so and stop.\n\n'
        + 'Read the correspondence in date order. For each exchange that matters, record: the date, who wrote to whom, what they '
        + 'said, and what they asked for or committed to. Cite the document and page for each entry.\n\n'
        + 'Then, separately and briefly, note the demands and deadlines that are still outstanding — anything asked for that has '
        + 'not visibly been answered. Distinguish what the correspondence establishes from what it merely suggests, and never '
        + 'characterise an email you have not read in full.',
      allowed_tools: ['search', 'grep', 'get_passage', 'list_matter_contents'],
      trigger_kind: 'on_demand',
      trigger_config: {},
    },
  },
  {
    key: 'cite_check',
    title: 'Cite-check this brief',
    blurb: 'Checks every record citation in a draft against the documents actually filed in the matter.',
    draft: {
      name: 'Record cite-check',
      purpose: 'Check that every record citation in a draft points at what the draft says it points at.',
      instructions:
        'You check RECORD citations against the documents in this matter — citations to the transcript, the exhibits, the '
        + 'declarations, the filings. You cannot verify case law: there is no citator in this run, so if the draft cites '
        + 'authority, say plainly that you have not checked it rather than implying you have.\n\n'
        + 'For each record citation in the draft: find the cited page, read it in full, and say whether it supports the '
        + 'proposition as written. Three outcomes, and use them exactly — supported, does not support, or cannot be located. '
        + 'Quote the cited language when you find a mismatch so the difference is visible.\n\n'
        + 'Report the mismatches first and the clean citations as a short list at the end. Never repair a citation by guessing '
        + 'at a better page; say what you found.',
      allowed_tools: ['search', 'grep', 'get_passage', 'get_outline', 'list_matter_contents'],
      trigger_kind: 'on_demand',
      trigger_config: {},
    },
  },
  {
    key: 'bluebook',
    title: 'Bluebook pass',
    blurb: 'Reads a draft and lists the citation-form corrections, in order, with the corrected text.',
    draft: {
      name: 'Bluebook pass',
      purpose: 'Bring the citation form in a draft into line with The Bluebook, and show every change.',
      instructions:
        'Read the draft and list, in the order they appear, every citation whose FORM needs correcting: signals, typeface, '
        + 'short-form and id. usage, pincites, parentheticals, ordering within a string cite, and the case-name abbreviations '
        + 'in Table 6.\n\n'
        + 'For each one, give the original as written, the corrected form, and a short reason — the rule if you are confident '
        + 'of the number, the plain reason if you are not. Do not invent a rule number to sound authoritative.\n\n'
        + 'This is a FORM pass. You are not verifying that the cited authority exists or says what it is cited for; if you '
        + 'notice a substantive problem, flag it in one line and keep it separate from the form list.',
      allowed_tools: ['search', 'get_passage', 'get_outline', 'list_matter_contents'],
      trigger_kind: 'on_demand',
      trigger_config: {},
    },
  },
  {
    key: 'what_changed',
    title: 'Summarize what changed in this matter since Monday',
    blurb: 'Reads the docket entry and what has been filed recently, and reports what actually moved.',
    draft: {
      name: 'What changed',
      purpose: 'Say what actually moved in this matter over a stated period — and say when nothing did.',
      instructions:
        'Start from the docket entry for this matter (get_matter_state): its status, headline, next step, deadline and '
        + 'waiting-on tell you what the thread was supposed to be doing. Then look at what has been filed in the matter over '
        + 'the period you have been asked about.\n\n'
        + 'Report three things and nothing else: what came in, what was done, and what is now due. Cite documents where a '
        + 'claim rests on one.\n\n'
        + 'A quiet week is a real answer — say so plainly rather than padding. Do not describe the state of the matter as '
        + 'change; only report what is different from where it stood at the start of the period.',
      allowed_tools: ['get_matter_state', 'list_matter_contents', 'search', 'get_passage'],
      trigger_kind: 'on_demand',
      trigger_config: {},
    },
  },
];

export const BLANK_DRAFT: Omit<CharterDraft, 'matterspace_id' | 'enabled'> = {
  name: '',
  purpose: '',
  instructions: '',
  allowed_tools: [],
  trigger_kind: 'on_demand',
  trigger_config: {},
};
