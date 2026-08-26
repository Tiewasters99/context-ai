import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lock, LockOpen, Plus, Upload } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import type { Serverspace, ServerspaceMatter } from '@/hooks/useServerspaces';
import { persistVaultFile, moveVaultDocument, type MatterRef } from '@/lib/vault-persist';

// The SecureSpaces shelf at the bottom of the rail (Beta). One product, one
// seal: a SecureSpace is not a second vault, it is a matter whose ai_tier is
// B/C — so this section is a VIEW over the same serverspaces data the tree
// above renders, and every action here is a tier change or an upload into a
// matter that happens to be sealed. Three ways in:
//
//   1. Drag a matter out of the Serverspaces tree onto this section — the
//      Sidebar's DndContext delivers it and opens the seal confirmation.
//   2. Drop files from the desktop onto a SecureSpace row — they upload into
//      that sealed matter through the ordinary pipeline, which is already
//      seal-aware end to end (the server enforces the tier, not this UI).
//   3. The + button creates a matter born sealed.
//
// A Vault document row dragged here also moves (same payload the Vault's own
// tree accepts) — mostly moot while the Vault overlay covers the rail, but
// supporting the payload costs one branch and future surfaces get it free.

const TIER_B_COLOR = '#5aa88f';
const SECURESPACES_DROP_ID = 'securespaces-drop';
const VAULT_FILE_MIME = 'application/x-cs-vault-file';

export interface SecureSpaceRow {
  matter: ServerspaceMatter;
  serverspaceId: string;
  serverspaceName: string;
  descendantCount: number;
}

/** Sealed ROOTS (own tier B/C) across every serverspace, with counts. */
function collectSealedRows(serverspaces: Serverspace[]): SecureSpaceRow[] {
  const rows: SecureSpaceRow[] = [];
  for (const space of serverspaces) {
    const byParent = new Map<string | null, ServerspaceMatter[]>();
    for (const m of space.matterspaces) {
      const list = byParent.get(m.parent_matterspace_id) ?? [];
      list.push(m);
      byParent.set(m.parent_matterspace_id, list);
    }
    const countDescendants = (id: string): number => {
      const kids = byParent.get(id) ?? [];
      return kids.reduce((n, k) => n + 1 + countDescendants(k.id), 0);
    };
    for (const m of space.matterspaces) {
      if (m.ai_tier === 'A') continue;
      rows.push({
        matter: m,
        serverspaceId: space.id,
        serverspaceName: space.name,
        descendantCount: countDescendants(m.id),
      });
    }
  }
  return rows.sort((a, b) => a.matter.name.localeCompare(b.matter.name));
}

interface SectionProps {
  serverspaces: Serverspace[];
  collapsed: boolean;
  matterDragActive: boolean;
  isActive: (path: string) => boolean;
  onNewSecureSpace: (serverspaceId: string, serverspaceName: string) => void;
  onUnseal: (row: SecureSpaceRow) => void;
}

export default function SecureSpacesSection({
  serverspaces,
  collapsed,
  matterDragActive,
  isActive,
  onNewSecureSpace,
  onUnseal,
}: SectionProps) {
  const rows = useMemo(() => collectSealedRows(serverspaces), [serverspaces]);
  const [spacePicker, setSpacePicker] = useState(false);

  const { setNodeRef, isOver } = useDroppable({
    id: SECURESPACES_DROP_ID,
    data: { kind: 'securespaces' as const },
  });

  const handleNew = () => {
    if (serverspaces.length === 0) return;
    if (serverspaces.length === 1) {
      onNewSecureSpace(serverspaces[0].id, serverspaces[0].name);
    } else {
      setSpacePicker((v) => !v);
    }
  };

  return (
    <div ref={setNodeRef} className="mt-6">
      {/* Header — mirrors the Serverspaces header idiom, plus the Beta chip. */}
      <div className="flex items-center justify-between mb-1.5 px-3">
        {!collapsed && (
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: TIER_B_COLOR }}>
            <Lock size={11} strokeWidth={2} />
            SecureSpaces
            <span
              className="px-1 py-px rounded text-[9px] font-semibold tracking-wide"
              style={{ backgroundColor: 'rgba(90,168,143,0.14)', color: TIER_B_COLOR }}
            >
              BETA
            </span>
          </span>
        )}
        <button
          onClick={handleNew}
          className="p-0.5 rounded hover:bg-[rgba(255,255,255,0.04)] text-white/70 transition-colors"
          aria-label="Create new SecureSpace"
          title="New SecureSpace (a matter born sealed)"
        >
          <Plus size={14} strokeWidth={1.75} />
        </button>
      </div>

      {/* Serverspace picker for the + button when several spaces exist. */}
      {spacePicker && !collapsed && (
        <div className="mx-2 mb-1.5 rounded-md border border-[rgba(255,255,255,0.1)] bg-[#14141c] py-1">
          <p className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-white/40">In which serverspace?</p>
          {serverspaces.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setSpacePicker(false);
                onNewSecureSpace(s.id, s.name);
              }}
              className="w-full text-left px-2.5 py-1.5 text-[12px] text-white/80 hover:bg-[rgba(255,255,255,0.05)] transition-colors"
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* Drop surface. During a matter drag this is the visible invitation. */}
      <div
        className={`mx-1 rounded-lg transition-colors ${
          matterDragActive
            ? isOver
              ? 'ring-1'
              : 'ring-1 ring-dashed'
            : ''
        }`}
        style={
          matterDragActive
            ? {
                borderColor: 'rgba(90,168,143,0.45)',
                backgroundColor: isOver ? 'rgba(90,168,143,0.14)' : 'rgba(90,168,143,0.05)',
                boxShadow: `0 0 0 1px rgba(90,168,143,${isOver ? '0.7' : '0.35'})`,
              }
            : undefined
        }
      >
        {rows.length === 0 && !collapsed && (
          <p className="px-3 py-2 text-[11px] leading-relaxed text-white/40">
            {matterDragActive
              ? 'Drop to seal this matter.'
              : 'No sealed matters yet. Drag a matter here to seal it — sealed matters never reach an outside AI provider.'}
          </p>
        )}

        <div className="space-y-px">
          {rows.map((row) => (
            <SecureSpaceRowItem
              key={row.matter.id}
              row={row}
              collapsed={collapsed}
              isActive={isActive}
              onUnseal={onUnseal}
            />
          ))}
        </div>

        {matterDragActive && rows.length > 0 && !collapsed && (
          <p className="px-3 py-1.5 text-[10px] text-white/45">Drop anywhere in this section to seal.</p>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// One sealed matter row: link to the matter, tier chip, HTML5 drop target for
// desktop files (upload into this matter) and Vault document payloads (move
// into this matter), hover actions for upload + unseal.
// -----------------------------------------------------------------------------

function SecureSpaceRowItem({
  row,
  collapsed,
  isActive,
  onUnseal,
}: {
  row: SecureSpaceRow;
  collapsed: boolean;
  isActive: (path: string) => boolean;
  onUnseal: (row: SecureSpaceRow) => void;
}) {
  const navigate = useNavigate();
  const [fileOver, setFileOver] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const path = `/app/matterspace/${row.matter.id}`;
  const tier = row.matter.ai_tier;

  const matterRef: MatterRef = {
    id: row.matter.id,
    name: row.matter.name,
    short_code: row.matter.short_code,
    cover_url: null,
    serverspace_id: row.serverspaceId,
    serverspace_name: row.serverspaceName,
    parent_matterspace_id: row.matter.parent_matterspace_id,
  };

  const wantsDrop = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(VAULT_FILE_MIME);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setFileOver(false);
    setUploadError(null);

    // A Vault document dragged over: move it into this sealed matter.
    const vaultPayload = e.dataTransfer.getData(VAULT_FILE_MIME);
    if (vaultPayload) {
      try {
        const { docId } = JSON.parse(vaultPayload) as { docId: string };
        await moveVaultDocument(docId, row.matter.id);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // Desktop files: upload each into this matter through the ordinary
    // pipeline. The server enforces the seal; nothing here needs to.
    const files = Array.from(e.dataTransfer.files ?? []);
    for (const file of files) {
      setUploading(file.name);
      try {
        await persistVaultFile(matterRef, file);
      } catch (err) {
        setUploadError(err instanceof Error ? `${file.name}: ${err.message}` : String(err));
        break;
      }
    }
    setUploading(null);
  };

  return (
    <div
      onDragOver={(e) => {
        if (!wantsDrop(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes(VAULT_FILE_MIME) ? 'move' : 'copy';
        setFileOver(true);
      }}
      onDragLeave={() => setFileOver(false)}
      onDrop={handleDrop}
      className={`group flex items-center gap-1 rounded-md transition-colors ${
        fileOver
          ? 'ring-1'
          : isActive(path)
            ? 'bg-[#16161d] text-white'
            : 'text-white hover:bg-[rgba(255,255,255,0.04)]'
      }`}
      style={fileOver ? { boxShadow: '0 0 0 1px rgba(90,168,143,0.7)', backgroundColor: 'rgba(90,168,143,0.12)' } : undefined}
    >
      <Link
        to={path}
        className={`flex-1 flex items-center gap-2 px-3 py-1.5 text-[12px] min-w-0 ${isActive(path) ? 'font-medium' : ''}`}
        title={`${row.matter.name} — sealed (${row.serverspaceName})`}
      >
        <Lock size={12} className="shrink-0" style={{ color: TIER_B_COLOR }} strokeWidth={2} />
        {!collapsed && (
          <>
            <span className="flex-1 truncate">
              {uploading ? `Uploading ${uploading}…` : row.matter.name}
            </span>
            <span
              className="px-1 py-px rounded text-[9px] font-semibold shrink-0"
              style={{ backgroundColor: 'rgba(90,168,143,0.14)', color: TIER_B_COLOR }}
              title={tier === 'C' ? 'Tier C — silo: local only' : 'Tier B — sealed'}
            >
              {tier === 'C' ? 'SILO' : 'SEALED'}
            </span>
          </>
        )}
      </Link>
      {!collapsed && (
        <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mr-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/app/vault?matter=${encodeURIComponent(row.matter.short_code ?? row.matter.id)}`);
            }}
            className="p-1 rounded text-white/40 hover:text-[#e8b84a] hover:bg-[rgba(255,255,255,0.04)] transition-colors"
            aria-label="Upload into this SecureSpace"
            title="Upload into this SecureSpace"
          >
            <Upload size={12} strokeWidth={2} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onUnseal(row);
            }}
            className="p-1 rounded text-white/40 hover:text-amber-300 hover:bg-[rgba(255,255,255,0.04)] transition-colors"
            aria-label="Unseal this matter"
            title="Unseal (return to the open tier)"
          >
            <LockOpen size={12} strokeWidth={2} />
          </button>
        </div>
      )}
      {uploadError && !collapsed && (
        <span className="px-2 text-[10px] text-red-300 truncate max-w-[8rem]" title={uploadError}>
          {uploadError}
        </span>
      )}
    </div>
  );
}
