// The Courtroom — deterministic panel sampler (spec §4).
//
// Two hard guarantees, both tested by scripts/courtroom-eval.mjs:
//
//   1. DETERMINISM — same seed + same venue mix ⇒ byte-identical panel. Every
//      random draw comes from a PRNG keyed on (seed, seat, stream-name), so
//      the panel a lawyer approved is exactly reproducible from the stored
//      trial row.
//
//   2. THE RAIL — demographics condition NOTHING in the reasoning layer. The
//      composition stream and the reasoning stream are separate PRNGs; the
//      reasoning stream is keyed on (seed, seat, occupation_class) only. Five
//      decades of jury research: attitudes conditioned on occupation and
//      lived experience out-predict demographics, and LLM demographic
//      personas stereotype. So attitudes here derive from occupation and
//      sampled experiences — change the race/gender/age/education mix and,
//      occupation held equal, the attitudes do not move. (The eval asserts
//      this.) Display names come from a third, unconditioned stream: they are
//      cosmetic and deliberately uncorrelated with any composition field.

import type {
  AgeBand, CognitiveStyle, CommunicationStyle, Education, Gender,
  JurorAttitudes, JurorProfile, OccupationClass, PanelSize, RaceEthnicity,
  SalienceBias, VenueMix,
} from './types.ts';

/* ============================ Seeded PRNG ================================= */

/** FNV-1a over a string — stable 32-bit hash for stream keys. */
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, deterministic. */
function mulberry32(a: number): () => number {
  let state = a >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stream(seed: number, seat: number, name: string): () => number {
  return mulberry32(hashKey(`${seed}:${seat}:${name}`));
}

/** Weighted draw. Consumes exactly one rng value regardless of weights, so a
 *  change to one dimension's weights never shifts any other dimension's draw. */
function draw<K extends string>(rng: () => number, weights: Record<K, number>): K {
  const entries = Object.entries(weights) as [K, number][];
  const total = entries.reduce((s, [, w]) => s + Math.max(0, w), 0);
  const r = rng() * (total > 0 ? total : entries.length);
  let acc = 0;
  for (const [k, w] of entries) {
    acc += total > 0 ? Math.max(0, w) : 1;
    if (r < acc) return k;
  }
  return entries[entries.length - 1][0];
}

function pick<T>(rng: () => number, pool: readonly T[]): T {
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

const clamp17 = (n: number) => Math.max(1, Math.min(7, Math.round(n)));

/* ======================= Default venue mix (balanced) ===================== */

export const DEFAULT_VENUE_MIX: VenueMix = {
  age: { '18-24': 12, '25-34': 20, '35-44': 20, '45-54': 18, '55-64': 16, '65+': 14 },
  gender: { F: 50, M: 48, NB: 2 },
  race_ethnicity: {
    White: 55, Black: 14, Hispanic: 18, Asian: 7, 'Native American': 2, 'Multiracial/Other': 4,
  },
  education: {
    'HS or less': 26, 'HS+some college': 30, 'College degree': 30, Postgraduate: 14,
  },
  occupation: {
    healthcare: 10, trades: 10, office_admin: 12, small_business: 8, education: 8,
    tech: 8, retail_service: 14, finance: 6, government: 7, transport: 7, retired: 10,
  },
};

/* ================= Occupation-conditioned reasoning tables ================ */
//
// The reasoning layer's raw material. Each occupation class carries concrete
// occupation details, occupation-linked experiences, and DOCUMENTED attitude
// shifts (small, ±1-2) applied to a neutral baseline of 4. Shifts encode
// occupational-socialization findings (e.g. small-business owners rate
// personal responsibility high and claims-consciousness low; healthcare
// workers see institutional failure up close), NOT demographics.

interface OccupationSpec {
  details: readonly string[];
  experiences: readonly string[];
  shifts: Partial<JurorAttitudes>;
}

const OCCUPATIONS: Record<OccupationClass, OccupationSpec> = {
  healthcare: {
    details: [
      'ER intake nurse, 18 years', 'home health aide, 6 years',
      'hospital billing coordinator, 11 years', 'physical therapist in private practice',
    ],
    experiences: [
      'has watched an insurer deny a claim she thought was obviously covered',
      'manages an aging parent\'s care and paperwork',
      'was deposed once as a records custodian and found it grinding but fair',
    ],
    shifts: { corporate_skepticism: 1, claims_consciousness: 1, risk_tolerance: -1 },
  },
  trades: {
    details: [
      'union electrician, 22 years', 'HVAC contractor with two employees',
      'commercial plumber, foreman for the last five years', 'auto-body technician',
    ],
    experiences: [
      'lost a month of work to a customer who never paid; small-claims court got half of it back',
      'saw a coworker hurt on a job where the safety paperwork was all in order',
      'reads every contract twice since a change-order dispute went bad',
    ],
    shifts: { personal_responsibility_ethic: 1, institutional_trust: -1, authority_orientation: 1 },
  },
  office_admin: {
    details: [
      'school district payroll administrator', 'legal assistant at a three-lawyer firm',
      'office manager for a dental practice', 'insurance claims processor, 9 years',
    ],
    experiences: [
      'processes the paperwork nobody reads and knows exactly where errors hide',
      'once caught a five-figure billing error nobody else had noticed',
      'sat on a jury years ago and took the instructions very seriously',
    ],
    shifts: { authority_orientation: 1, institutional_trust: 1 },
  },
  small_business: {
    details: [
      'owns a two-truck landscaping company', 'runs a family restaurant, 14 years',
      'independent bookkeeper with thirty small-business clients', 'owns a franchise print shop',
    ],
    experiences: [
      'was sued once by a customer and settled to make it go away; still resents it',
      'has personally guaranteed a business loan',
      'fired an employee and spent a year worried about being sued for it',
    ],
    shifts: { personal_responsibility_ethic: 2, claims_consciousness: -2, risk_tolerance: 1, corporate_skepticism: -1 },
  },
  education: {
    details: [
      'middle-school science teacher, 15 years', 'community college adjunct, three campuses',
      'high-school guidance counselor', 'preschool director',
    ],
    experiences: [
      'documents everything after a parent complaint went to the school board',
      'has mediated a hundred versions of he-said-she-said and trusts neither side\'s first story',
      'union rep for her building; has sat across from administration in grievance hearings',
    ],
    shifts: { institutional_trust: 1, claims_consciousness: 1, authority_orientation: -1 },
  },
  tech: {
    details: [
      'QA engineer at a logistics software company', 'freelance web developer',
      'IT support lead for a hospital network', 'data analyst at a regional bank',
    ],
    experiences: [
      'reads terms of service for fun and has opted out of three arbitration clauses',
      'was laid off once by email and read every line of the severance agreement',
      'files bug reports for a living and wants reproducible evidence for every claim',
    ],
    shifts: { risk_tolerance: 1, institutional_trust: -1, corporate_skepticism: 1 },
  },
  retail_service: {
    details: [
      'shift supervisor at a grocery chain, 12 years', 'restaurant server and bartender',
      'call-center team lead for a cable company', 'hotel front-desk manager',
    ],
    experiences: [
      'has been on the receiving end of corporate policy that made no sense on the floor',
      'was once accused of a register shortage that turned out to be a software error',
      'knows exactly how often the customer is not right',
    ],
    shifts: { corporate_skepticism: 1, personal_responsibility_ethic: 1, institutional_trust: -1 },
  },
  finance: {
    details: [
      'branch manager at a credit union', 'staff accountant for a construction firm',
      'mortgage loan processor', 'financial-aid officer at a state university',
    ],
    experiences: [
      'unwinds other people\'s paperwork disasters for a living',
      'has denied loans she wished she could approve, because the numbers were the numbers',
      'testified once in a small embezzlement case as a records witness',
    ],
    shifts: { authority_orientation: 1, risk_tolerance: -1, claims_consciousness: -1 },
  },
  government: {
    details: [
      'city building inspector, 17 years', 'DMV supervisor',
      'county social worker', 'postal carrier, 20 years on the same route',
    ],
    experiences: [
      'enforces rules he did not write and has opinions about which ones matter',
      'has been yelled at by people who were wrong and by people who were right',
      'saw a colleague disciplined on a technicality and thinks process cuts both ways',
    ],
    shifts: { institutional_trust: 1, authority_orientation: 1 },
  },
  transport: {
    details: [
      'long-haul truck driver, owner-operator', 'city bus driver, 13 years',
      'delivery fleet dispatcher', 'forklift operator at a distribution center',
    ],
    experiences: [
      'was in a fender-bender lawsuit that settled; felt the system was slow but fair',
      'logs every mile and every hour because the log is what saves you',
      'has seen dashcam footage contradict a confident eyewitness',
    ],
    shifts: { personal_responsibility_ethic: 1, claims_consciousness: 1 },
  },
  retired: {
    details: [
      'retired machinist; worked one plant for 31 years', 'retired elementary teacher',
      'retired claims adjuster', 'retired Navy chief petty officer, second career as a school custodian',
    ],
    experiences: [
      'has served on two juries and remembers both verdicts',
      'watched a pension promise get renegotiated late in life',
      'has time to read every page of anything put in front of him',
    ],
    shifts: { authority_orientation: 1, institutional_trust: -1, risk_tolerance: -1 },
  },
};

/** General experience pool (occupation-neutral). Some carry attitude shifts. */
const GENERAL_EXPERIENCES: readonly { text: string; shifts?: Partial<JurorAttitudes> }[] = [
  { text: 'sued once over a fender-bender, felt the system was fair', shifts: { institutional_trust: 1 } },
  { text: 'went through a contested insurance claim after a house fire', shifts: { claims_consciousness: 1, corporate_skepticism: 1 } },
  { text: 'raised three kids on one income and budgets to the dollar', shifts: { personal_responsibility_ethic: 1 } },
  { text: 'volunteers at a legal-aid intake desk one Saturday a month', shifts: { claims_consciousness: 1 } },
  { text: 'was a witness in a workplace dispute and hated every minute of it' },
  { text: 'lost money co-signing a loan for a relative', shifts: { risk_tolerance: -1 } },
  { text: 'coaches a youth soccer team and referees the parents more than the kids' },
  { text: 'went back to school at night to finish a degree', shifts: { personal_responsibility_ethic: 1 } },
  { text: 'had a landlord keep a deposit unfairly and won it back in small claims', shifts: { claims_consciousness: 1, institutional_trust: 1 } },
  { text: 'cares for a spouse with a chronic illness and fights the paperwork monthly', shifts: { corporate_skepticism: 1 } },
];

/* ======================== Style + voice generation ======================== */

const COGNITIVE_STYLES: readonly CognitiveStyle[] = ['analytic', 'narrative', 'social', 'driver'];
const COMMUNICATION_STYLES: readonly CommunicationStyle[] = ['talkative', 'reserved', 'friendly', 'blunt'];
const SALIENCE_BIASES: readonly SalienceBias[] = ['numbers', 'story', 'credibility', 'fairness'];

const REGISTERS: Record<CommunicationStyle, string> = {
  talkative: 'plain, warm, thinks out loud',
  reserved: 'quiet, careful, speaks when sure',
  friendly: 'plain, warm, looks for common ground',
  blunt: 'direct, economical, allergic to spin',
};

// Unified, deliberately mixed name pool. Names are drawn from their own
// stream, uncorrelated with every composition field — a name here never
// encodes race, gender, or anything else (spec §2.3 rail).
const FIRST_NAMES: readonly string[] = [
  'Marisol', 'Dennis', 'Aisha', 'Walt', 'Priya', 'Ruth', 'Marcus', 'Elena',
  'Tomás', 'Grace', 'Hank', 'Naomi', 'Jerome', 'Lily', 'Sam', 'Dolores',
  'Kevin', 'Amara', 'Ray', 'June', 'Omar', 'Patricia', 'Cole', 'Vera',
];
const LAST_INITIALS: readonly string[] = [
  'A', 'B', 'C', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'R', 'S', 'T', 'V', 'W',
];

function buildBackstory(reasoning: {
  occupation_detail: string; life_experiences: string[];
  cognitive_style: CognitiveStyle; salience_bias: SalienceBias;
}): string {
  const styleLine: Record<CognitiveStyle, string> = {
    analytic: 'Wants things to add up before deciding anything.',
    narrative: 'Decides by whether the story hangs together.',
    social: 'Reads people first and documents second.',
    driver: 'Impatient with hand-wringing; wants to get to the point and decide.',
  };
  const biasLine: Record<SalienceBias, string> = {
    numbers: 'Numbers stick; adjectives do not.',
    story: 'Remembers the moments that felt true.',
    credibility: 'Keeps a private ledger of who seemed straight and who dodged.',
    fairness: 'Keeps asking what would be fair to both sides.',
  };
  return [
    `${capitalize(reasoning.occupation_detail)}.`,
    reasoning.life_experiences.map((e) => capitalize(e) + '.').join(' '),
    styleLine[reasoning.cognitive_style],
    biasLine[reasoning.salience_bias],
  ].join(' ');
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/* ============================ The sampler ================================= */

/**
 * Draw one juror. Exposed for tests; use samplePanel() for the full box.
 * `id` is assigned by the caller at persist time (crypto UUID in the app);
 * here we derive a stable placeholder so the pure layer stays deterministic.
 */
export function sampleJuror(mix: VenueMix, seed: number, seat: number): JurorProfile {
  // --- Composition stream: one draw per dimension, fixed order. ---
  const compRng = stream(seed, seat, 'composition');
  const age_band = draw<AgeBand>(compRng, mix.age);
  const gender = draw<Gender>(compRng, mix.gender);
  const race_ethnicity = draw<RaceEthnicity>(compRng, mix.race_ethnicity);
  const education = draw<Education>(compRng, mix.education);
  const occupation_class = draw<OccupationClass>(compRng, mix.occupation);

  // --- Reasoning stream: keyed on occupation ONLY (the rail). ---
  const rng = stream(seed, seat, `reasoning:${occupation_class}`);
  const spec = OCCUPATIONS[occupation_class];
  const occupation_detail = pick(rng, spec.details);

  const occExperience = pick(rng, spec.experiences);
  const general = GENERAL_EXPERIENCES[Math.floor(rng() * GENERAL_EXPERIENCES.length)];
  const life_experiences = [occExperience, general.text];

  // Attitudes: neutral baseline 4, plus documented occupation shifts, plus the
  // drawn general experience's shifts, plus small per-juror noise (−1..+1).
  const attitudes: JurorAttitudes = {
    institutional_trust: 4, claims_consciousness: 4, authority_orientation: 4,
    risk_tolerance: 4, corporate_skepticism: 4, personal_responsibility_ethic: 4,
  };
  const applyShifts = (shifts?: Partial<JurorAttitudes>) => {
    if (!shifts) return;
    for (const [k, v] of Object.entries(shifts)) {
      attitudes[k as keyof JurorAttitudes] += v as number;
    }
  };
  applyShifts(spec.shifts);
  applyShifts(general.shifts);
  for (const k of Object.keys(attitudes) as (keyof JurorAttitudes)[]) {
    attitudes[k] = clamp17(attitudes[k] + (Math.floor(rng() * 3) - 1));
  }

  const cognitive_style = pick(rng, COGNITIVE_STYLES);
  const communication = pick(rng, COMMUNICATION_STYLES);
  const salience_bias = pick(rng, SALIENCE_BIASES);

  const reasoning = {
    occupation_detail, life_experiences, attitudes,
    cognitive_style, communication, salience_bias,
  };

  // --- Name stream: independent of composition AND reasoning. ---
  const nameRng = stream(seed, seat, 'name');
  const display_name = `${pick(nameRng, FIRST_NAMES)} ${pick(nameRng, LAST_INITIALS)}.`;

  return {
    id: `seat-${seat}`, // replaced with a real UUID at persist time
    seat,
    display_name,
    composition: { age_band, gender, race_ethnicity, education, occupation_class },
    reasoning,
    voice: {
      backstory: buildBackstory(reasoning),
      register: REGISTERS[communication],
    },
  };
}

/** Same seed + same mix ⇒ identical panel, every time. */
export function samplePanel(mix: VenueMix, seed: number, panelSize: PanelSize): JurorProfile[] {
  const panel: JurorProfile[] = [];
  for (let seat = 1; seat <= panelSize; seat++) {
    panel.push(sampleJuror(mix, seed, seat));
  }
  return panel;
}

/** Regenerate voice fields after the lawyer edits reasoning on the sheet. */
export function refreshVoice(profile: JurorProfile): JurorProfile {
  return {
    ...profile,
    voice: {
      backstory: buildBackstory(profile.reasoning),
      register: REGISTERS[profile.reasoning.communication],
    },
  };
}
