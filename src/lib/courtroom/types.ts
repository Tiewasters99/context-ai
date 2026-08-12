// The Courtroom — core types (Phase 1: Quick Panel).
//
// Spec: docs/MOCK_TRIAL_SPEC_2026-08-07.md. The juror model here mirrors §4
// EXACTLY: a composition layer (who is in the box — appears on the panel
// sheet, drives nothing else) and a reasoning layer (why a juror decides —
// the only thing the agents run on). Keeping the two layers in separate
// objects is the load-bearing design: the sampler and the prompts can prove
// they never read composition when reasoning.
//
// NOTE for tooling: files in this folder use relative imports with explicit
// .ts extensions (allowed by tsconfig `allowImportingTsExtensions`) so the
// eval harness (scripts/courtroom-eval.mjs) can import the deterministic
// machinery directly under Node's type stripping — no bundler required.

/* ============================ Juror model (§4) ============================ */

export type AgeBand = '18-24' | '25-34' | '35-44' | '45-54' | '55-64' | '65+';
export type Gender = 'F' | 'M' | 'NB';
export type RaceEthnicity =
  | 'White' | 'Black' | 'Hispanic' | 'Asian' | 'Native American' | 'Multiracial/Other';
export type Education =
  | 'HS or less' | 'HS+some college' | 'College degree' | 'Postgraduate';
export type OccupationClass =
  | 'healthcare' | 'trades' | 'office_admin' | 'small_business' | 'education'
  | 'tech' | 'retail_service' | 'finance' | 'government' | 'transport' | 'retired';

/** Who is in the box. Panel-sheet facts only — conditions NOTHING downstream. */
export interface JurorComposition {
  age_band: AgeBand;
  gender: Gender;
  race_ethnicity: RaceEthnicity;
  education: Education;
  occupation_class: OccupationClass;
}

/** 1-7 scales; per the spec these are the predictive engine. */
export interface JurorAttitudes {
  institutional_trust: number;
  claims_consciousness: number;
  authority_orientation: number;
  risk_tolerance: number;
  corporate_skepticism: number;
  personal_responsibility_ethic: number;
}

export type CognitiveStyle = 'analytic' | 'narrative' | 'social' | 'driver';
export type CommunicationStyle = 'talkative' | 'reserved' | 'friendly' | 'blunt';
export type SalienceBias = 'numbers' | 'story' | 'credibility' | 'fairness';

/** Why a juror decides. Sampled conditioned on occupation + experience ONLY. */
export interface JurorReasoning {
  occupation_detail: string;
  life_experiences: string[];
  attitudes: JurorAttitudes;
  cognitive_style: CognitiveStyle;
  communication: CommunicationStyle;
  salience_bias: SalienceBias;
}

export interface JurorVoice {
  /** One paragraph, generated from reasoning fields (never from composition). */
  backstory: string;
  register: string;
}

export interface JurorProfile {
  id: string;
  seat: number;
  display_name: string;
  composition: JurorComposition;
  reasoning: JurorReasoning;
  voice: JurorVoice;
}

/* ========================== Venue mix (§12.3, v1) ========================= */

/**
 * Manual sliders: relative weights per category within each composition
 * dimension (0-100; only ratios matter). Census presets come later.
 */
export interface VenueMix {
  age: Record<AgeBand, number>;
  gender: Record<Gender, number>;
  race_ethnicity: Record<RaceEthnicity, number>;
  education: Record<Education, number>;
  occupation: Record<OccupationClass, number>;
}

export type PanelSize = 6 | 12;

/* ============================ Trial + segments ============================ */

export type TrialMode = 'quick' | 'full';
export type TrialStatus = 'empanel' | 'segments' | 'running' | 'complete' | 'error';

export interface MockTrial {
  id: string;
  matterspace_id: string;
  title: string;
  mode: TrialMode;
  status: TrialStatus;
  /** house_panel marks a trial empaneled from a named house venire (A/B)
   *  rather than sampled from the mix; the 3D room keys portraits and
   *  bios off it. */
  venue_mix: VenueMix & { panel_size: PanelSize; house_panel?: 'A' | 'B' };
  seed: number;
  model_id: string;
  usage: UsageRecord | Record<string, never>;
  created_at: string;
  updated_at: string;
}

export type SegmentKind = 'opening' | 'direct' | 'cross' | 'closing' | 'exhibit';
export type Side = 'ours' | 'theirs';

export interface Segment {
  id: string;
  kind: SegmentKind;
  side: Side;
  transcript: string;
  position: number;
  source_document_id?: string | null;
}

/* =========================== Reactions (§5) =============================== */

/** A record cite: verbatim quote + a locator that resolves in the transcript. */
export interface RecordCite {
  quote: string;
  /** e.g. "Seg 2 (cross, theirs) ¶4" — or page:line when the source carries it. */
  locator: string;
}

export interface SalienceItem extends RecordCite {
  moment: string;
  why_it_stuck: string;
}

export interface ConfusionPoint {
  point: string;
  locator: string;
}

export interface CredibilityImpression {
  subject: string;
  impression: string;
}

/** One juror's private reaction to one segment. Never shown to other jurors. */
export interface Reaction {
  juror_id: string;
  segment_id: string;
  salience: SalienceItem[];
  confusions: ConfusionPoint[];
  credibility: CredibilityImpression[];
  gut: string;
}

/* ============================ Ballots (§5/§6) ============================= */

export type Leaning = 'ours' | 'theirs' | 'undecided';

export interface BallotReason extends RecordCite {
  reason: string;
}

export interface Ballot {
  juror_id: string;
  /** Round 0 = the secret first ballot, cast before any discussion. */
  round: number;
  leaning: Leaning;
  conviction: number; // 1-7
  reasons: BallotReason[];
}

/* ================= Objections / rulings / strikes (§5, Phase 2) =========== */

export type ObjectionGround =
  | 'hearsay'            // FRE 802 — out-of-court statement offered for its truth
  | 'characterization'   // argumentative / assumes facts — FRE 611(a)
  | 'speculation'        // state of mind without foundation — FRE 602/701
  | 'prejudice';         // probative value substantially outweighed — FRE 403

/** A deterministically nominated span the opposing-counsel agent reviews.
 *  Paragraph granularity: span = one ¶ of one segment. */
export interface CandidateSpan {
  segment_id: string;
  /** 1-based paragraph number — matches the "¶n" locators jurors cite. */
  para: number;
  tag: ObjectionGround;
  text: string;
}

/** The opposing-counsel agent's decision to stand and object. */
export interface Objection {
  segment_id: string;
  para: number;
  ground: ObjectionGround;
  basis: string; // one sentence, spoken in court
}

/** The judge's ruling on one objection (FRE-grounded, one paragraph). */
export interface Ruling {
  segment_id: string;
  para: number;
  ground: ObjectionGround;
  ruling: 'sustained' | 'overruled';
  explanation: string;
  /** Present iff sustained — the instruction read to the jury. */
  disregard_instruction?: string;
}

/** A sustained objection: the ¶ is stricken but STAYS in juror memory,
 *  flagged with the instruction (spec §5 — the signature mechanic). */
export interface Strike {
  segment_id: string;
  para: number;
  ground: ObjectionGround;
  instruction: string;
  /** The stricken paragraph's text (for leakage matching + the report). */
  text: string;
}

export interface TrialProcedure {
  candidates: CandidateSpan[];
  objections: Objection[];
  rulings: Ruling[];
  strikes: Strike[];
}

/* ===================== Leakage & Twin Panel (§5, Phase 2) ================= */

/** One place stricken material resurfaced (or was policed) after the strike. */
export interface LeakageSighting {
  seat: number;
  juror_id: string;
  round: number;
  where: 'speech' | 'ballot';
  excerpt: string;
}

export interface LeakageFinding {
  strike: Strike;
  /** e.g. "Seg 1 ¶4" — the locator jurors would cite. */
  locator: string;
  resurfaced: LeakageSighting[];
  policed: LeakageSighting[];
  /** Jurors whose FINAL ballot reasons still lean on the stricken span. */
  in_final_ballots: LeakageSighting[];
}

/** Twin Panel: the same jurors run against a record that never contained the
 *  stricken material. The delta is the measured cost of the moment. */
export interface TwinDeltaRow {
  juror_id: string;
  seat: number;
  main: { leaning: Leaning; conviction: number };
  twin: { leaning: Leaning; conviction: number };
}

export interface TwinResult {
  deliberation: DeliberationResult;
  delta: TwinDeltaRow[];
  main_tally: { ours: number; theirs: number; undecided: number };
  twin_tally: { ours: number; theirs: number; undecided: number };
}

/* ========================== Deliberation (§6) ============================= */

export interface DeliberationTurn {
  round: number;
  juror_id: string;
  seat: number;
  role: 'foreman' | 'speaker';
  /** Display name of the prior speaker this turn responds to (null = opens). */
  responding_to: string | null;
  speech: string;
}

export interface RoundRecord {
  round: number;
  turns: DeliberationTurn[];
  ballots: Ballot[];
  /** Sum over jurors of |Δconviction| + 2·(leaning changed) vs prior round. */
  movement: number;
}

export type StopReason = 'unanimous' | 'hung' | 'max_rounds';

export interface DeliberationResult {
  firstBallots: Ballot[];
  rounds: RoundRecord[];
  stop_reason: StopReason;
  movement_by_juror: Record<string, number>;
  total_movement: number;
  foreman_juror_id: string;
}

export interface SessionResult {
  reactions: Reaction[];
  deliberation: DeliberationResult;
  /** Present in full mode (Phase 2). */
  procedure?: TrialProcedure;
  leakage?: LeakageFinding[];
  twin?: TwinResult;
}

/* ============================ Metering ==================================== */

export interface StageUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Accumulated per-session usage, stored on mock_trials.usage. The llm layer
 * does not surface provider token counts, so Phase 1 meters with
 * estimateTokens and says so (`estimated: true`, estimate labels in the UI).
 */
export interface UsageRecord {
  model_id: string;
  estimated: true;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  by_stage: Record<string, StageUsage>;
  /** List-rate estimate in USD (no cache discount applied); null if the model has no known rate. */
  cost_estimate_usd: number | null;
  note: string;
}

/* ========================= Engine ports (DI seam) ========================= */

export interface ProgressEvent {
  stage:
    | 'reactions' | 'first_ballot' | 'deliberation' | 'reballot' | 'report'
    | 'objections' | 'ruling' | 'twin';
  detail: string;
  /** Seat currently speaking/reacting, when applicable. */
  seat?: number;
  round?: number;
  /** Set on every event of the Twin Panel pass. */
  twin?: boolean;
}

export interface StructuredCall {
  stage: string;
  jurorId?: string;
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface SpeechCall {
  stage: string;
  jurorId?: string;
  system: string;
  prompt: string;
  maxTokens?: number;
}

/**
 * Everything the engine needs from the outside world. The live implementation
 * (live.ts) routes through src/lib/llm with Fable→Opus refusal fallback and
 * metering; the eval harness injects canned outputs to exercise the
 * deterministic machinery without keys.
 */
export interface EnginePorts {
  structured: <T>(call: StructuredCall) => Promise<T>;
  speech: (call: SpeechCall) => Promise<string>;
  onProgress?: (e: ProgressEvent) => void;
  /** Persistence hooks — optional so the eval can run stateless. */
  saveReaction?: (r: Reaction) => Promise<void>;
  saveBallot?: (b: Ballot) => Promise<void>;
  saveTurn?: (t: DeliberationTurn) => Promise<void>;
  /** Full mode: objection/ruling/strike events (mock_trial_events). */
  saveEvent?: (e: Objection | Ruling | Strike, type: 'objection' | 'ruling' | 'strike') => Promise<void>;
  /** Kill switch: checked before every juror turn; aborting throws SessionAborted. */
  signal?: AbortSignal;
}

/* ============================ Report (§9) ================================= */

export interface ReportInput {
  trialTitle: string;
  matterName: string;
  modelName: string;
  panel: JurorProfile[];
  segments: Segment[];
  reactions: Reaction[];
  deliberation: DeliberationResult;
  usage: UsageRecord | null;
  generatedAt: string; // ISO date
  /** Full Trial (Phase 2) inputs — §5 of the report. */
  mode?: TrialMode;
  procedure?: TrialProcedure;
  leakage?: LeakageFinding[];
  twin?: TwinResult;
}
