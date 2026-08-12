// The Courtroom — exhibits from the matter (deterministic machinery).
//
// Spec: docs/COURTROOM_EXHIBITS_AND_VOICE_SPEC_2026-08-11.md §2. Exhibits are
// EVENT-SOURCED on mock_trial_events with zero migration: the table's type
// CHECK admits only ('objection','ruling','strike','note'), so exhibit events
// ride type 'note' — the same precedent deliberation turns set — keyed by
// actor instead:
//
//   actor 'exhibit'          config events; SURVIVE clearSessionData
//     { event: 'registered' | 'updated', exhibit: TrialExhibit }
//     { event: 'removed', key }
//     { event: 'witness_seated', witness: TrialWitness }
//     { event: 'witness_cleared' }
//   actor 'exhibit_session'  run events; wiped with the session
//     { event: 'published', key, exhibit_no }
//
// The current exhibit list is a fold over the trial's events (§2.1). The
// colloquy is a deterministic TEMPLATE keyed to admission status — Eden's
// ruling 2026-08-11: pre-admitted is fully canned, opposing NEVER objects.
// Only a to-offer publication ever thinks (the Phase-2 agents; next build).
//
// Everything here is pure and browser-free so the eval harness can import it
// directly (Node type stripping — relative .ts imports, no bundler).

import type { Side } from './types.ts';

export type ExhibitStatus = 'pre_admitted' | 'to_offer' | 'admitted' | 'refused';

export interface TrialExhibit {
  /** Stable identity across renumbering (crypto.randomUUID at registration). */
  key: string;
  /** "PX-4" / "DX-2" — defaulted by side, editable (Eden: convention stands). */
  exhibit_no: string;
  doc_id: string;
  doc_name: string;
  /** 1-based page for PDFs; null for images. */
  page: number | null;
  title: string;
  side: Side;
  status: ExhibitStatus;
}

export interface TrialWitness {
  name: string;
  /** An image document in the matter; null = a named witness with no portrait. */
  doc_id: string | null;
}

export type ExhibitConfigEvent =
  | { event: 'registered'; exhibit: TrialExhibit }
  | { event: 'updated'; exhibit: TrialExhibit }
  | { event: 'removed'; key: string }
  | { event: 'witness_seated'; witness: TrialWitness }
  | { event: 'witness_cleared' };

export type ExhibitSessionEvent = { event: 'published'; key: string; exhibit_no: string };

export interface ExhibitEventRow {
  actor: string;
  payload: unknown;
}

export interface ExhibitFold {
  exhibits: TrialExhibit[];
  witness: TrialWitness | null;
  publishedKeys: Set<string>;
}

/** The exhibit list is a fold over the trial's events, in insertion order. */
export function foldExhibits(rows: ExhibitEventRow[]): ExhibitFold {
  const exhibits: TrialExhibit[] = [];
  let witness: TrialWitness | null = null;
  const publishedKeys = new Set<string>();
  for (const row of rows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (row.actor === 'exhibit') {
      const e = p as unknown as ExhibitConfigEvent;
      if (e.event === 'registered') exhibits.push(e.exhibit);
      else if (e.event === 'updated') {
        const i = exhibits.findIndex((x) => x.key === e.exhibit.key);
        if (i >= 0) exhibits[i] = e.exhibit;
      } else if (e.event === 'removed') {
        const i = exhibits.findIndex((x) => x.key === e.key);
        if (i >= 0) exhibits.splice(i, 1);
      } else if (e.event === 'witness_seated') witness = e.witness;
      else if (e.event === 'witness_cleared') witness = null;
    } else if (row.actor === 'exhibit_session') {
      const e = p as unknown as ExhibitSessionEvent;
      if (e.event === 'published') publishedKeys.add(e.key);
    }
  }
  return { exhibits, witness, publishedKeys };
}

/** PX-n for our side, DX-n for theirs; next free number for the side. */
export function nextExhibitNo(exhibits: TrialExhibit[], side: Side): string {
  const prefix = side === 'ours' ? 'PX' : 'DX';
  let max = 0;
  for (const e of exhibits) {
    const m = /^([A-Z]+)-(\d+)$/.exec(e.exhibit_no);
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return `${prefix}-${max + 1}`;
}

/** A publishable exhibit: pre-admitted or already admitted. */
export function canPublish(e: TrialExhibit): boolean {
  return e.status === 'pre_admitted' || e.status === 'admitted';
}

/* ============================== The colloquy ============================== */

export interface Colloquy {
  counsel: string;
  judge?: string;
  opposing?: string;
}

/**
 * Pre-admitted publication — FULLY CANNED, no model call, opposing never
 * objects (stipulated is stipulated). The three lines are spoken in order,
 * then the screen arms and the click publishes.
 */
export function publishColloquy(e: TrialExhibit): Colloquy {
  return {
    counsel: `Your Honor, I would like to publish to the jury ${e.exhibit_no}, which has been admitted as a full exhibit.`,
    judge: 'Any objection?',
    opposing: 'No objection, Your Honor.',
  };
}

/** To-offer opening line; the objection/ruling agents complete it (next build). */
export function offerColloquy(e: TrialExhibit): Colloquy {
  return { counsel: `Your Honor, I offer ${e.exhibit_no} into evidence.` };
}

/* =============================== The record =============================== */

const EXCERPT_CHARS = 400;

/** Squash to one ¶ and cap — the record line cites as "Seg n ¶1". */
export function exhibitExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS).trimEnd()}…` : flat;
}

/**
 * What the jurors read: the publication becomes a SEGMENT of kind 'exhibit'
 * (the record was built for this — SegmentKind already carries it), so
 * reactions and deliberation cite PX-n natively. The image itself is not
 * sent to jurors (§2.5 — twelve parallel calls; text description only).
 */
export function exhibitSegmentTranscript(e: TrialExhibit, excerpt: string): string {
  const content = excerpt
    ? `Content: ${excerpt}`
    : 'A photograph/image exhibit shown on the courtroom screen.';
  const pageNote = e.page ? ` (page ${e.page})` : '';
  return `[${e.exhibit_no} PUBLISHED TO THE JURY — "${e.title}"${pageNote}. ${content}]`;
}

/** The label the evidence screen shows — the way the record knows it. */
export function exhibitLabel(e: TrialExhibit): string {
  return `${e.exhibit_no} · ${e.title}`;
}
