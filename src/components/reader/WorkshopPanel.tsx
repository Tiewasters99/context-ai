import { useEffect, useRef, useState } from 'react';
import {
  Scissors, Quote, RotateCw, Download, Upload, Trash2, Film, Image as ImageIcon, Loader2, Play, X, Check, Scan,
} from 'lucide-react';
import type { Turn } from '@/lib/document-animations';
import type { FractionalRect } from '@/lib/document-annotations';
import { isImageMedia, type WorkshopItem } from '@/lib/document-workshop';
import { clipUrl } from '@/lib/document-animations';

// The Workshop beside a book (migration 106): a bench in the Reader's
// sidebar where a plate is snipped off the page, taken away to be made into
// something (a clip in Flow, a still in Midjourney), brought back, and laid
// beside the original so the two can be judged together. The bench is the
// decision; laying the result on the page (062's living illustrations) is
// the outcome.
//
// Everything here is a recipe. A snip is re-rendered from the PDF each time
// it is shown (makePreview) or downloaded (onDownload, at a chosen scale), so
// "rotate" is one more quarter turn on the row and "crop" is drawing the
// rectangle again. No pixels are stored for a snip; the files that come back
// are ordinary documents in the matter, stored without a transcript.

export type WorkshopPanelProps = {
  page: number;
  items: WorkshopItem[];
  /** True while the reader is waiting for a rectangle to be drawn. */
  snipping: boolean;
  /** The reader's current selection, if any: its words, and the box round
   *  them on the page (a PDF's selection has one; a passage pasted in does not). */
  selection: { text: string; page: number; rect: FractionalRect | null } | null;
  canWrite: boolean;
  onSnip: () => void;
  onCancelSnip: () => void;
  /** Keep a passage; `at` is where its words sit, when known. */
  onSnippet: (text: string, at: { page: number; rect: FractionalRect | null } | null) => Promise<void>;
  makePreview: (page: number, rect: FractionalRect, turn: Turn) => Promise<string | null>;
  onDownload: (item: WorkshopItem, scale: 1 | 2 | 3) => Promise<void>;
  onTurn: (item: WorkshopItem) => Promise<void>;
  /** A snippet's words, corrected or completed by hand. */
  onRetext: (item: WorkshopItem, text: string) => Promise<void>;
  /** Draw the item's rectangle (again): a snip's crop, or where a snippet's clip should play. */
  onResnip: (item: WorkshopItem) => void;
  onDelete: (item: WorkshopItem) => Promise<void>;
  onBringIn: (parent: WorkshopItem | null, file: File) => Promise<void>;
  /** Lay a media item on the page where its source sits. Null when it cannot (no source rect). */
  onLayOnPage: (media: WorkshopItem, source: WorkshopItem) => Promise<void>;
  onJumpPage: (page: number) => void;
  notice: string | null;
};

export default function WorkshopPanel(p: WorkshopPanelProps) {
  const sources = p.items.filter((it) => it.kind !== 'media');
  const mediaByParent = new Map<string, WorkshopItem[]>();
  const loose: WorkshopItem[] = [];
  for (const it of p.items) {
    if (it.kind !== 'media') continue;
    if (it.parent_id) {
      const arr = mediaByParent.get(it.parent_id) ?? [];
      arr.push(it);
      mediaByParent.set(it.parent_id, arr);
    } else loose.push(it);
  }
  // This page's sources first; the rest follow in page order.
  const here = sources.filter((s) => s.page === p.page);
  const elsewhere = sources.filter((s) => s.page !== p.page);

  const [snippetDraft, setSnippetDraft] = useState('');
  // Where the draft's words sit, taken with them from the selection; a
  // pasted or retyped passage has none, and is placed on the bench instead.
  const [snippetAt, setSnippetAt] = useState<{ page: number; rect: FractionalRect | null } | null>(null);
  const [savingSnippet, setSavingSnippet] = useState(false);

  return (
    <div className="p-2 space-y-3 text-[12px]">
      {p.notice && (
        <p className="rounded-md border border-[rgba(232,184,74,0.35)] bg-[rgba(232,184,74,0.08)] px-2 py-1.5 text-[11px] text-[#e8b84a]">
          {p.notice}
        </p>
      )}

      {/* The two ways something gets onto the bench. */}
      <div className="flex gap-1.5">
        {p.snipping ? (
          <button
            onClick={p.onCancelSnip}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-[#e8b84a] bg-[rgba(232,184,74,0.12)] px-2 py-1.5 text-[#e8b84a]"
          >
            <X size={12} /> Drawing — Esc cancels
          </button>
        ) : (
          <button
            onClick={p.onSnip}
            disabled={!p.canWrite}
            title="Draw a rectangle round a plate on the page"
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1.5 text-white/80 hover:border-white/25 hover:text-white disabled:opacity-40"
          >
            <Scissors size={12} /> Snip from page
          </button>
        )}
        <label
          title="Bring in a clip or a still (it is stored in this matter, not transcribed)"
          className={`inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1.5 text-white/80 hover:border-white/25 hover:text-white cursor-pointer ${p.canWrite ? '' : 'opacity-40 pointer-events-none'}`}
        >
          <Upload size={12} /> Bring in
          <input
            type="file"
            accept="video/*,image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void p.onBringIn(null, f);
            }}
          />
        </label>
      </div>

      {/* A passage, for the case where the plate is a paragraph. */}
      <div className="rounded-md border border-[var(--color-border)] p-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1 text-[11px] text-white/55"><Quote size={11} /> Snippet</span>
          {p.selection && (
            <button
              onMouseDown={(e) => e.preventDefault()} // keep the selection on the page
              onClick={() => {
                const s = p.selection;
                if (!s) return;
                setSnippetDraft(s.text);
                setSnippetAt({ page: s.page, rect: s.rect });
              }}
              className="text-[11px] text-[#e8b84a]/85 hover:text-[#e8b84a]"
            >
              Use selection
            </button>
          )}
        </div>
        <textarea
          value={snippetDraft}
          onChange={(e) => setSnippetDraft(e.target.value)}
          // Typing here means reading, not drawing: leave rectangle mode so
          // the page can be selected from again to complete the passage.
          onFocus={() => { if (p.snipping) p.onCancelSnip(); }}
          placeholder="A passage to illustrate — select it on the page and press Use selection (a clip can then play over those words), or paste it"
          rows={3}
          className="w-full resize-y rounded bg-black/20 border border-[var(--color-border)] px-2 py-1 text-[12px] text-white/85 outline-none focus:border-white/30 placeholder:text-white/30"
        />
        <div className="flex items-center gap-2">
          <button
            disabled={!p.canWrite || savingSnippet || !snippetDraft.trim()}
            onClick={async () => {
              setSavingSnippet(true);
              try {
                await p.onSnippet(snippetDraft.trim(), snippetAt);
                setSnippetDraft('');
                setSnippetAt(null);
              } finally { setSavingSnippet(false); }
            }}
            className="inline-flex items-center gap-1 rounded-md bg-[rgba(232,184,74,0.12)] border border-[rgba(232,184,74,0.35)] px-2 py-1 text-[11px] text-[#e8b84a] hover:bg-[rgba(232,184,74,0.2)] disabled:opacity-40"
          >
            {savingSnippet ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Keep on the bench (p. {snippetAt?.page ?? p.page})
          </button>
          {snippetDraft.trim() && (
            <span className="text-[10px] text-white/40">
              {snippetAt?.rect ? 'with its place on the page' : 'place it on the page afterwards'}
            </span>
          )}
        </div>
      </div>

      {sources.length === 0 && loose.length === 0 && !p.snipping && (
        <p className="p-1 text-[11px] leading-relaxed text-white/40">
          Nothing on the bench. Snip a plate off the page, or keep a passage, then take it away to make
          something from it and bring the result back here to compare.
        </p>
      )}

      {here.length > 0 && <SectionLabel>On this page</SectionLabel>}
      {here.map((s) => (
        <SourceCard key={s.id} item={s} derived={mediaByParent.get(s.id) ?? []} p={p} />
      ))}
      {elsewhere.length > 0 && <SectionLabel>Other pages</SectionLabel>}
      {elsewhere.map((s) => (
        <SourceCard key={s.id} item={s} derived={mediaByParent.get(s.id) ?? []} p={p} />
      ))}
      {loose.length > 0 && <SectionLabel>Brought in on their own</SectionLabel>}
      {loose.map((m) => (
        <MediaRow key={m.id} item={m} source={null} p={p} />
      ))}
    </div>
  );
}

// A kept passage reads as a paragraph and edits as one: click the words to
// correct or complete them by hand (a selection off a scan is often short
// a line), click away or press Ctrl/⌘-Enter to keep the change, Esc to drop
// it. Only the words change; the place on the page stays.
function SnippetText({ item, canWrite, onRetext }: { item: WorkshopItem; canWrite: boolean; onRetext: (item: WorkshopItem, text: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text ?? '');
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      const el = ref.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }
  }, [editing]);

  const keep = async () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === (item.text ?? '')) { setDraft(item.text ?? ''); return; }
    setSaving(true);
    try { await onRetext(item, next); } finally { setSaving(false); }
  };

  if (!editing) {
    return (
      <p
        onClick={canWrite ? () => { setDraft(item.text ?? ''); setEditing(true); } : undefined}
        title={canWrite ? 'Click to correct or complete the passage' : undefined}
        className={`px-2 pt-2 text-[12px] leading-relaxed text-white/80 whitespace-pre-wrap ${canWrite ? 'cursor-text rounded hover:bg-white/[0.03]' : ''} ${saving ? 'opacity-50' : ''}`}
      >
        {item.text}
      </p>
    );
  }
  return (
    <textarea
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void keep()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); setDraft(item.text ?? ''); setEditing(false); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void keep(); }
      }}
      rows={Math.min(12, Math.max(3, draft.split('\n').length + 1))}
      className="mx-2 mt-2 w-[calc(100%-16px)] resize-y rounded bg-black/20 border border-[#e8b84a]/50 px-2 py-1 text-[12px] leading-relaxed text-white/85 outline-none"
    />
  );
}

function SectionLabel({ children }: { children: string }) {
  return <p className="px-1 pt-1 text-[10px] uppercase tracking-wider text-white/35">{children}</p>;
}

function SourceCard({ item, derived, p }: { item: WorkshopItem; derived: WorkshopItem[]; p: WorkshopPanelProps }) {
  const [preview, setPreview] = useState<{ key: string; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const key = `${item.page}:${JSON.stringify(item.rect)}:${item.turn}`;

  useEffect(() => {
    if (item.kind !== 'snip' || !item.rect) return;
    let live = true;
    void p.makePreview(item.page, item.rect, item.turn).then((url) => {
      if (live && url) setPreview({ key, url });
    });
    return () => { live = false; };
    // The preview depends on the recipe, which `key` names in full.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const stale = preview && preview.key !== key;
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } finally { setBusy(null); }
  };

  return (
    <div className="rounded-md border border-[var(--color-border)] overflow-hidden">
      {item.kind === 'snip' ? (
        <div className="relative bg-black/30 flex items-center justify-center min-h-[80px]">
          {preview && !stale ? (
            <img src={preview.url} alt={item.label ?? `Snip from page ${item.page}`} className="max-h-[260px] w-full object-contain" />
          ) : (
            <Loader2 size={14} className="animate-spin text-white/40" />
          )}
        </div>
      ) : (
        <SnippetText item={item} canWrite={p.canWrite} onRetext={p.onRetext} />
      )}

      <div className="flex items-center gap-1 px-1.5 py-1">
        <button onClick={() => p.onJumpPage(item.page)} className="text-[10px] tabular-nums text-white/45 hover:text-white/80 px-1" title="Go to the page">
          p. {item.page}{item.turn ? ` · ${item.turn}°` : ''}
        </button>
        {item.kind === 'snippet' && !item.rect && (
          <span className="text-[10px] text-amber-300/80" title="Nothing can play over these words until they are placed on the page">
            not placed
          </span>
        )}
        <div className="flex-1" />
        {item.kind === 'snip' && (
          <>
            <IconBtn title="Turn a quarter clockwise" busy={busy === 'turn'} onClick={() => run('turn', () => p.onTurn(item))}><RotateCw size={12} /></IconBtn>
            <IconBtn title="Draw the rectangle again (crop)" onClick={() => p.onResnip(item)}><Scissors size={12} /></IconBtn>
            <DownloadMenu busy={busy === 'dl'} onPick={(scale) => run('dl', () => p.onDownload(item, scale))} />
          </>
        )}
        {item.kind === 'snippet' && (
          <button
            onClick={() => p.onResnip(item)}
            disabled={!p.canWrite}
            title={item.rect ? 'Draw again where a clip should play over these words' : 'Draw a rectangle round these words on the page; a clip made from them will play there'}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-white/5 disabled:opacity-40 ${item.rect ? 'text-white/55 hover:text-white' : 'text-[#e8b84a]/85 hover:text-[#e8b84a]'}`}
          >
            <Scan size={12} /> {item.rect ? 'Place again' : 'Place on page'}
          </button>
        )}
        <label title="Bring in what you made from this" className={`p-1 rounded text-white/55 hover:text-white hover:bg-white/5 cursor-pointer ${p.canWrite ? '' : 'opacity-40 pointer-events-none'}`}>
          {busy === 'in' ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
          <input
            type="file"
            accept="video/*,image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void run('in', () => p.onBringIn(item, f));
            }}
          />
        </label>
        <IconBtn title="Take this off the bench (and what sits under it)" danger busy={busy === 'del'} onClick={() => run('del', () => p.onDelete(item))}><Trash2 size={12} /></IconBtn>
      </div>

      {derived.length > 0 && (
        <div className="border-t border-[var(--color-border)] bg-black/15">
          {derived.map((m) => <MediaRow key={m.id} item={m} source={item} p={p} />)}
        </div>
      )}
    </div>
  );
}

function MediaRow({ item, source, p }: { item: WorkshopItem; source: WorkshopItem | null; p: WorkshopPanelProps }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const path = item.media?.storage_path ?? null;
  const still = isImageMedia(item.media);

  useEffect(() => {
    if (!path) return;
    let live = true;
    void clipUrl(path).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [path]);

  // A plate, or a placed passage: anything with a box on the page.
  const canLay = !!source && !!source.rect;
  const overWords = source?.kind === 'snippet';
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } finally { setBusy(null); }
  };

  return (
    <div className="px-1.5 py-1.5 space-y-1">
      <div className="bg-black/30 flex items-center justify-center min-h-[60px] rounded">
        {url ? (
          still
            ? <img src={url} alt={item.media?.title ?? 'Brought in'} className="max-h-[220px] w-full object-contain rounded" />
            : <video src={url} controls playsInline className="max-h-[220px] w-full rounded" />
        ) : (
          <Loader2 size={14} className="animate-spin text-white/40" />
        )}
      </div>
      <div className="flex items-center gap-1">
        <span className="inline-flex items-center gap-1 min-w-0 flex-1 text-[11px] text-white/70">
          {still ? <ImageIcon size={11} className="shrink-0" /> : <Film size={11} className="shrink-0" />}
          <span className="truncate">{item.label || item.media?.title || 'Brought in'}</span>
        </span>
        {canLay && (
          <button
            disabled={!p.canWrite || busy === 'lay'}
            onClick={() => run('lay', () => p.onLayOnPage(item, source as WorkshopItem))}
            title={overWords
              ? 'Lay this on the page over the passage — a reader taps the words and it plays'
              : 'Lay this on the page where the plate sits — a reader taps the plate and it plays'}
            className="inline-flex items-center gap-1 rounded-md bg-[rgba(232,184,74,0.12)] border border-[rgba(232,184,74,0.35)] px-1.5 py-0.5 text-[11px] text-[#e8b84a] hover:bg-[rgba(232,184,74,0.2)] disabled:opacity-40"
          >
            {busy === 'lay' ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />} Lay on page
          </button>
        )}
        <IconBtn title="Take this off the bench (the file stays in the Vault)" danger busy={busy === 'del'} onClick={() => run('del', () => p.onDelete(item))}><Trash2 size={12} /></IconBtn>
      </div>
    </div>
  );
}

function IconBtn({ title, onClick, children, danger = false, busy = false }: { title: string; onClick: () => void; children: React.ReactNode; danger?: boolean; busy?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={title}
      aria-label={title}
      className={`p-1 rounded text-white/55 hover:bg-white/5 ${danger ? 'hover:text-red-400' : 'hover:text-white'} disabled:opacity-50`}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : children}
    </button>
  );
}

/** Download at 1×, 2× or 3× (resize): the one choice a plate needs before Flow. */
function DownloadMenu({ onPick, busy }: { onPick: (scale: 1 | 2 | 3) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <IconBtn title="Download as PNG (choose the size)" busy={busy} onClick={() => setOpen((v) => !v)}><Download size={12} /></IconBtn>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 rounded-md border border-white/15 bg-[#1a1a22] shadow-xl py-1 min-w-[150px]">
          {([1, 2, 3] as const).map((s) => (
            <button
              key={s}
              onClick={() => { setOpen(false); onPick(s); }}
              className="block w-full text-left px-3 py-1 text-[11px] text-white/80 hover:bg-white/5 hover:text-white"
            >
              {s === 1 ? 'Small (1×)' : s === 2 ? 'Medium (2×)' : 'Large (3×)'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
