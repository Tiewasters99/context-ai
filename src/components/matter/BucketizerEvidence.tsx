import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ExternalLink, Loader2, X } from 'lucide-react';
import {
  decideEvidence,
  fetchEvidenceForNode,
  reorderEvidence,
  type NodeEvidenceItem,
} from '@/lib/bucketizer/evidence';
import { showingOf } from '@/lib/paged';

// The evidence under one bucket: the passages that support it, each with the
// words to read out and the citation to read them under.
//
// THE QUOTATION IS THE POINT, so it is set as a quotation — indented, in the
// passage's own line breaks, at a size meant to be read rather than scanned.
// The citation sits under it with whatever caveat that citation carries, and
// the caveat is not a tooltip: an attorney who is about to type "Marlow Dep.
// 88" into a brief has to see, without hovering, that there is no line number
// behind it.
//
// NOTHING UNCONFIRMED IS PRESENTED AS ESTABLISHED. A proposed item is marked
// on its face and the outline lists it separately; only Confirm moves it.

export default function BucketizerEvidence({
  nodeId,
  onChanged,
}: {
  nodeId: string;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<NodeEvidenceItem[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const page = await fetchEvidenceForNode(nodeId);
      setItems(page.rows);
      setNotice(showingOf(page, 'quotations'));
      setError(null);
    } catch (e) {
      setItems([]);
      setError(e instanceof Error ? e.message : 'The evidence could not be loaded.');
    }
  }, [nodeId]);

  useEffect(() => {
    setItems(null);
    setNotice(null);
    setError(null);
    void load();
  }, [load]);

  const decide = useCallback(async (item: NodeEvidenceItem, decision: 'confirmed' | 'rejected') => {
    setBusy(true);
    try {
      await decideEvidence(item.row.id, decision);
      setItems((prev) => prev?.map((x) => (x.row.id === item.row.id
        ? { ...x, row: { ...x.row, status: decision } }
        : x)) ?? null);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The decision could not be saved.');
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  /**
   * Reorder within the bucket. The outline reads `position` verbatim, so this
   * is the attorney saying which quotation leads — and it is written as
   * explicit positions for the whole list rather than a swap, so a half-saved
   * move cannot leave two items claiming the same place.
   */
  const move = useCallback(async (index: number, direction: -1 | 1) => {
    if (!items) return;
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
    setBusy(true);
    try {
      await reorderEvidence(next.map((x) => x.row.id));
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The new order could not be saved.');
      await load();
    } finally {
      setBusy(false);
    }
  }, [items, load, onChanged]);

  if (items === null) {
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-zinc-500">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading the evidence…
      </div>
    );
  }

  const live = items.filter((x) => x.row.status !== 'rejected');
  const rejected = items.length - live.length;

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-lg border border-[#d4a054]/40 bg-[#d4a054]/10 px-3 py-2 text-xs text-[#d4a054]">
          {notice}
        </p>
      )}

      {live.length === 0 && !error && (
        <p className="py-2 text-sm text-zinc-600">
          No quotations recorded for this bucket yet. Run <em>Find evidence</em> once the
          documents here are confirmed.
        </p>
      )}

      {live.map((item, i) => (
        <div
          key={item.row.id}
          className={`rounded-lg border px-3 py-2.5 ${item.row.status === 'confirmed'
            ? 'border-emerald-500/30 bg-emerald-500/[0.04]'
            : 'border-white/10 bg-white/[0.02]'}`}
        >
          {/* The words, as words. */}
          <blockquote className="border-l-2 border-zinc-600 pl-3 text-sm leading-relaxed text-zinc-200 whitespace-pre-wrap">
            {item.row.quote}
          </blockquote>

          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-xs font-medium text-zinc-300">— {item.cite.text}</span>
            {item.cite.caveat && (
              // Not a tooltip. A missing line number has to be visible to
              // someone about to put this cite in a brief.
              <span className="text-[11px] italic text-[#d4a054]">({item.cite.caveat})</span>
            )}
            <a
              href={item.readerUrl}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-0.5 text-[11px] text-zinc-500 hover:text-[#d4a054]"
              title="Open the document at this page"
            >
              open <ExternalLink className="w-3 h-3" />
            </a>
            {item.row.status === 'confirmed'
              ? <span className="text-[11px] text-emerald-400">confirmed</span>
              : <span className="text-[11px] text-[#d4a054]">proposed — not in the outline's body until confirmed</span>}
          </div>

          {item.row.rationale && (
            <p className="mt-1 text-xs text-zinc-500">{item.row.rationale}</p>
          )}
          <p className="mt-0.5 text-[11px] text-zinc-600 truncate" title={item.documentTitle}>
            {item.documentTitle}
          </p>

          <div className="mt-2 flex items-center gap-1">
            <button
              title="Move up — the outline reads this order"
              disabled={busy || i === 0}
              onClick={() => void move(i, -1)}
              className="rounded-md border border-white/10 p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button
              title="Move down"
              disabled={busy || i === live.length - 1}
              onClick={() => void move(i, 1)}
              className="rounded-md border border-white/10 p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
            <div className="ml-auto flex gap-1">
              {item.row.status !== 'confirmed' && (
                <button
                  title="Confirm — this quotation goes into the outline"
                  disabled={busy}
                  onClick={() => void decide(item, 'confirmed')}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/15 disabled:opacity-50"
                >
                  <Check className="w-3.5 h-3.5" /> Confirm
                </button>
              )}
              <button
                title="Reject — it leaves the outline entirely"
                disabled={busy}
                onClick={() => void decide(item, 'rejected')}
                className="inline-flex items-center gap-1 rounded-md border border-red-500/30 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/15 disabled:opacity-50"
              >
                <X className="w-3.5 h-3.5" /> Reject
              </button>
            </div>
          </div>
        </div>
      ))}

      {rejected > 0 && (
        <p className="text-xs text-zinc-600">
          {rejected} rejected quotation{rejected === 1 ? '' : 's'} hidden.
        </p>
      )}
    </div>
  );
}
