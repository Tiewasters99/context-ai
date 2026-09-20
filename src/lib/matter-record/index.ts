// The Matter Record export, end to end.
//
// Read (fetch.ts) → assemble (assemble.ts) → lay out (layout.ts) → render
// (.md, .docx). No model is involved at any step: every cell is copied from a
// recorded entry or left empty for counsel.

import { assembleMatterRecord, type MatterRecordDoc } from './assemble';
import { renderMatterRecordMarkdown } from './render-md';
import { matterRecordDocxBlob } from './render-docx';
import type {
  ExportContext,
  JurisdictionEntry,
  JurisdictionMatrix,
  MatterRecordData,
} from './types';

export { assembleMatterRecord } from './assemble';
export { renderMatterRecordMarkdown } from './render-md';
export { buildMatterRecordDocument, matterRecordDocxBlob } from './render-docx';
export { fetchMatterRecord, matterDescendantIds, readAllPages } from './fetch';
export { matterRecordBlocks } from './layout';
export type { MatterRecordDoc } from './assemble';

/**
 * The bundled rules matrix, loaded on demand.
 *
 * A build-time copy (see build-jurisdictions.py) — never fetched at runtime,
 * so an export produced offline prints the same rule text as one produced
 * online, and the version it came from is printed with it.
 */
export async function loadJurisdictions(): Promise<JurisdictionMatrix> {
  const module = await import('./jurisdictions');
  return module.JURISDICTIONS;
}

export function findJurisdiction(
  matrix: JurisdictionMatrix,
  id: string | null | undefined,
): JurisdictionEntry | null {
  if (!id) return null;
  return matrix.entries.find((entry) => entry.id === id) ?? null;
}

/** Entries in the order a picker should offer them: by name, id as tiebreak. */
export function jurisdictionOptions(
  matrix: JurisdictionMatrix,
): { id: string; name: string; status: string }[] {
  return matrix.entries
    .map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      status: entry.status ?? 'unstated',
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
}

/** Assemble the document model, with the picked jurisdiction row if any. */
export function buildMatterRecordDoc(
  data: MatterRecordData,
  context: ExportContext,
  matrix?: JurisdictionMatrix | null,
): MatterRecordDoc {
  const entry = matrix ? findJurisdiction(matrix, context.jurisdictionId) : null;
  return assembleMatterRecord(
    data,
    context,
    entry && matrix ? { entry, matrixVersion: matrix.matrix_version } : null,
  );
}

/** Both files, from one read. Deterministic for a given context. */
export async function renderMatterRecord(
  data: MatterRecordData,
  context: ExportContext,
  matrix?: JurisdictionMatrix | null,
): Promise<{ doc: MatterRecordDoc; markdown: string; docx: Blob }> {
  const doc = buildMatterRecordDoc(data, context, matrix);
  return {
    doc,
    markdown: renderMatterRecordMarkdown(doc),
    docx: await matterRecordDocxBlob(doc),
  };
}

/** `Matter Record — Calder v. Atlas 2026-09-19.md`, safe on every filesystem. */
export function matterRecordFilename(
  matterName: string,
  day: string,
  extension: '.md' | '.docx',
): string {
  const base = `Matter Record - ${matterName} ${day}`
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || 'Matter Record'}${extension}`;
}
