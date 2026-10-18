// lib/video-discovery/schemas.mjs — the two shapes the Video Room speaks.
//
// Provider-neutral. Written in the OpenAPI-3 subset every structured-output
// API accepts (type / properties / required / items / enum / nullable /
// description), so an adapter can hand a schema straight to its provider as
// the response schema and the rest of the module never parses prose.
//
// Both schemas are deliberately free of legal vocabulary. The model reports
// what is visible and audible, with a basis and a confidence for each claim;
// "excessive", "violation", "reasonable" and their relatives are the lawyer's
// words and never appear here or in the prompts (lib/video-discovery/core.mjs).

export const EVENT_TYPES = Object.freeze([
  'BRIEFING',          // someone addresses the camera or the group before action
  'ENTRY',             // a door, gate or threshold is opened or crossed
  'FORCE_CONTACT',     // physical contact between people that moves or holds someone
  'RESTRAINT_APPLIED', // cuffs, irons, straps, holds
  'POSITION_CHANGE',   // the subject's body position changes (see subject_position)
  'VERBAL',            // a spoken exchange worth its own entry
  'MEDICAL',           // medical staff present, assessment, treatment, refusal
  'TRANSPORT',         // the subject is moved: walked, carried, wheeled
  'CAMERA',            // the camera moves, is blocked, cuts, or changes operator
  'OTHER',
]);

export const COVERAGE_STATUSES = Object.freeze(['CLEAR', 'PARTIAL', 'OCCLUDED']);
export const POSITIONS = Object.freeze(['PRONE', 'SUPINE', 'SIDE', 'SEATED', 'STANDING', 'KNEELING', 'CARRIED', 'UNKNOWN']);
export const BASES = Object.freeze(['visual', 'audio', 'both']);
export const CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
export const CLAIM_FINDINGS = Object.freeze(['CORROBORATES', 'REFUTES', 'CANNOT_DETERMINE_FROM_FOOTAGE']);

const num = (description) => ({ type: 'number', description });
const str = (description) => ({ type: 'string', description });
const strEnum = (values, description) => ({ type: 'string', enum: [...values], description });
const nullableStr = (description) => ({ type: 'string', nullable: true, description });

/** One recording, as the model saw it. Times are seconds from the start of the recording. */
export const EVENT_GRAPH_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    video: {
      type: 'object',
      properties: {
        duration_sec: num('Length of the recording in seconds, as best the model can tell.'),
        has_audio: { type: 'boolean' },
        camera_description: str('What kind of camera this appears to be and how it is carried (handheld, fixed, body-worn) — factual, one sentence.'),
      },
      required: ['duration_sec', 'has_audio', 'camera_description'],
    },
    actors: {
      type: 'array',
      description: 'Every distinct person who appears. Identify by what is visible, never by guessing a name that is not spoken or written on screen.',
      items: {
        type: 'object',
        properties: {
          id: str('Short stable handle used in events, e.g. "A1", "A2".'),
          label: str('How a viewer would describe this person, e.g. "officer with shield", "person in white coat".'),
          identifying_marks: str('Stencils, badges, clothing, equipment, or spoken names/ranks — exactly as seen or heard.'),
          role_observed: str('What this person does in the footage, in plain words.'),
          first_seen_sec: num('First appearance, seconds from the start.'),
        },
        required: ['id', 'label', 'identifying_marks', 'role_observed', 'first_seen_sec'],
      },
    },
    events: {
      type: 'array',
      description: 'A chronological account of what happens. One entry per distinct action or exchange.',
      items: {
        type: 'object',
        properties: {
          start_sec: num('Seconds from the start of the recording.'),
          end_sec: { type: 'number', nullable: true, description: 'When the action ends, if it has a duration.' },
          type: strEnum(EVENT_TYPES, 'Category of the event.'),
          actor_ids: { type: 'array', items: { type: 'string' }, description: 'Handles from actors[] involved.' },
          description: str('What is seen and heard, in neutral factual language. No conclusions about intent, necessity or lawfulness.'),
          basis: strEnum(BASES, 'Whether the entry rests on what is seen, what is heard, or both.'),
          confidence: strEnum(CONFIDENCES, 'How sure the model is about this entry as described.'),
          verbatim_quote: nullableStr('Spoken words, exactly as heard, if the event is or includes speech.'),
        },
        required: ['start_sec', 'end_sec', 'type', 'actor_ids', 'description', 'basis', 'confidence', 'verbatim_quote'],
      },
    },
    camera_coverage: {
      type: 'array',
      description: 'Intervals describing what the camera could see. Cover the whole recording; adjacent intervals with the same status may be merged.',
      items: {
        type: 'object',
        properties: {
          start_sec: num('Interval start.'),
          end_sec: num('Interval end.'),
          status: strEnum(COVERAGE_STATUSES, 'CLEAR: the main action is in view. PARTIAL: some of it. OCCLUDED: the main action is out of view or blocked.'),
          obstructed_by: { type: 'array', items: { type: 'string' }, description: 'What blocks the view, if anything: bodies, equipment, doorframe, darkness, motion blur.' },
          what_is_not_visible: str('In plain words, what a viewer cannot verify from this footage during the interval. Empty if CLEAR.'),
        },
        required: ['start_sec', 'end_sec', 'status', 'obstructed_by', 'what_is_not_visible'],
      },
    },
    subject_position: {
      type: 'array',
      description: 'If one person is the focus of the recording (the person being moved, held, examined), their body position over time. Empty if there is no such person.',
      items: {
        type: 'object',
        properties: {
          start_sec: num('Interval start.'),
          end_sec: num('Interval end.'),
          position: strEnum(POSITIONS, 'Body position during the interval.'),
          restrained: { type: 'boolean', description: 'Whether restraints are visibly applied during the interval.' },
          basis: strEnum(BASES, 'How the position is known.'),
          confidence: strEnum(CONFIDENCES, 'How sure the model is.'),
        },
        required: ['start_sec', 'end_sec', 'position', 'restrained', 'basis', 'confidence'],
      },
    },
    transcript: {
      type: 'array',
      description: 'Everything spoken, verbatim, with who said it where that is clear.',
      items: {
        type: 'object',
        properties: {
          start_sec: num('When the utterance begins.'),
          speaker: str('An actor handle from actors[] or a description like "unseen voice".'),
          text: str('The words as spoken. [inaudible] where unclear.'),
        },
        required: ['start_sec', 'speaker', 'text'],
      },
    },
  },
  required: ['video', 'actors', 'events', 'camera_coverage', 'subject_position', 'transcript'],
});

/** One question about one window of one recording. */
export const INTERROGATION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    answer_markdown: str('The answer, in plain factual prose with [mm:ss] timestamps for every statement about the footage. No legal conclusions.'),
    cited_intervals: {
      type: 'array',
      description: 'The moments the answer rests on.',
      items: {
        type: 'object',
        properties: {
          start_sec: num('Interval start.'),
          end_sec: num('Interval end.'),
          what_is_seen: str('What is visible and audible in this interval, factually.'),
        },
        required: ['start_sec', 'end_sec', 'what_is_seen'],
      },
    },
    line_of_sight: {
      type: 'object',
      description: 'Whether the camera could see what the question is about.',
      properties: {
        status: strEnum(COVERAGE_STATUSES, 'Across the window asked about.'),
        basis: str('What in the footage supports that status.'),
        what_cannot_be_seen: str('What a viewer cannot verify from this footage, in plain words. Empty if nothing relevant is hidden.'),
      },
      required: ['status', 'basis', 'what_cannot_be_seen'],
    },
    claim_assessments: {
      type: 'array',
      description: 'One entry per claim supplied with the question, in the same order. Empty if none were supplied.',
      items: {
        type: 'object',
        properties: {
          claim_text: str('The claim, as supplied.'),
          finding: strEnum(CLAIM_FINDINGS, 'Whether the footage in the window shows the claim to be so, shows it not to be so, or cannot settle it.'),
          basis: str('The specific moments and observations the finding rests on, with [mm:ss] timestamps.'),
        },
        required: ['claim_text', 'finding', 'basis'],
      },
    },
    limitations: {
      type: 'array',
      items: { type: 'string' },
      description: 'What limits this answer: occlusion, audio quality, camera angle, the window boundaries, anything the model is unsure of.',
    },
  },
  required: ['answer_markdown', 'cited_intervals', 'line_of_sight', 'claim_assessments', 'limitations'],
});
