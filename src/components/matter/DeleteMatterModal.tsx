import { useState } from 'react';
import { X, Trash2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useServerspacesRefresh } from '@/hooks/useServerspaces';

// Confirmation + cascade for matter deletion. The caller computes the list
// of descendant ids (including the target itself) so we can clean up
// content_items by space_id before issuing the cascading matter delete.
export interface DeleteMatterTarget {
  matterId: string;
  matterName: string;
  descendantIds: string[];
}

interface Props {
  target: DeleteMatterTarget;
  onClose: () => void;
  onDeleted?: () => void;
}

export default function DeleteMatterModal({ target, onClose, onDeleted }: Props) {
  const refreshServerspaces = useServerspacesRefresh();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const { error: ciErr } = await supabase
        .from('content_items')
        .delete()
        .eq('space_type', 'matterspace')
        .in('space_id', target.descendantIds);
      if (ciErr) throw new Error(`content cleanup: ${ciErr.message}`);

      const { error: mErr } = await supabase
        .from('matterspaces')
        .delete()
        .eq('id', target.matterId);
      if (mErr) throw new Error(mErr.message);

      await refreshServerspaces();
      onDeleted?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  const subCount = target.descendantIds.length - 1;

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/40" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[60] w-full max-w-sm rounded-xl border border-[rgba(255,255,255,0.12)] p-6 bg-[#12121a]">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[15px] font-semibold text-white flex items-center gap-2">
            <Trash2 size={15} className="text-red-300" />
            Delete matter
          </h3>
          <button
            onClick={onClose}
            disabled={deleting}
            className="p-1 rounded hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white transition-colors disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>
        <p className="text-[13px] text-white/80 mb-2">
          Delete <span className="text-[#e8b84a] font-semibold">{target.matterName}</span>?
        </p>
        {subCount > 0 && (
          <p className="text-[12px] text-amber-300 mb-2">
            This also deletes {subCount} sub-matter{subCount === 1 ? '' : 's'} underneath.
          </p>
        )}
        <p className="text-[11px] text-white/50 leading-relaxed mb-5">
          All documents, passages, pages, lists, and tables in this matter (and its sub-matters) are permanently deleted. This cannot be undone.
        </p>
        {error && <p className="text-[12px] text-red-300 mb-3">{error}</p>}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={deleting}
            className="flex-1 py-2 rounded-lg border border-[rgba(255,255,255,0.1)] text-[13px] text-white/80 hover:bg-[rgba(255,255,255,0.04)] transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex-1 py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 border border-red-400/40 text-red-200 text-[13px] font-medium transition-colors disabled:opacity-40"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </>
  );
}

// Walks the loaded serverspace tree to gather a matter and every descendant.
export function collectDescendantIds(
  serverspaces: { matterspaces: { id: string; parent_matterspace_id: string | null }[] }[],
  rootMatterId: string,
): string[] {
  for (const s of serverspaces) {
    const byId = new Map(s.matterspaces.map((m) => [m.id, m]));
    if (!byId.has(rootMatterId)) continue;
    const out: string[] = [];
    const walk = (id: string) => {
      out.push(id);
      for (const m of s.matterspaces) {
        if (m.parent_matterspace_id === id) walk(m.id);
      }
    };
    walk(rootMatterId);
    return out;
  }
  return [rootMatterId];
}
