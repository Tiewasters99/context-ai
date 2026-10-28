// The page ribbon's "Word" menu.
//
// Before this, a page's only way out was an unlabeled download-arrow icon
// whose tooltip said "Download as Word (.docx)" — found by nobody. This is a
// labeled button that opens a short menu:
//
//   Download as Word (.docx)        always
//   File a Word copy in the matter  pages that live in a matter
//   Save to Google Drive / OneDrive / Dropbox, Email (Gmail draft)
//                                   each connected service, via the same
//                                   connectors the Reader's documents use
//   Connect a drive to export…      when none is connected
//
// Every drive item files the page in the matter's Vault first and hands the
// filed document to the connector (src/lib/export-connectors.ts). That is what
// puts the seal gate, the Record and the Reader behind a page's Word copy for
// free, and why a page outside any matter can only download.
//
// Connectors that need a connection the user does not have are not listed as
// "Connect X to enable" rows, the way the Reader's ExportMenu does: OneDrive
// and Dropbox are dormant until this deployment registers them, and two dead
// rows would point at a Connections page that does not show them.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Download, FileText, HardDrive } from 'lucide-react';
import { useConnections } from '@/hooks/useConnections';
import { supabase } from '@/lib/supabase';
import { pageToDocxBlob, downloadBlob, safeFilename } from '@/lib/export-page';
import {
  EXPORT_CONNECTORS,
  type ExportBanner,
  type ExportContext,
} from '@/lib/export-connectors';
import { filePageAsDocx, pageSnapshotKey, type FiledPage, type PageSnapshot } from '@/lib/page-export';
import SealedExportDialog from '@/components/reader/SealedExportDialog';

// The Reader's banner shape, plus one flag: a link into the app (the filed
// copy in the Reader) is navigated, an external one (Drive, Gmail) opens in
// a new tab.
export type PageExportBanner =
  | { kind: 'ok'; text: string; link: string | null; linkLabel?: string; internal?: boolean }
  | { kind: 'err'; text: string };

interface Props {
  // The matter the page lives in, or null for a page outside any matter.
  matterId: string | null;
  // The page as it is now. Called at the moment of export, after the host
  // has flushed its autosave, so the copy is what the person sees.
  getPage: () => Promise<PageSnapshot>;
  setBanner: (b: PageExportBanner | null) => void;
  disabled?: boolean;
}

export default function PageExportMenu({ matterId, getPage, setBanner, disabled }: Props) {
  const navigate = useNavigate();
  const { data: connections = [] } = useConnections();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // One filing per version of the page: the drive items reuse it while the
  // title and body are unchanged, and file again once they are not.
  const filedRef = useRef<{ key: string; filed: FiledPage } | null>(null);
  // The seal gate's question, asked through the Reader's own dialog. The
  // promise resolves with the answer; the connector waits on it.
  const [sealPrompt, setSealPrompt] = useState<{
    message: string;
    confirmLabel: string;
    resolve: (yes: boolean) => void;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const connected = EXPORT_CONNECTORS.filter(
    (c) =>
      c.needsConnection &&
      connections.some((k) => k.kind === c.needsConnection && k.status === 'connected'),
  );

  const run = async (id: string, work: () => Promise<void>) => {
    if (running) return;
    setRunning(id);
    setOpen(false);
    try {
      await work();
    } catch (e) {
      console.error(`page export "${id}" failed`, e);
      setBanner({ kind: 'err', text: e instanceof Error ? e.message : 'Export failed.' });
    } finally {
      setRunning(null);
    }
  };

  const download = () =>
    run('download', async () => {
      const page = await getPage();
      const title = page.title || 'Untitled Page';
      const blob = await pageToDocxBlob(page.body, title);
      downloadBlob(blob, safeFilename(title, '.docx'));
    });

  // Files the page unless this exact version already is.
  const fileInMatter = async (): Promise<{ filed: FiledPage; fresh: boolean }> => {
    if (!matterId) throw new Error('This page is not in a matter, so it cannot be filed.');
    const page = await getPage();
    const key = pageSnapshotKey(page);
    if (filedRef.current && filedRef.current.key === key) {
      return { filed: filedRef.current.filed, fresh: false };
    }
    const filed = await filePageAsDocx(matterId, page);
    filedRef.current = { key, filed };
    return { filed, fresh: true };
  };

  const fileCopy = () =>
    run('file', async () => {
      setBanner(null);
      const { filed, fresh } = await fileInMatter();
      setBanner({
        kind: 'ok',
        text: fresh
          ? `Filed in ${filed.matterName} as “${filed.filename}”.`
          : `This version is already filed in ${filed.matterName} as “${filed.filename}”.`,
        link: `/app/document/${filed.documentId}`,
        linkLabel: 'Open',
        internal: true,
      });
    });

  const sendTo = (connectorId: string) =>
    run(connectorId, async () => {
      const conn = EXPORT_CONNECTORS.find((c) => c.id === connectorId);
      if (!conn) return;
      setBanner(null);
      const { filed } = await fileInMatter();
      const ctx: ExportContext = {
        documentId: filed.documentId,
        doc: { title: filed.filename.replace(/\.docx$/i, ''), storage_path: filed.storagePath },
        getToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
        download,
        // The connector's own sentence, with where the Word copy now lives.
        setBanner: (b: ExportBanner | null) =>
          setBanner(
            b && b.kind === 'ok'
              ? { ...b, text: `${b.text} The Word copy is filed in ${filed.matterName}.` }
              : b,
          ),
        navigateToConnections: () => navigate('/app/connections'),
        confirmLeaveSeal: (message) =>
          new Promise<boolean>((resolve) => {
            setSealPrompt({ message, confirmLabel: conn.label, resolve });
          }),
      };
      await conn.run(ctx);
    });

  const itemClass =
    'w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs text-white/80 hover:text-white hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || running !== null}
        className="h-7 inline-flex items-center gap-1 px-2 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        title="Word: download this page, file a Word copy in the matter, or send it to a drive"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <FileText size={14} strokeWidth={2} />
        <span className="text-xs">{running ? 'Working…' : 'Word'}</span>
        <ChevronDown size={12} strokeWidth={2} className="opacity-70" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-64 z-[70] py-1 rounded-lg bg-[#1a1a22] border border-white/15 shadow-2xl"
        >
          <button role="menuitem" onClick={download} className={itemClass}>
            <Download size={15} className="shrink-0" />
            <span className="flex-1">Download as Word (.docx)</span>
          </button>

          {matterId ? (
            <>
              <button role="menuitem" onClick={fileCopy} className={itemClass}>
                <FileText size={15} className="shrink-0" />
                <span className="flex-1">File a Word copy in the matter</span>
              </button>
              <div className="my-1 border-t border-white/10" />
              {connected.length ? (
                connected.map((conn) => {
                  const Icon = conn.icon;
                  return (
                    <button
                      key={conn.id}
                      role="menuitem"
                      onClick={() => sendTo(conn.id)}
                      className={itemClass}
                    >
                      <Icon size={15} className="shrink-0" />
                      <span className="flex-1">{conn.label}</span>
                    </button>
                  );
                })
              ) : (
                // Never nothing: a page with no drive connected is told the
                // feature exists and where to switch it on.
                <button
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    navigate('/app/connections');
                  }}
                  className={itemClass}
                >
                  <HardDrive size={15} className="shrink-0" />
                  <span className="flex-1">Connect a drive to export…</span>
                </button>
              )}
            </>
          ) : (
            <p className="px-3 py-2 text-[11px] leading-snug text-white/40">
              File this page in a matter to keep a Word copy there or send it to a drive.
            </p>
          )}
        </div>
      )}

      {sealPrompt && (
        <SealedExportDialog
          message={sealPrompt.message}
          confirmLabel={sealPrompt.confirmLabel}
          busy={false}
          onCancel={() => {
            sealPrompt.resolve(false);
            setSealPrompt(null);
          }}
          onConfirm={() => {
            sealPrompt.resolve(true);
            setSealPrompt(null);
          }}
        />
      )}
    </div>
  );
}
