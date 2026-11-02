// Open in Word (docs/specs/WORD-ROUNDTRIP-2026-11-01.md).
//
// The file leaves through the Download door (every matter, sealed or not:
// `file.exported {destination:'download'}` lands in the Record first), is
// tagged with the document's id so the Equazia pane in Word knows what it is
// looking at, and is handed to the browser as a download. Word opens it from
// there. A direct launch (ms-word:ofe|u|…) is a follow-up once tried on a
// real machine.

import { downloadDocumentFile } from '@/lib/vault-object';
import { writeDocxTag } from '@/lib/docx-tag';

export const isWordFile = (name: string | null | undefined): boolean => /\.docx$/i.test(name ?? '');

export interface OpenInWordTarget {
  id: string;
  matterspace_id: string | null;
  source_filename: string | null;
  title: string | null;
}

/** Throws what downloadDocumentFile throws (a step-up refusal included). */
export async function openInWord(doc: OpenInWordTarget): Promise<void> {
  const { blob, filename } = await downloadDocumentFile(doc.id);
  const raw = new Uint8Array(await blob.arrayBuffer());
  let bytes: Uint8Array;
  try {
    bytes = await writeDocxTag(raw, { documentId: doc.id, matterId: doc.matterspace_id });
  } catch {
    bytes = raw; // not a .docx we can open: hand it over as it is
  }
  const name = doc.source_filename || filename || `${(doc.title || 'document').replace(/[\\/:*?"<>|]+/g, '_')}.docx`;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = /\.docx$/i.test(name) ? name : `${name}.docx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
