// Cut, Copy and Paste for Vault documents (Eden, 10-02: "right click on a
// document and then paste it wherever it belongs"), File Explorer style.
//
// The clipboard lives in this tab (sessionStorage), so a Cut in the Vault's
// file list can be pasted on a matter in the sidebar. Pasting goes through the
// two doors that already hold the SecureSpace rules:
//   Cut  → /api/move-document (one call per document; step-up, never out of a
//          seal, the move recorded on the source matter's Record)
//   Copy → /api/sandbox copy_document (the same gates for a copy; the copy
//          keeps its text and search, no re-ingest)
// Nothing here decides what may cross a seal: the server does, and its
// refusal is said in words.

import { useSyncExternalStore } from 'react';
import { moveVaultDocument } from '@/lib/vault-persist';
import { sandboxApi } from '@/lib/sandbox-api';
import type { VaultDragItem } from '@/lib/vault-drag';

export type ClipMode = 'cut' | 'copy';
export interface VaultClip { mode: ClipMode; items: VaultDragItem[] }

const KEY = 'cs.vault.clipboard';
/** Fired on window after a paste changed some matter's files, so open lists re-read. */
export const VAULT_CHANGED_EVENT = 'cs:vault-changed';

let current: VaultClip | null = read();
const listeners = new Set<() => void>();

function read(): VaultClip | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as VaultClip;
    return (c?.mode === 'cut' || c?.mode === 'copy') && Array.isArray(c.items) && c.items.length ? c : null;
  } catch {
    return null;
  }
}

function write(c: VaultClip | null) {
  current = c;
  try {
    if (c) sessionStorage.setItem(KEY, JSON.stringify(c)); else sessionStorage.removeItem(KEY);
  } catch { /* storage off: the clipboard still works for this page */ }
  listeners.forEach((l) => l());
}

export function setVaultClip(mode: ClipMode, items: VaultDragItem[]) {
  write(items.length ? { mode, items } : null);
}
export function clearVaultClip() { write(null); }
export function getVaultClip(): VaultClip | null { return current; }

/** The clipboard, re-rendering when it changes (in any component of this tab). */
export function useVaultClip(): VaultClip | null {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => current,
    () => null,
  );
}

const noun = (n: number) => `${n.toLocaleString()} document${n === 1 ? '' : 's'}`;

/**
 * Paste the clipboard into a matter or folder. Returns a sentence for the
 * person: what happened, and if anything stayed put, why (the server's own
 * words). A Cut is used up by a paste; a Copy can be pasted again.
 */
export async function pasteVaultClip(targetMatterId: string, targetName: string): Promise<{ ok: boolean; text: string }> {
  const clip = current;
  if (!clip) return { ok: false, text: 'Nothing to paste: Cut or Copy a document first.' };
  const todo = clip.items.filter((i) => clip.mode === 'copy' || i.fromMatterId !== targetMatterId);
  if (todo.length === 0) return { ok: true, text: `Already in ${targetName}.` };

  let done = 0;
  let already = 0;
  const failures: string[] = [];
  if (clip.mode === 'cut') {
    // Four at a time, as a drag does; a seal refusal stops the rest (it
    // would repeat for every document).
    const queue = [...todo];
    let stopped = false;
    const worker = async () => {
      for (let it = queue.shift(); it && !stopped; it = queue.shift()) {
        try { await moveVaultDocument(it.docId, targetMatterId); done++; }
        catch (e) {
          const m = e instanceof Error ? e.message : 'unknown error';
          failures.push(m);
          if (/sealed|step|second factor|confirm it/i.test(m)) stopped = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
    if (done) clearVaultClip();
  } else {
    // One call: copy_document takes the list and checks every document first.
    try {
      // copy_document does not duplicate a file the folder already holds (same
      // filename and size): it answers `already_copied`, or a `note` when the
      // document is already in that very folder.
      const r = await sandboxApi<{ copies?: { already_copied?: boolean; note?: string }[] }>('copy_document', {
        document_ids: todo.map((i) => i.docId),
        to_matter: targetMatterId,
      });
      const copies = Array.isArray(r.copies) ? r.copies : [];
      already = copies.filter((c) => c.already_copied || c.note).length;
      done = copies.length - already;
    } catch (e) {
      failures.push(e instanceof Error ? e.message : 'unknown error');
    }
  }

  if (done) window.dispatchEvent(new CustomEvent(VAULT_CHANGED_EVENT, { detail: { matterIds: [targetMatterId, ...todo.map((i) => i.fromMatterId)] } }));
  const verb = clip.mode === 'cut' ? 'Moved' : 'Copied';
  const there = already ? ` ${noun(already)} ${already === 1 ? 'was' : 'were'} already there.` : '';
  if (!failures.length) return { ok: true, text: done ? `${verb} ${noun(done)} to ${targetName}.${there}` : `Nothing new to copy:${there}` };
  const left = todo.length - done;
  return {
    ok: false,
    text: `${done ? `${verb} ${noun(done)} to ${targetName}; ` : ''}${noun(left)} ${clip.mode === 'cut' ? 'stayed where they were' : 'not copied'}. (${failures[0]})`,
  };
}
