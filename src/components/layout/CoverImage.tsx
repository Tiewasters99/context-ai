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
import { X, Palette, Image as ImageIcon, Maximize2, Minimize2, LinkIcon, Upload } from 'lucide-react';
import { supabase } from '@/lib/supabase';

const templateCovers = [
  { id: 'gradient-indigo',   name: 'Indigo Wave', value: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a78bfa 100%)' },
  { id: 'gradient-ocean',    name: 'Ocean',       value: 'linear-gradient(135deg, #0ea5e9 0%, #2563eb 50%, #1e40af 100%)' },
  { id: 'gradient-sunset',   name: 'Sunset',      value: 'linear-gradient(135deg, #f97316 0%, #ef4444 50%, #dc2626 100%)' },
  { id: 'gradient-forest',   name: 'Forest',      value: 'linear-gradient(135deg, #10b981 0%, #059669 50%, #047857 100%)' },
  { id: 'gradient-midnight', name: 'Midnight',    value: 'linear-gradient(135deg, #1e293b 0%, #334155 50%, #475569 100%)' },
  { id: 'gradient-rose',     name: 'Rose Gold',   value: 'linear-gradient(135deg, #fb7185 0%, #e11d48 50%, #be123c 100%)' },
  { id: 'gradient-aurora',   name: 'Aurora',      value: 'linear-gradient(135deg, #6366f1 0%, #06b6d4 50%, #10b981 100%)' },
  { id: 'gradient-amber',    name: 'Amber',       value: 'linear-gradient(135deg, #f59e0b 0%, #d97706 50%, #b45309 100%)' },
];

interface CoverImageProps {
  coverUrl?: string | null;
  onCoverChange?: (url: string | null) => void;
  editable?: boolean;
}

export default function CoverImage({
  coverUrl,
  onCoverChange,
  editable = false,
}: CoverImageProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const cover = coverUrl ?? '';

  const isGradient = cover.startsWith('linear-gradient');
  const hasImage = cover && !isGradient;
  const hasCover = !!cover;

  // Expanded mode: write the cover into a CSS variable on the root, so
  // MainLayout's <main> background-image picks it up and the cover
  // becomes the page background regardless of where the card sits.
  // Reverts on collapse, navigate-away (component unmount), or cover
  // change.
  useEffect(() => {
    if (!expanded || !hasCover) return;
    const value = isGradient ? cover : `url("${cover.replace(/"/g, '\\"')}")`;
    document.documentElement.style.setProperty('--page-cover', value);
    return () => {
      document.documentElement.style.removeProperty('--page-cover');
    };
  }, [expanded, cover, isGradient, hasCover]);

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
          className="relative w-full h-[180px] overflow-hidden cursor-pointer"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            setExpanded(true);
          }}
          title="Click to expand to background"
        >
          {hasImage ? (
            <img src={cover} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full" style={{ background: cover }} />
          )}

          {/* Hover overlay — controls only show in editable mode */}
          {editable && (
            <div
              className={`absolute inset-0 flex items-end justify-end p-3 transition-opacity duration-200 ${
                isHovered ? 'opacity-100' : 'opacity-0'
              }`}
              style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.4), transparent 50%)' }}
            >
              <div className="flex gap-2">
                <button
                  onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-black/40 backdrop-blur-sm rounded-md hover:bg-black/60 transition-colors flex items-center gap-1.5"
                  title="Expand"
                >
                  <Maximize2 size={12} /> Expand
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleRemove(); }}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-black/40 backdrop-blur-sm rounded-md hover:bg-black/60 transition-colors"
                >
                  Hide cover
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setShowPicker(true); }}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-black/40 backdrop-blur-sm rounded-md hover:bg-black/60 transition-colors"
                >
                  Change cover
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
          variable, so the 180px strip is hidden upstream. Render a
          small floating Collapse pill so users can return to the
          banner-strip view. */}
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
  const urlInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const submitUrl = () => {
    const u = urlDraft.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u) && !u.startsWith('data:image/')) {
      alert('Please paste a URL starting with http(s):// (or a data:image/ URI).');
      return;
    }
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
          {uploadError && (
            <p className="mt-1.5 text-[11px] text-red-300">{uploadError}</p>
          )}
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
        </div>

        {/* Templates */}
        <div className="mb-4">
          <div className="flex items-center gap-1.5 text-xs font-medium text-white/60 mb-3">
            <Palette size={12} />
            Gradient templates
          </div>
          <div className="grid grid-cols-4 gap-2">
            {templateCovers.map((t) => (
              <button
                key={t.id}
                onClick={() => onSelect(t.value)}
                className="group relative h-16 rounded-lg overflow-hidden border-2 border-transparent hover:border-[#e8b84a] transition-colors"
                title={t.name}
              >
                <div className="w-full h-full" style={{ background: t.value }} />
                <div className="absolute inset-0 flex items-end opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="w-full text-center text-[10px] font-medium text-white bg-black/40 py-0.5">
                    {t.name}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Remove */}
        {hasCover && (
          <button onClick={onRemove} className="w-full text-center text-xs text-red-400 hover:text-red-300 py-2">
            Remove cover
          </button>
        )}
      </div>
    </>
  );
}
