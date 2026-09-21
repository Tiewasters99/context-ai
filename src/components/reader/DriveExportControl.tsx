// The reader's one control for "save this to a drive".
//
// Three states, and the middle one is the reason this component is small:
//
//   exactly one drive connected → a plain icon button that runs that export.
//     With a Google Drive connection and nothing else, that is byte for byte
//     the button the toolbar has always had, in the same place, with the same
//     tooltip. Nobody's Thursday changes.
//   two or three connected     → the same button opens a short menu naming
//     the drives that are connected. Nothing else is in it.
//   none connected             → the button is STILL THERE, and opens a menu
//     with one quiet line: "Connect a drive to export…", which goes to
//     Connections. Until now the control simply vanished when no drive was
//     connected, which Eden found confusing — an absent button teaches
//     nobody that the feature exists.

import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { DRIVE_ICON, DRIVE_LABEL, type DriveKind } from '@/lib/export-connectors';

type Props = {
  /** Drives with a live connection, in DRIVE_KINDS order. */
  connected: DriveKind[];
  busy: boolean;
  disabled?: boolean;
  onExport: (kind: DriveKind) => void;
  onConnect: () => void;
};

export default function DriveExportControl({
  connected,
  busy,
  disabled,
  onExport,
  onConnect,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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

  // One drive: no menu, no chevron, no new gesture — the button IS the export.
  if (connected.length === 1) {
    const only = connected[0];
    const Icon = DRIVE_ICON[only];
    return (
      <button
        onClick={() => onExport(only)}
        disabled={disabled || busy}
        className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
        title={busy ? `Saving to ${DRIVE_LABEL[only]}…` : `Save to ${DRIVE_LABEL[only]}`}
      >
        <Icon size={15} />
      </button>
    );
  }

  const MenuIcon = DRIVE_ICON[connected[0] ?? 'google_drive'];

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || busy}
        className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
        title={connected.length ? 'Save to a drive' : 'Save to a drive — none connected yet'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MenuIcon size={15} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-60 z-[70] py-1 rounded-lg bg-[#1a1a22] border border-white/15 shadow-2xl"
        >
          {connected.length === 0 ? (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onConnect();
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs text-white/45 hover:text-white hover:bg-white/5"
            >
              <span className="flex-1">Connect a drive to export…</span>
              <ChevronRight size={13} className="shrink-0 opacity-70" />
            </button>
          ) : (
            connected.map((kind) => {
              const Icon = DRIVE_ICON[kind];
              return (
                <button
                  key={kind}
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onExport(kind);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs text-white/80 hover:text-white hover:bg-white/5"
                >
                  <Icon size={15} className="shrink-0" />
                  <span className="flex-1">Save to {DRIVE_LABEL[kind]}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
