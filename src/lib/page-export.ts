// A page, filed in its matter as a Word document.
//
// The page's .docx (src/lib/export-page.ts) was only ever handed to the
// browser as a download. Filing it into the matter's Vault instead gives it
// everything a Vault document already has: the Reader, Save to Google Drive /
// OneDrive / Dropbox, the Gmail draft, the export gate on a sealed matter, and
// the matter's Record. Nothing here talks to a drive: the connectors in
// src/lib/export-connectors.ts take the filed document from here, exactly as
// they take any other.
//
// persistVaultFile never overwrites — a second filing of the same page is a
// second document, named by Supabase with the same filename under a new id.
// The caller (PageExportMenu) reuses one filing while the page is unchanged.

import { pageToDocxBlob, safeFilename } from './export-page';
import { persistVaultFile, resolveMatter } from './vault-persist';

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface FiledPage {
  documentId: string;
  storagePath: string;
  filename: string;
  matterId: string;
  matterName: string;
}

export interface PageSnapshot {
  title: string;
  body: unknown;
}

/** Builds the page's .docx and files it in the matter. Returns the new document. */
export async function filePageAsDocx(matterId: string, page: PageSnapshot): Promise<FiledPage> {
  const ref = await resolveMatter(matterId);
  if (!ref) throw new Error('This page’s matter could not be opened for filing.');
  const title = page.title || 'Untitled Page';
  const blob = await pageToDocxBlob(page.body, title);
  const filename = safeFilename(title, '.docx');
  const file = new File([blob], filename, { type: DOCX_MIME });
  // No ingestDeclaration: a file the app made is estimated from its name and
  // size, the same as a Matter Record export (see PersistOptions).
  const { documentId, storagePath } = await persistVaultFile(ref, file);
  return { documentId, storagePath, filename, matterId: ref.id, matterName: ref.name };
}

/** The key one filing is good for: the same title and body, byte for byte. */
export function pageSnapshotKey(page: PageSnapshot): string {
  return JSON.stringify([page.title, page.body]);
}
