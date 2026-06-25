// Export / Share connectors for documents in the reader.
//
// Each connector is a descriptor: an id, a label, a lucide icon, an optional
// connection it needs (matched against the user's `connections` list by
// `kind`), and a `run` that performs the export given an ExportContext.
//
// The fetch + error-handling shape mirrors the original handleDriveExport in
// DocumentReader: it POSTs to a backend endpoint with the Supabase session
// bearer token, then maps the known error codes to friendly banner text.

import { Download, HardDrive, Mail, type LucideIcon } from 'lucide-react';

// The banner the reader renders. 'ok' carries an optional link (e.g. the Drive
// webViewLink or the Gmail draftsUrl) the user can click to open the result.
export type ExportBanner =
  | { kind: 'ok'; text: string; link: string | null; linkLabel?: string }
  | { kind: 'err'; text: string };

// What a connector needs to do its job. The reader owns these — the connectors
// stay free of React and Supabase specifics beyond the token getter.
export interface ExportContext {
  documentId: string;
  doc: { title: string | null; storage_path: string | null } | null;
  // Returns the Supabase session access token, or null when signed out.
  getToken: () => Promise<string | null>;
  // Client-side original-file download (reuses the reader's handleDownload).
  download: () => Promise<void>;
  setBanner: (b: ExportBanner | null) => void;
  navigateToConnections: () => void;
}

export interface ExportConnector {
  id: string;
  label: string;
  icon: LucideIcon;
  // When set, the connector is only runnable if the user has a `connections`
  // row with this `kind` and status 'connected'.
  needsConnection?: 'google_drive' | 'gmail';
  run: (ctx: ExportContext) => Promise<void>;
}

// POSTs to an export endpoint with the session bearer token and returns the
// parsed JSON body. Throws 'Not signed in' when there is no session.
async function postExport(
  ctx: ExportContext,
  path: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; body: any }> {
  const token = await ctx.getToken();
  if (!token) throw new Error('Not signed in');
  const resp = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await resp.json().catch(() => ({}));
  return { ok: resp.ok && !!body.ok, body };
}

export const EXPORT_CONNECTORS: ExportConnector[] = [
  {
    id: 'download',
    label: 'Download original file',
    icon: Download,
    run: async (ctx) => {
      await ctx.download();
    },
  },
  {
    id: 'google_drive',
    label: 'Save to Google Drive',
    icon: HardDrive,
    needsConnection: 'google_drive',
    run: async (ctx) => {
      ctx.setBanner(null);
      try {
        const { ok, body } = await postExport(ctx, '/api/drive-export', {
          documentId: ctx.documentId,
          folderName: 'Contextspaces',
        });
        if (!ok) {
          // Google's API surfaces details under body.detail.error.message —
          // prefer that string over the bare code when present.
          const googleMsg =
            body?.detail?.error?.message ||
            body?.detail?.error_description ||
            (typeof body?.detail === 'string' ? body.detail : null);
          const msg =
            body.error === 'drive_needs_reconnect'
              ? 'Reconnect Google Drive in Connections — your token expired.'
              : body.error === 'drive_not_connected'
                ? 'Connect Google Drive in Connections first.'
                : body.error === 'file_too_large'
                  ? 'File is too large for Drive export (75 MB cap).'
                  : googleMsg
                    ? `Drive: ${googleMsg}`
                    : body.error || 'Drive export failed.';
          console.error('drive-export failed:', body);
          ctx.setBanner({ kind: 'err', text: msg });
          return;
        }
        ctx.setBanner({
          kind: 'ok',
          text: `Saved to your Google Drive${body.folderName ? ` › ${body.folderName}` : ''}.`,
          link: body.webViewLink ?? null,
          linkLabel: 'Open in Drive',
        });
      } catch (e) {
        ctx.setBanner({
          kind: 'err',
          text: e instanceof Error ? e.message : 'Drive export failed.',
        });
      }
    },
  },
  {
    id: 'gmail',
    label: 'Email (attach to Gmail draft)',
    icon: Mail,
    needsConnection: 'gmail',
    run: async (ctx) => {
      ctx.setBanner(null);
      try {
        const { ok, body } = await postExport(ctx, '/api/gmail-send', {
          documentId: ctx.documentId,
          subject: ctx.doc?.title ?? undefined,
        });
        if (!ok) {
          const googleMsg =
            body?.detail?.error?.message ||
            body?.detail?.error_description ||
            (typeof body?.detail === 'string' ? body.detail : null);
          const msg =
            body.error === 'gmail_needs_reconnect'
              ? 'Reconnect Gmail in Connections — your token expired.'
              : body.error === 'gmail_not_connected'
                ? 'Connect Gmail in Connections first.'
                : body.error === 'file_too_large'
                  ? 'File is too large to attach to a Gmail draft (25 MB cap).'
                  : googleMsg
                    ? `Gmail: ${googleMsg}`
                    : body.error || 'Could not create the Gmail draft.';
          console.error('gmail-send failed:', body);
          ctx.setBanner({ kind: 'err', text: msg });
          return;
        }
        ctx.setBanner({
          kind: 'ok',
          text: 'Draft created in Gmail with the file attached — open Drafts to address and send it.',
          link: body.draftsUrl ?? null,
          linkLabel: 'Open Gmail Drafts',
        });
      } catch (e) {
        ctx.setBanner({
          kind: 'err',
          text: e instanceof Error ? e.message : 'Could not create the Gmail draft.',
        });
      }
    },
  },
];
