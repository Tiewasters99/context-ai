import { useEffect, useMemo, useState } from 'react';
import { Search, FileText, Check } from 'lucide-react';
import CardDialog from '@/components/ui/CardDialog';
import { supabase } from '@/lib/supabase';
import { fetchPaged, showingOf } from '@/lib/paged';

type DocRow = { id: string; title: string };

/** Rows this picker will hold. Past it, it says how many it is showing. */
const PICKER_CEILING = 5000;

type Props = {
  matterId: string;
  initiallySelected?: string[];
  onCancel: () => void;
  onConfirm: (selected: { id: string; title: string }[]) => void;
};

// Lightweight modal picker for selecting documents in a matter (including
// sub-matters). Used by the thread composer to attach exhibits to a
// comment, and reusable wherever a "pick documents from this matter" UX
// makes sense.
export default function DocumentPicker({
  matterId,
  initiallySelected = [],
  onCancel,
  onConfirm,
}: Props) {
  const [files, setFiles] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initiallySelected),
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      // Paged: an unbounded select stops at PostgREST's 1,000 rows, so a
      // matter past that silently offered only part of itself to attach.
      // `.order('id')` is the unique tiebreaker — titles tie constantly
      // (every "Exhibit A", every identical PACER filename), and unbroken
      // ties let rows swap between `.range()` pages.
      try {
        const { rows, total, truncated } = await fetchPaged<DocRow>(
          (from, to) => supabase
            .from('documents')
            .select('id, title', from === 0 ? { count: 'exact' } : undefined)
            .eq('matterspace_id', matterId)
            .order('title', { ascending: true })
            .order('id')
            .range(from, to),
          { ceiling: PICKER_CEILING, label: 'matter documents' },
        );
        if (cancelled) return;
        setFiles(rows);
        setNotice(showingOf({ rows, total, truncated }, 'documents'));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'could not load documents');
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [matterId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.title.toLowerCase().includes(q));
  }, [files, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleConfirm() {
    const picked = files
      .filter((f) => selected.has(f.id))
      .map((f) => ({ id: f.id, title: f.title }));
    onConfirm(picked);
  }

  // A search typed or a selection changed is not thrown away by a stray
  // click outside; an untouched picker still closes on the backdrop.
  const dirty = search.trim() !== ''
    || selected.size !== initiallySelected.length
    || initiallySelected.some((id) => !selected.has(id));

  return (
    <CardDialog
      storageKey="cs.dialog.documentPicker"
      z={50}
      maxWidth={480}
      onClose={onCancel}
      closeOnBackdrop={!dirty}
      title="Attach documents"
      bodyClassName="p-0 flex flex-col"
      footerClassName="flex items-center justify-between px-3 h-12"
      footer={
        <>
          <span className="text-[11px] text-white/45">
            {selected.size} selected
          </span>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="h-8 px-3 rounded-md text-[12px] text-white/65 hover:text-white hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={selected.size === 0}
              className="h-8 px-3 rounded-md bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[#1a1408] text-[12px] font-semibold disabled:opacity-40 transition"
            >
              Attach {selected.size > 0 ? selected.size : ''}
            </button>
          </div>
        </>
      }
    >
      <div className="px-3 py-2 border-b border-[rgba(255,255,255,0.06)]">
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/35"
          />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search documents…"
            className="w-full h-8 pl-7 pr-2 rounded-md bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] text-[12px] text-[var(--color-text-bright)] placeholder:text-white/30 focus:outline-none focus:border-[var(--color-primary)]"
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <p className="text-[12px] text-white/40 py-8 text-center">Loading…</p>
        )}
        {error && (
          <p className="text-[12px] text-red-300 py-8 text-center">{error}</p>
        )}
        {!loading && !error && filtered.length === 0 && (
          <p className="text-[12px] text-white/40 py-8 text-center">
            No documents {search ? 'matched' : 'in this matter'}.
          </p>
        )}
        {!loading && notice && (
          <p className="px-3 py-2 text-[11px] text-[var(--color-primary)]">{notice}</p>
        )}
        {!loading && filtered.length > 0 && (
          <ul className="py-1">
            {filtered.map((f) => {
              const isPicked = selected.has(f.id);
              return (
                <li key={f.id}>
                  <button
                    onClick={() => toggle(f.id)}
                    className={`flex items-center gap-3 w-full px-3 py-2 text-left transition ${
                      isPicked ? 'bg-[var(--color-primary-light)]' : 'hover:bg-white/4'
                    }`}
                  >
                    <FileText
                      size={14}
                      className="text-[var(--color-primary)] shrink-0"
                      strokeWidth={1.75}
                    />
                    <span className="text-[12.5px] text-[var(--color-text-bright)] truncate flex-1">
                      {f.title}
                    </span>
                    {isPicked && (
                      <Check
                        size={13}
                        className="text-[var(--color-primary)] shrink-0"
                        strokeWidth={2.5}
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </CardDialog>
  );
}
