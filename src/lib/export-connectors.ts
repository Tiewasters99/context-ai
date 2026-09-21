// Export / Share connectors for documents in the reader.
//
// Each connector is a descriptor: an id, a label, a lucide icon, an optional
// connection it needs (matched against the user's `connections` list by
// `kind`), and a `run` that performs the export given an ExportContext.
//
// The fetch + error-handling shape mirrors the original handleDriveExport in
// DocumentReader: it POSTs to a backend endpoint with the Supabase session
// bearer token, then maps the known error codes to friendly banner text.
//
// SecureSpace, 2026-09-20 — every connector in this registry goes out through
// ONE server-side gate (lib/export-gate.mjs). When the document is in a sealed
// matter the endpoint answers 409 `export_needs_confirmation` instead of
// exporting, and hands back the sentence to show. `postThroughSeal` below is
// the single place that handles it, so a connector added later — OneDrive,
// Dropbox — inherits the behaviour without writing any of it: give it a
// `run` that calls `postThroughSeal`, and the warning, the re-issue with
// confirm_leave_seal, and the recorded/not-recorded note all work.

import { Cloud, Download, HardDrive, Mail, Package, type LucideIcon } from 'lucide-react';

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
  // Shows the sealed-matter warning and resolves true if the user wants the
  // copy to leave anyway. The host supplies it (SealedExportDialog); the text
  // is the server's, never the host's. Without it a sealed export simply does
  // not happen, and the banner says why.
  confirmLeaveSeal?: (message: string) => Promise<boolean>;
}

export interface ExportConnector {
  id: string;
  label: string;
  icon: LucideIcon;
  // When set, the connector is only runnable if the user has a `connections`
  // row with this `kind` and status 'connected'.
  needsConnection?: ConnectionKind;
  run: (ctx: ExportContext) => Promise<void>;
}

export type ConnectionKind = 'google_drive' | 'gmail' | 'onedrive' | 'dropbox';

// The three drives a document can be saved to, in the order they appear in
// any menu. Google is first because it is the one that has always been there.
export const DRIVE_KINDS = ['google_drive', 'onedrive', 'dropbox'] as const;
export type DriveKind = (typeof DRIVE_KINDS)[number];

export const DRIVE_LABEL: Record<DriveKind, string> = {
  google_drive: 'Google Drive',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
};

export const DRIVE_ICON: Record<DriveKind, LucideIcon> = {
  google_drive: HardDrive,
  onedrive: Cloud,
  dropbox: Package,
};

// POSTs to an export endpoint with the session bearer token and returns the
// parsed JSON body. Throws 'Not signed in' when there is no session.
async function postExport(
  ctx: ExportContext,
  path: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: any }> {
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
  return { ok: resp.ok && !!body.ok, status: resp.status, body };
}

// The one place the seal is handled on the client. A sealed matter answers 409
// with the gate's own sentence; we show it, and only a yes re-issues the
// request with confirm_leave_seal — per copy, never remembered.
async function postThroughSeal(
  ctx: ExportContext,
  path: string,
  payload: Record<string, unknown>,
) {
  const first = await postExport(ctx, path, payload);
  if (first.status !== 409 || first.body?.error !== 'export_needs_confirmation') {
    return { ...first, stopped: null };
  }
  if (!ctx.confirmLeaveSeal) return { ...first, stopped: 'no_confirmer' };
  const proceed = await ctx.confirmLeaveSeal(String(first.body.message ?? ''));
  if (!proceed) return { ...first, stopped: 'declined' };
  const second = await postExport(ctx, path, { ...payload, confirm_leave_seal: true });
  return { ...second, stopped: null };
}

// A sealed export that actually happened says so, in the server's words —
// including whether it is written to the matter's record, which is a fact
// about the deployment, not something this file may assume.
function withSealNote(text: string, body: { seal?: { note?: string } }): string {
  return body?.seal?.note ? `${text} ${body.seal.note}` : text;
}

// OneDrive and Dropbox share one endpoint and one set of error codes, so they
// share one runner. Google keeps its own above: /api/drive-export is older,
// it works, and nothing here is worth changing it for.
async function runCloudExport(ctx: ExportContext, service: 'onedrive' | 'dropbox') {
  const label = DRIVE_LABEL[service];
  ctx.setBanner(null);
  try {
    const { ok, body, stopped } = await postThroughSeal(ctx, '/api/cloud-export', {
      service,
      documentId: ctx.documentId,
    });
    if (stopped === 'declined') return;
    if (stopped === 'no_confirmer') {
      ctx.setBanner({ kind: 'err', text: String(body.message ?? 'This matter is sealed.') });
      return;
    }
    if (!ok) {
      const msg =
        body.error === 'not_configured'
          ? `${label} is not available yet.`
          : body.error === 'cloud_needs_reconnect'
            ? `Reconnect ${label} in Connections — your access expired.`
            : body.error === 'cloud_not_connected'
              ? `Connect ${label} in Connections first.`
              : body.error === 'file_too_large'
                ? `File is too large for ${label} export (75 MB cap).`
                : typeof body.detail === 'string' && body.detail
                  ? `${label}: ${body.detail}`
                  : body.error || `${label} export failed.`;
      console.error('cloud-export failed:', body);
      ctx.setBanner({ kind: 'err', text: msg });
      return;
    }
    ctx.setBanner({
      kind: 'ok',
      text: withSealNote(
        `Saved to your ${label}${body.folderPath ? ` › ${body.folderPath}` : ''}${
          body.name ? ` as “${body.name}”` : ''
        }.`,
        body,
      ),
      // Dropbox is connected with one scope — files.content.write — which
      // cannot mint a link, so there is nothing to offer and none is claimed.
      link: body.link ?? null,
      linkLabel: `Open in ${label}`,
    });
  } catch (e) {
    ctx.setBanner({
      kind: 'err',
      text: e instanceof Error ? e.message : `${label} export failed.`,
    });
  }
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
        const { ok, body, stopped } = await postThroughSeal(ctx, '/api/drive-export', {
          documentId: ctx.documentId,
          folderName: 'Contextspaces',
        });
        if (stopped === 'declined') return;
        if (stopped === 'no_confirmer') {
          ctx.setBanner({ kind: 'err', text: String(body.message ?? 'This matter is sealed.') });
          return;
        }
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
          text: withSealNote(
            `Saved to your Google Drive${body.folderName ? ` › ${body.folderName}` : ''}.`,
            body,
          ),
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
    id: 'onedrive',
    label: 'Save to OneDrive',
    icon: DRIVE_ICON.onedrive,
    needsConnection: 'onedrive',
    run: (ctx) => runCloudExport(ctx, 'onedrive'),
  },
  {
    id: 'dropbox',
    label: 'Save to Dropbox',
    icon: DRIVE_ICON.dropbox,
    needsConnection: 'dropbox',
    run: (ctx) => runCloudExport(ctx, 'dropbox'),
  },
  {
    id: 'gmail',
    label: 'Email (attach to Gmail draft)',
    icon: Mail,
    needsConnection: 'gmail',
    run: async (ctx) => {
      ctx.setBanner(null);
      try {
        const { ok, body, stopped } = await postThroughSeal(ctx, '/api/gmail-send', {
          documentId: ctx.documentId,
          subject: ctx.doc?.title ?? undefined,
        });
        if (stopped === 'declined') return;
        if (stopped === 'no_confirmer') {
          ctx.setBanner({ kind: 'err', text: String(body.message ?? 'This matter is sealed.') });
          return;
        }
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
          text: withSealNote(
            'Draft created in Gmail with the file attached — open Drafts to address and send it.',
            body,
          ),
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
