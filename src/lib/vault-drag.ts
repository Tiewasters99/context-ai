// The drag payload that carries Vault documents from the file list to a
// folder — a matter row in the rail, or a folder chip above the list.
//
// Plain JSON under a private MIME type, so it works across panels without a
// shared DndContext. Since 2026-09-27 a drag carries the whole selection
// (`items`); the single-document shape (`docId` + `fromMatterId`) is still
// written alongside it and still read, so a drop target that knows only the
// old shape keeps working.

export const VAULT_DRAG_TYPE = 'application/x-cs-vault-file';

export interface VaultDragItem {
  docId: string;
  fromMatterId: string;
}

export function writeVaultDrag(dt: DataTransfer, items: VaultDragItem[]): void {
  if (items.length === 0) return;
  dt.setData(VAULT_DRAG_TYPE, JSON.stringify({ ...items[0], items }));
  dt.effectAllowed = 'move';
}

export function readVaultDrag(dt: DataTransfer): VaultDragItem[] {
  const raw = dt.getData(VAULT_DRAG_TYPE);
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    const list: unknown[] = Array.isArray(p?.items) ? p.items : [p];
    return list.filter((i): i is VaultDragItem =>
      !!i && typeof (i as VaultDragItem).docId === 'string' && typeof (i as VaultDragItem).fromMatterId === 'string');
  } catch {
    return [];
  }
}

/** Whether a drag in progress is Vault documents (the data itself is unreadable until drop). */
export function isVaultDrag(dt: DataTransfer): boolean {
  return dt.types.includes(VAULT_DRAG_TYPE);
}
