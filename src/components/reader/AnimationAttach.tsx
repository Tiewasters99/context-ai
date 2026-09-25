import { useCallback, useEffect, useState } from 'react';
import { RotateCw, Loader2, Check } from 'lucide-react';
import CardDialog from '@/components/ui/CardDialog';
import {
  createAnimation, listMatterClips, type AnimationMedia, type DocumentAnimation, type Turn,
} from '@/lib/document-animations';
import type { FractionalRect } from '@/lib/document-annotations';

// The second half of attaching a clip: the reader has drawn a rectangle
// round an illustration, and now says which clip plays there and which way
// the plate is up.
//
// The preview is the real page, cropped to that rectangle and turned, so
// "upright" is something you see rather than guess. Whoever attaches the clip
// settles this once; afterwards a reader only taps.

const TURNS: Turn[] = [0, 90, 180, 270];

export default function AnimationAttach({
  documentId,
  matterId,
  page,
  rect,
  makePreview,
  onSaved,
  onClose,
}: {
  documentId: string;
  matterId: string | null;
  page: number;
  rect: FractionalRect;
  /** The page, cropped to the rectangle and turned — for the preview. */
  makePreview: (page: number, rect: FractionalRect, turn: Turn) => Promise<string | null>;
  onSaved: (animation: DocumentAnimation) => void;
  onClose: () => void;
}) {
  const [clips, setClips] = useState<AnimationMedia[] | null>(null);
  const [chosen, setChosen] = useState<string>('');
  const [turn, setTurn] = useState<Turn>(0);
  const [loops, setLoops] = useState(true);
  const [label, setLabel] = useState('');
  // The preview carries the turn it was drawn at, so a stale one shows as
  // "drawing…" instead of a wrong picture — no resetting from an effect.
  const [preview, setPreview] = useState<{ turn: Turn; url: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A document outside any matter has no clips to offer.
  const offered = matterId ? clips : [];

  useEffect(() => {
    if (!matterId) return;
    let live = true;
    void listMatterClips(matterId).then((c) => { if (live) setClips(c); });
    return () => { live = false; };
  }, [matterId]);

  useEffect(() => {
    let live = true;
    void makePreview(page, rect, turn).then((url) => {
      if (!live) { if (url) URL.revokeObjectURL(url); return; }
      if (url) {
        setPreview((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return { turn, url };
        });
      }
    });
    return () => { live = false; };
  }, [makePreview, page, rect, turn]);

  // The last preview is let go when the dialog closes.
  useEffect(() => () => setPreview((prev) => {
    if (prev) URL.revokeObjectURL(prev.url);
    return null;
  }), []);

  const save = useCallback(async () => {
    if (!chosen || saving) return;
    setSaving(true);
    setError(null);
    const { animation, error: err } = await createAnimation({
      documentId, mediaDocumentId: chosen, page, rect, turn, loops,
      label: label.trim() || null,
    });
    if (animation) { onSaved(animation); return; }
    setError(
      err?.includes('document_animations')
        ? 'The animations table is not in the database yet — apply migration 062 and try again.'
        : err ?? 'That could not be saved.',
    );
    setSaving(false);
  }, [chosen, saving, documentId, page, rect, turn, loops, label, onSaved]);

  const field = 'h-8 w-full rounded-md border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.05)] px-2 text-[12px] text-white focus:outline-none focus:ring-1 focus:ring-[#e8b84a]';

  return (
    <CardDialog
      storageKey="cs.dialog.animationAttach"
      z={80}
      maxWidth={512}
      onClose={onClose}
      // A clip chosen or a name typed is not lost to a stray click outside.
      closeOnBackdrop={!chosen && !label.trim()}
      title={`Add an animation — p. ${page}`}
      label={`Add an animation on page ${page}`}
      subtitle="The clip plays on this part of the page. Turn the picture upright if the plate is printed sideways."
      bodyClassName="p-0"
      footerClassName="flex items-center justify-end gap-2 px-4 py-3"
      footer={
        <>
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-[12px] text-white/60 hover:bg-white/5 hover:text-white">
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!chosen || saving}
            className="inline-flex items-center gap-2 rounded-lg bg-[#f0c850] px-4 py-2 text-[12px] font-bold text-black transition-colors hover:bg-[#e8b84a] disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            Attach the clip
          </button>
        </>
      }
    >
      <div className="flex gap-4 px-4 py-4">
        <div className="flex w-40 shrink-0 flex-col items-center gap-2">
          <div className="flex h-44 w-full items-center justify-center overflow-hidden rounded border border-white/10 bg-white/95">
            {preview && preview.turn === turn
              ? <img src={preview.url} alt={`page ${page}, the chosen area`} className="max-h-full max-w-full" />
              : <Loader2 size={14} className="animate-spin text-black/30" />}
          </div>
          <button
            onClick={() => setTurn(TURNS[(TURNS.indexOf(turn) + 1) % TURNS.length])}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/12 px-2 py-1 text-[11px] text-white/75 hover:bg-white/5 hover:text-white"
            title="Turn until the picture is upright"
          >
            <RotateCw size={12} /> Turn{turn ? ` · ${turn}°` : ''}
          </button>
        </div>

        <div className="flex-1 space-y-3">
          <label className="block">
            <span className="mb-1 block text-[11px] text-white/55">Clip</span>
            {offered === null ? (
              <p className="flex items-center gap-2 text-[12px] text-white/50">
                <Loader2 size={12} className="animate-spin" /> Looking for clips in this matter…
              </p>
            ) : offered.length === 0 ? (
              <p className="text-[12px] text-white/50">
                No video is filed in this matter yet. Upload the clip into the matter first, then come back.
              </p>
            ) : (
              <select value={chosen} onChange={(e) => setChosen(e.target.value)} className={field} aria-label="The clip to play here">
                <option value="">Choose a clip…</option>
                {offered.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] text-white/55">Name (optional)</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. the kneeling fairy"
              className={field}
              aria-label="A name for this animation"
            />
          </label>

          <label className="flex items-center gap-2 text-[12px] text-white/75">
            <input type="checkbox" checked={loops} onChange={(e) => setLoops(e.target.checked)} className="accent-[#e8b84a]" />
            Play over and over
          </label>

          {error && <p className="text-[12px] text-red-400">{error}</p>}
        </div>
      </div>
    </CardDialog>
  );
}
