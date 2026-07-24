// Banner / cover image for content items (pages, lists, tables) and
// for spaces (matter, serverspace). Controlled by `coverUrl` —
// component never holds its own copy of the persisted value, so a
// later refetch always wins. Caller persists via onCoverChange.
//
// Supports two cover sources:
//   - CSS gradient (string starting with "linear-gradient(")
//   - Image URL (anything else)
// File upload is intentionally dropped here — it used to call
// URL.createObjectURL which doesn't survive a refresh. A real
// upload to a Supabase storage bucket is the next iteration.
//
// Click the banner to expand it to a full-viewport view; click again
// (or press Esc) to collapse. Expansion is local state, not persisted.

import { useEffect, useState, useRef } from 'react';
import { X, Palette, Image as ImageIcon, Maximize2, Minimize2, LinkIcon, Upload, MoveVertical, LayoutGrid } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import TemplateLibrary from '@/components/vault/TemplateLibrary';

const featuredCovers = [
  { id: 'abstract-painting', name: 'Abstract',        file: '/templates/abstract-painting.png' },
  { id: 'alhambra-light',    name: 'Alhambra Light',  file: '/templates/alhambra-light.png' },
  { id: 'algiers-bay-day',   name: 'Algiers Bay',     file: '/templates/algiers-bay-day.png' },
  { id: 'atlantis-ruins',    name: 'Atlantis Ruins',  file: '/templates/atlantis-ruins.png' },
  { id: 'big-bang',          name: 'Big Bang',        file: '/templates/big-bang.png' },
  { id: 'boat-1',            name: 'Boat',            file: '/templates/boat-1.png' },
  { id: 'ballerina-1',       name: 'Ballerina',       file: '/templates/ballerina-1.png' },
  { id: 'alhambra-arches',   name: 'Alhambra Arches', file: '/templates/alhambra-arches.png' },
];

interface CoverImageProps {
  coverUrl?: string | null;
  onCoverChange?: (url: string | null) => void;
  editable?: boolean;
  // Optional controlled expansion: when both are provided, the parent
  // owns the expanded state (and can persist it). Otherwise CoverImage
  // keeps its own session-only state and click-to-expand still works.
  expanded?: boolean;
  onExpandChange?: (next: boolean) => void;
  // Optional storage key for the vertical reposition value of the
  // expanded cover (0–100). Without it, reposition is session-only.
  persistKey?: string;
}

export default function CoverImage({
  coverUrl,
  onCoverChange,
  editable = false,
  expanded: expandedProp,
  onExpandChange,
  persistKey,
}: CoverImageProps) {
  const [isHovered, setIsHovered] = useState(false);
  // Touch has no hover-out: a tap toggles the controls instead, a tap
  // anywhere else (or the ✕) puts them away.
  const [touchControls, setTouchControls] = useState(false);
  const lastPointerType = useRef('mouse');
  const bannerRef = useRef<HTMLDivElement>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isControlled = expandedProp !== undefined;
  const expanded = isControlled ? expandedProp : internalExpanded;
  const setExpanded = (next: boolean) => {
    if (isControlled) onExpandChange?.(next);
    else setInternalExpanded(next);
  };
  // Vertical position of the expanded cover (0 = top, 50 = center, 100 = bottom).
  // Hydrate from localStorage when a persistKey is provided.
  const [bgY, setBgY] = useState<number>(50);
  useEffect(() => {
    if (!persistKey) { setBgY(50); return; }
    try {
      const raw = localStorage.getItem(`${persistKey}.bgY`);
      if (raw !== null) {
        const n = parseFloat(raw);
        if (!Number.isNaN(n)) setBgY(Math.max(0, Math.min(100, n)));
      }
    } catch {}
  }, [persistKey]);
  const cover = coverUrl ?? '';

  const isGradient = cover.startsWith('linear-gradient');
  const hasImage = cover && !isGradient;
  const hasCover = !!cover;

  // Expanded mode: write the cover into a CSS variable on the root, so
  // MainLayout's <main> background-image picks it up and the cover
  // becomes the page background regardless of where the card sits.
  // Reverts on collapse, navigate-away (component unmount), or cover
  // change. Vertical position flows through `--page-cover-position` so
  // users can drag the bg up/down via the reposition pill.
  useEffect(() => {
    if (!expanded || !hasCover) return;
    const value = isGradient ? cover : `url("${cover.replace(/"/g, '\\"')}")`;
    document.documentElement.style.setProperty('--page-cover', value);
    document.documentElement.style.setProperty('--page-cover-position', `center ${bgY}%`);
    return () => {
      document.documentElement.style.removeProperty('--page-cover');
      document.documentElement.style.removeProperty('--page-cover-position');
    };
  }, [expanded, cover, isGradient, hasCover, bgY]);

  // Drag-to-reposition for the expanded cover. The pill button starts a
  // pointer capture; document-level move/up handlers update bgY until
  // release, then persist if a key was provided.
  const dragRef = useRef({ active: false, startY: 0, startBg: 50 });
  useEffect(() => {
    if (!expanded) return;
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current.active) return;
      const dy = e.clientY - dragRef.current.startY;
      // Map pixel delta to percent: full viewport = 100%. Inverted so
      // dragging down moves the visible portion DOWN (image shifts up
      // visually, exposing more of the bottom).
      const pct = (dy / window.innerHeight) * 100;
      const next = Math.max(0, Math.min(100, dragRef.current.startBg + pct));
      setBgY(next);
    };
    const onUp = () => {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      if (persistKey) {
        try { localStorage.setItem(`${persistKey}.bgY`, String(bgY)); } catch {}
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
  }, [expanded, bgY, persistKey]);
  const startReposition = (e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { active: true, startY: e.clientY, startBg: bgY };
  };

  // Tap-away dismisses touch-summoned controls.
  useEffect(() => {
    if (!touchControls) return;
    const away = (e: PointerEvent) => {
      if (!bannerRef.current?.contains(e.target as Node)) setTouchControls(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [touchControls]);

  // Esc key collapses the expanded view.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const handleSelect = (value: string) => {
    onCoverChange?.(value);
    setShowPicker(false);
  };
  const handleRemove = () => {
    onCoverChange?.(null);
    setShowPicker(false);
    setExpanded(false);
  };

  // No cover → a slim, discoverable bar with a centered "Add cover"
  // button when editable. Subtle until hovered, like Notion.
  if (!hasCover) {
    return (
      <div className="relative w-full">
        {editable ? (
          <>
            <button
              onClick={() => setShowPicker(true)}
              className="group w-full h-12 flex items-center justify-center gap-2 border-y border-dashed border-[rgba(255,255,255,0.06)] text-[12px] text-white/40 hover:text-[#e8b84a] hover:bg-[rgba(232,184,74,0.04)] hover:border-[rgba(232,184,74,0.3)] transition-colors"
              title="Add a banner image"
            >
              <ImageIcon size={14} strokeWidth={1.75} />
              <span>Add cover</span>
            </button>
            {showPicker && (
              <CoverPicker
                onSelect={handleSelect}
                onRemove={handleRemove}
                onClose={() => setShowPicker(false)}
                hasCover={false}
              />
            )}
          </>
        ) : (
          // Non-editable + no cover → no banner area at all.
          <div className="h-2" />
        )}
      </div>
    );
  }

  // Cover is set
  return (
    <>
      {!expanded && <div className="relative w-full">
        <div
          ref={bannerRef}
          className="relative w-full h-[180px] overflow-hidden cursor-pointer"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onPointerDown={(e) => { lastPointerType.current = e.pointerType; }}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            // Touch: the first tap summons the controls, a second tap on the
            // cover puts them away. Expansion is the Expand button's job.
            if (lastPointerType.current === 'touch' && editable) {
              setTouchControls((v) => !v);
              return;
            }
            setExpanded(true);
          }}
          title="Click to expand to background"
        >
          {hasImage ? (
            <img src={cover} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full" style={{ background: cover }} />
          )}

          {/* Overlay controls — hover on desktop, tap-toggled on touch.
              pointer-events-none while hidden, so invisible buttons never
              swallow taps. */}
          {editable && (
            <div
              className={`absolute inset-0 flex items-end justify-end p-3 transition-opacity duration-200 ${
                isHovered || touchControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
              style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.4), transparent 50%)' }}
            >
              <div className="flex gap-2 flex-wrap justify-end">
                <button
                  onClick={(e) => { e.stopPropagation(); setTouchControls(false); setExpanded(true); }}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-black/40 backdrop-blur-sm rounded-md hover:bg-black/60 transition-colors flex items-center gap-1.5"
                  title="Expand"
                >
                  <Maximize2 size={12} /> Expand
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setTouchControls(false); handleRemove(); }}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-black/40 backdrop-blur-sm rounded-md hover:bg-black/60 transition-colors"
                >
                  Hide cover
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setTouchControls(false); setShowPicker(true); }}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-black/40 backdrop-blur-sm rounded-md hover:bg-black/60 transition-colors"
                >
                  Change cover
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setTouchControls(false); setIsHovered(false); }}
                  className="px-2.5 py-1.5 text-xs font-medium text-white bg-black/40 backdrop-blur-sm rounded-md hover:bg-black/60 transition-colors"
                  title="Leave the cover as it is"
                  aria-label="Dismiss cover options"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          )}
        </div>

        {showPicker && (
          <CoverPicker
            onSelect={handleSelect}
            onRemove={handleRemove}
            onClose={() => setShowPicker(false)}
            hasCover={true}
          />
        )}
      </div>}

      {/* Expanded mode: the cover became the page background via CSS
          variable, so the 180px strip is hidden upstream. Render two
          floating pills — Reposition (hold + drag up/down to shift
          the visible portion of the image) and Collapse. */}
      {expanded && hasImage && (
        <button
          onPointerDown={startReposition}
          className="fixed top-[60px] right-44 z-30 p-2 rounded-md bg-black/50 backdrop-blur-sm text-white/80 hover:text-white hover:bg-black/70 transition-colors flex items-center gap-1.5 text-xs cursor-ns-resize select-none"
          title="Hold and drag up/down to reposition cover"
        >
          <MoveVertical size={14} /> Reposition
        </button>
      )}
      {expanded && (
        <button
          onClick={() => setExpanded(false)}
          className="fixed top-[60px] right-6 z-30 p-2 rounded-md bg-black/50 backdrop-blur-sm text-white/80 hover:text-white hover:bg-black/70 transition-colors flex items-center gap-1.5 text-xs"
          title="Collapse cover (Esc)"
        >
          <Minimize2 size={14} /> Collapse cover
        </button>
      )}
    </>
  );
}


interface CoverPickerProps {
  onSelect: (value: string) => void;
  onRemove: () => void;
  onClose: () => void;
  hasCover: boolean;
}

function CoverPicker({ onSelect, onRemove, onClose, hasCover }: CoverPickerProps) {
  const [urlDraft, setUrlDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const submitUrl = () => {
    const u = urlDraft.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u) && !u.startsWith('data:image/')) {
      setUploadError('Please paste a URL starting with http(s):// (or a data:image/ URI).');
      return;
    }
    setUploadError(null);
    onSelect(u);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setUploadError('Please choose an image file.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setUploadError('Image is over 8 MB. Please pick a smaller one.');
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error('Not signed in');
      const ext = file.name.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? '';
      const path = `${userId}/${crypto.randomUUID()}${ext}`;
      const { error: uploadErr } = await supabase.storage
        .from('cover-images')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (uploadErr) throw uploadErr;
      const { data: pub } = supabase.storage.from('cover-images').getPublicUrl(path);
      onSelect(pub.publicUrl);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="absolute right-4 top-full z-50 w-full max-w-md bg-[#1c1c26] rounded-xl shadow-xl border border-[rgba(255,255,255,0.06)] p-5 mt-2">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-[#f5f2ed]">Choose a cover</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#22222e] text-white/50">
            <X size={16} />
          </button>
        </div>

        {/* Upload */}
        <div className="mb-5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-white/60 mb-2">
            <Upload size={12} />
            Upload from your device
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center justify-center gap-2 w-full p-3 rounded-md border border-dashed border-[rgba(255,255,255,0.1)] text-sm text-white/60 hover:border-[#e8b84a] hover:text-[#e8b84a] hover:bg-[rgba(232,184,74,0.04)] transition-colors disabled:opacity-50 disabled:cursor-wait"
          >
            <Upload size={14} />
            {uploading ? 'Uploading…' : 'Choose an image (≤ 8 MB)'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFile}
            className="hidden"
          />
        </div>

        {/* Paste URL */}
        <div className="mb-5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-white/60 mb-2">
            <LinkIcon size={12} />
            Or paste an image URL
          </div>
          <div className="flex gap-2">
            <input
              ref={urlInputRef}
              type="url"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitUrl(); } }}
              placeholder="https://images.unsplash.com/…"
              className="flex-1 px-3 py-2 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[13px] text-[#f5f2ed] placeholder-white/30 outline-none focus:border-[#e8b84a]/50"
            />
            <button
              onClick={submitUrl}
              disabled={!urlDraft.trim()}
              className="px-3 py-2 rounded-md bg-[#e8b84a] hover:bg-[#f5d565] text-[#0e0e12] text-[12px] font-semibold transition-colors disabled:opacity-40"
            >
              Use
            </button>
          </div>
          {/* Shared error line for both the upload and URL paths — the
              popover is small enough that one spot serves both. */}
          {uploadError && (
            <p className="mt-1.5 text-[11px] text-red-300">{uploadError}</p>
          )}
        </div>

        {/* Featured covers — sample from the template library */}
        <div className="mb-4">
          <div className="flex items-center gap-1.5 text-xs font-medium text-white/60 mb-3">
            <Palette size={12} />
            Featured covers
          </div>
          <div className="grid grid-cols-4 gap-2">
            {featuredCovers.map((t) => (
              <button
                key={t.id}
                onClick={() => onSelect(t.file)}
                className="group relative h-16 rounded-lg overflow-hidden border-2 border-transparent hover:border-[#e8b84a] transition-colors"
                title={t.name}
              >
                <img src={t.file} alt="" className="w-full h-full object-cover" loading="lazy" />
                <div className="absolute inset-0 flex items-end opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="w-full text-center text-[10px] font-medium text-white bg-black/40 py-0.5">
                    {t.name}
                  </span>
                </div>
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowLibrary(true)}
            className="mt-3 flex items-center justify-center gap-2 w-full py-2 rounded-md border border-[rgba(255,255,255,0.1)] text-xs text-white/60 hover:text-[#e8b84a] hover:border-[#e8b84a]/40 hover:bg-[rgba(232,184,74,0.04)] transition-colors"
            title="Browse the full cover library"
          >
            <LayoutGrid size={14} />
            Browse all covers
          </button>
        </div>

        {/* Remove */}
        {hasCover && (
          <button onClick={onRemove} className="w-full text-center text-xs text-red-400 hover:text-red-300 py-2">
            Remove cover
          </button>
        )}
      </div>

      {showLibrary && (
        <TemplateLibrary
          onSelect={(url) => { onSelect(url); setShowLibrary(false); }}
          onClose={() => setShowLibrary(false)}
        />
      )}
    </>
  );
}
