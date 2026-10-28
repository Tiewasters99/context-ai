// Grapheon Discovery — what to produce for a document taken from the matter
// ("Add from this matter", "Produce this set").
//
// A document that came into the matter through a production is filed in the
// Vault as the PDF the production made of it (ingestDisplayPdf: an imaged
// Word file or email), under its ORIGINAL name. On 2026-10-13 a set produced
// 151 of them: the intake went by the name (".docx"), handed the PDF's bytes
// to LibreOffice as a Word file, and recorded "LibreOffice produced no PDF".
//
// The stored bytes decide, not the name:
//   * bytes that are what the name says (or a PDF named .pdf): as stored;
//   * a PDF filed under a non-PDF name is a RENDITION. If the document records
//     the production item it came from, that item's original is produced (it
//     is imaged afresh, and NATIVES/, MD5 and SHA-256 describe the real file);
//     otherwise the stored PDF is produced as the document's image, under its
//     own name.

import path from 'node:path';
import { extOf } from './util.mjs';

export const isPdfBytes = (buf) => !!buf && buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';

/**
 * @param {{ source_filename?: string|null, storage_path?: string|null, title?: string|null, metadata?: object|null }} doc
 * @param {Buffer} buf  the stored object's bytes
 * @returns {{ kind: 'as-stored' } | { kind: 'rendition', productionItemId: string|null, nameExt: string }}
 */
export function vaultSourcePlan(doc, buf) {
  const name = doc?.source_filename || (doc?.storage_path ? path.basename(doc.storage_path) : '') || doc?.title || '';
  const ext = extOf(name);
  if (ext === '.pdf' || !isPdfBytes(buf)) return { kind: 'as-stored' };
  const id = doc?.metadata?.production_item_id;
  return {
    kind: 'rendition',
    productionItemId: typeof id === 'string' && id ? id : null,
    nameExt: ext,
  };
}
