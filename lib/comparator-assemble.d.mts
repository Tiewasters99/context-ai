// Types for lib/comparator-assemble.mjs — the Model Comparator's Comparison notes.

export interface RubricDim { key: string; label: string }

export interface AssembleNote {
  id?: string;
  candidate_id: string;
  note?: string | null;
  anchor_text?: string | null;
  tag?: string | null;
  page?: number | null;
  line_start?: number | null;
  line_end?: number | null;
  text_anchor?: { start: number } | null;
  created_at?: string | null;
  author?: string | null;
}

export interface AssembleInput {
  matter: { name: string; short_code?: string | null };
  comparison: {
    title: string;
    type: string;
    type_label?: string | null;
    instructions?: string | null;
    packet?: { id: string; title: string }[];
    packet_hash?: string | null;
    rubric: RubricDim[];
    revealed_at?: string | null;
  };
  candidates: { id: string; label: string; word_count?: number | null; revealed_label?: string | null }[];
  grades: {
    candidate_id: string;
    scores: Record<string, number>;
    overall: number;
    comment?: string | null;
    initials: string;
    graded_at: string;
  }[];
  notes: AssembleNote[];
  generated_at: string;
}

export const GENERAL: Readonly<RubricDim>;
export function countWords(text: string | null | undefined): number;
export function dimensionOf(note: Pick<AssembleNote, 'tag' | 'note'>, rubric: RubricDim[]): RubricDim;
export function compareNotes(a: AssembleNote, b: AssembleNote): number;
export function noteLocation(note: AssembleNote): string;
export function assembleComparisonNotes(input: AssembleInput): string;
