// Export / Share dropdown for the document reader. Replaces the inline
// Download + "Save to Google Drive" toolbar buttons with a single menu that
// lists every connector from EXPORT_CONNECTORS. Connectors whose required
// connection isn't present are shown as a "Connect X to enable →" affordance
// that routes to the Connections page instead of running.

import { useEffect, useRef, useState } from 'react';
import { Share2, ChevronRight } from 'lucide-react';
import type { Connection } from '@/hooks/useConnections';
import {
  EXPORT_CONNECTORS,
  type ExportContext,
} from '@/lib/export-connectors';

type Props = {
  connections: Connection[];
  ctx: ExportContext;
  disabled?: boolean;
};

const KIND_LABEL: Record<string, string> = {
  google_drive: 'Google Drive',
  gmail: 'Gmail',
};

export default function ExportMenu({ connections, ctx, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside-click and Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
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

  const isConnected = (kind?: 'google_drive' | 'gmail') =>
    !kind ||
    connections.some((c) => c.kind === kind && c.status === 'connected');

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="h-8 inline-flex items-center gap-1.5 px-2 rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
        title="Export or share this document"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Share2 size={15} />
        <span className="text-xs">Export</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-64 z-[70] py-1 rounded-lg bg-[#1a1a22] border border-white/15 shadow-2xl"
        >
          {EXPORT_CONNECTORS.map((conn) => {
            const Icon = conn.icon;
            const connected = isConnected(conn.needsConnection);
            const busy = running === conn.id;

            if (!connected && conn.needsConnection) {
              const label = KIND_LABEL[conn.needsConnection] ?? conn.needsConnection;
              return (
                <button
                  key={conn.id}
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    ctx.navigateToConnections();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs text-white/45 hover:text-white hover:bg-white/5"
                >
                  <Icon size={15} className="shrink-0 opacity-60" />
                  <span className="flex-1">Connect {label} to enable</span>
                  <ChevronRight size={13} className="shrink-0 opacity-70" />
                </button>
              );
            }

            return (
              <button
                key={conn.id}
                role="menuitem"
                disabled={busy || running !== null}
                onClick={async () => {
                  setRunning(conn.id);
                  try {
                    await conn.run(ctx);
                  } finally {
                    setRunning(null);
                    setOpen(false);
                  }
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs text-white/80 hover:text-white hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Icon size={15} className="shrink-0" />
                <span className="flex-1">{busy ? 'Working…' : conn.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
