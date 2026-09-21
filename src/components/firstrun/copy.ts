// Every word a brand-new account reads on the Dashboard, in one file.
//
// The first five minutes of a stranger's account are the one place where the
// product has to say what it is FOR. That is a writing problem, not a coding
// problem, so the writing is kept here on its own: Eden can rewrite any
// sentence below without opening a component, and nothing in
// FirstRunDocket.tsx or useFirstRun.ts holds a user-visible string.
//
// Two rules the text obeys, and they are not style preferences:
//
//   1. **Every claim is one the product can keep today.** No "most users", no
//      outcomes, no promise about a room that is not furnished. Where the
//      product does less than the sentence would imply, the sentence says the
//      smaller thing. The file-type list and the seal wording below are
//      transcribed from the code that enforces them (lib/ingest-formats.mjs
//      SUPPORTED_TYPES_SUMMARY; SealMatterModal.tsx), not written fresh.
//   2. **No invented vocabulary.** "Serverspace", "matter", "Vault",
//      "Assistant", "Connections", "Record" are the product's own words and
//      the labels on its own screens, so a line that names one can be
//      followed by eye.

/** Substituted into `step1.detail`. */
export const NAME_TOKEN = '{name}';

export const FIRST_RUN_COPY = {
  /** Section heading, in the Dashboard's own uppercase-label register. */
  heading: 'Where to start',

  intro:
    'Contextspaces keeps one matter’s documents in one place, answers questions from them, ' +
    'and records how AI was used on the matter. Six steps — each one opens what it names.',

  /** The quiet text control that puts the list away for good. */
  dismiss: 'Don’t show this again',
  dismissTitle: 'Hide this list on this account, permanently',

  /**
   * The name step 1 uses when the account carries no usable name at all — no
   * display_name, no OAuth full name, no email. It is written to the database
   * as the serverspace's name, so it is a name and not a sentence.
   */
  workspaceFallbackName: 'My Practice',

  /** Shown under the six steps. Not steps: two rooms for a day that has not come yet. */
  closing:
    'When a deadline arrives: Bucketizer sorts a record into your case theory; ' +
    'Discovery builds a production.',

  /** What a step's tick means. Each is derived from data, never from a click. */
  doneNote: {
    workspace: 'Created',
    matter: 'Opened',
    documents: 'Filed',
    ask: 'Asked',
    connect: 'Connected',
    record: 'Recorded',
  },

  /** Hover text on each tick — what was actually observed, in plain words. */
  doneTitle: {
    workspace: 'You have a serverspace.',
    matter: 'You have a matter.',
    documents: 'At least one document is filed.',
    ask: 'At least one model call is on a matter’s Record.',
    connect: 'At least one outside AI client is approved on this account.',
    record: 'A matter’s Record has at least one entry.',
  },

  steps: {
    workspace: {
      title: 'Create your workspace',
      // The name is shown before the click because there is no rename control
      // in the product today — see the PR body. "Name it yourself" is the way
      // out, and it opens the ordinary New Serverspace dialog.
      detail:
        `A serverspace holds your matters. This one will be called “${NAME_TOKEN}”.`,
      action: 'Create it',
      actionBusy: 'Creating…',
      alternate: 'Name it yourself',
      blocked: '',
    },
    matter: {
      title: 'Open your first matter',
      detail: 'A matter is one case or file. Name it, and decide now whether it is sealed.',
      action: 'New matter',
      actionBusy: '',
      alternate: '',
      blocked: 'Create your workspace first.',
    },
    documents: {
      title: 'Put documents in its Vault',
      detail:
        'Open the matter’s Vault and choose Import/Display Documents. It accepts PDF, Word, ' +
        'text, spreadsheets, slides, email, e-books, images, audio and video, and .zip archives ' +
        'of those, up to 500 MB a file. A large upload is quoted before it runs.',
      action: 'Open the Vault',
      actionBusy: '',
      alternate: '',
      blocked: 'Open a matter first.',
    },
    ask: {
      title: 'Ask about them',
      detail:
        'The Assistant, scoped to that matter. It reads what is filed there and nothing from ' +
        'another matter.',
      action: 'Open the Assistant',
      actionBusy: '',
      alternate: '',
      blocked: 'Open a matter first.',
    },
    connect: {
      title: 'Connect your own AI',
      detail:
        'Claude or ChatGPT, reading your matters under your own access. A sealed matter stays ' +
        'invisible to it.',
      action: 'Open Connections',
      actionBusy: '',
      alternate: '',
      blocked: '',
    },
    record: {
      title: 'See the Record',
      detail:
        'A matter’s Record is how you show the way AI was used on it — the model calls made on ' +
        'the matter, and what each one touched.',
      action: 'Open the Record',
      actionBusy: '',
      alternate: '',
      blocked: 'Open a matter first.',
    },
  },

  /**
   * The "sealed from the start" offer on step 2.
   *
   * Wording is constrained by the 2026-09-19 SecureSpace audit and matches
   * SealMatterModal.tsx: the sealed model is never named "Claude"; the seal is
   * prospective; search inside the seal is word search. A matter born sealed
   * is the one case where "prospective" costs nothing, and the second line
   * says exactly that rather than leaving it implied.
   */
  seal: {
    label: 'Sealed from the start',
    sentence:
      'A sealed matter is invisible to outside AI connectors, its documents and searches never ' +
      'reach a general-purpose AI provider, and inside the seal it is searched by exact words ' +
      'and phrases rather than by meaning.',
    prospective:
      'The seal governs every send from the moment it is set, and a matter born sealed has sent ' +
      'nothing yet.',
  },

  /** Something went wrong on a step that creates. Prefixed to the server's own words. */
  errorPrefix: 'That did not work: ',
  /** The one failure the create path can hit that the server has no sentence for. */
  noClientspace:
    'No clientspace was found for this account, so there is nothing to create the serverspace ' +
    'in. Reload the page and try again.',

  /**
   * The Dashboard's own empty states, so the three voids a new account used to
   * meet — the greeting, the serverspaces panel, the deadlines section — read
   * as one docket instead. `greetingNew` drops "back" from "Welcome back":
   * nobody is back on the first visit, and it is the first sentence of the
   * product.
   */
  dashboard: {
    greetingNew: 'Welcome, ',
    greetingReturning: 'Welcome back, ',
    serverspacesEmptyWithDocket: 'Nothing here yet — step 1 above puts it here.',
  },
} as const;

export type StepCopyId = keyof typeof FIRST_RUN_COPY.steps;
