import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Lock, Unlock, X } from 'lucide-react';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import {
  useContentItem,
  updateContentItem,
  useContentInvalidate,
  type ContentItemFull,
} from '@/hooks/useContentItems';

export default function PageView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { cardRef, toggleFullscreen } = useDraggableResizable();
  const { data: item, isLoading, error } = useContentItem(id);
  const invalidate = useContentInvalidate();

  // Local editor state — kept independent of the cached row so the
  // contentEditable surfaces don't get reset on every refetch.
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);

  // Hydrate the editor exactly once per loaded id. Subsequent refetches
  // don't clobber the user's in-flight edits.
  useEffect(() => {
    if (!item || hydrated.current) return;
    setTitle(item.title);
    const initialBody = typeof item.content?.body === 'string' ? item.content.body : '';
    setBody(initialBody);
    if (titleRef.current) titleRef.current.textContent = item.title;
    if (bodyRef.current) bodyRef.current.textContent = initialBody;
    hydrated.current = true;
  }, [item]);

  // Reset hydration when navigating to a different page id.
  useEffect(() => {
    hydrated.current = false;
  }, [id]);

  const persist = async (patch: Partial<Pick<ContentItemFull, 'title' | 'content' | 'is_locked'>>) => {
    if (!id) return;
    setSaving(true);
    try {
      await updateContentItem(id, patch);
      setSavedAt(Date.now());
      invalidate.invalidateItem(id);
    } catch (e) {
      console.error('save failed', e);
    } finally {
      setSaving(false);
    }
  };

  const handleTitleBlur = () => {
    const next = (titleRef.current?.textContent ?? '').trim();
    if (next === title) return;
    setTitle(next);
    persist({ title: next || 'Untitled Page' });
  };

  const handleBodyBlur = () => {
    const next = bodyRef.current?.textContent ?? '';
    if (next === body) return;
    setBody(next);
    persist({ content: { body: next } });
  };

  const toggleLock = () => {
    if (!item) return;
    const next = !item.is_locked;
    persist({ is_locked: next });
  };

  const isLocked = item?.is_locked ?? false;

  return (
    <div>
      <CoverImage editable />

      <div ref={cardRef} className="max-w-4xl mx-auto px-8 py-8 rounded-xl backdrop-blur-[30px] border border-[rgba(255,255,255,0.06)] my-8 cursor-grab select-none" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
        {/* Close + drag handle + fullscreen */}
        <div className="flex items-center justify-between mb-4 -mt-1">
          <button
            onClick={() => navigate(-1)}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
            title="Back"
          >
            <X size={14} strokeWidth={2} />
          </button>
          <div className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors" title="Drag to move" />
          <FullscreenToggle onToggle={toggleFullscreen} />
        </div>

        {error && (
          <p className="text-[13px] text-red-300 py-12 text-center">
            {error instanceof Error ? error.message : 'Failed to load page'}
          </p>
        )}

        {!error && isLoading && (
          <p className="text-[13px] text-white/40 py-12 text-center">Loading…</p>
        )}

        {!error && !isLoading && !item && (
          <p className="text-[13px] text-white/40 py-12 text-center">Page not found.</p>
        )}

        {item && (
          <div className="flex gap-8">
            <div className="flex-1 min-w-0">
              <div
                ref={titleRef}
                contentEditable={!isLocked}
                suppressContentEditableWarning
                onBlur={handleTitleBlur}
                className="text-3xl font-bold text-[#f5f2ed] outline-none mb-1 empty:before:content-['Untitled'] empty:before:text-white/30"
                data-placeholder="Untitled"
              />
              <div
                ref={bodyRef}
                contentEditable={!isLocked}
                suppressContentEditableWarning
                onBlur={handleBodyBlur}
                className="mt-6 min-h-[400px] text-[#e8e4de] leading-relaxed outline-none text-[15px] whitespace-pre-wrap empty:before:content-['Start_writing…'] empty:before:text-white/30"
              />
            </div>

            <div className="w-56 shrink-0">
              <div className="sticky top-8 space-y-6">
                <button
                  onClick={toggleLock}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full ${
                    isLocked
                      ? 'bg-[#d4a054]/10 text-[#d4a054] hover:bg-[#d4a054]/15'
                      : 'bg-[#1c1c26] text-white/80 hover:bg-[#22222e]'
                  }`}
                >
                  {isLocked ? <Lock size={14} /> : <Unlock size={14} />}
                  {isLocked ? 'Locked' : 'Unlocked'}
                </button>

                <div className="space-y-2 text-xs text-white/60">
                  <div className="flex justify-between">
                    <span>Created</span>
                    <span className="text-[#e8e4de]">
                      {new Date(item.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Modified</span>
                    <span className="text-[#e8e4de]">
                      {new Date(item.updated_at).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span>Status</span>
                    <span className={isLocked ? 'text-[#d4a054]' : 'text-[#4ade80]'}>
                      {saving ? 'Saving…' : savedAt ? 'Saved' : isLocked ? 'Locked' : 'Editable'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
