import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Circle, CheckCircle2, Trash2, X } from 'lucide-react';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import {
  useContentItem,
  updateContentItem,
  useContentInvalidate,
} from '@/hooks/useContentItems';

interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

interface ListContent {
  items: ChecklistItem[];
}

function readListContent(content: Record<string, unknown> | undefined): ListContent {
  const raw = content?.items;
  if (!Array.isArray(raw)) return { items: [] };
  const items = raw
    .map((r): ChecklistItem | null => {
      if (!r || typeof r !== 'object') return null;
      const o = r as Record<string, unknown>;
      if (typeof o.id !== 'string' || typeof o.text !== 'string') return null;
      return { id: o.id, text: o.text, done: !!o.done };
    })
    .filter((x): x is ChecklistItem => x !== null);
  return { items };
}

export default function ListView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { cardRef, toggleFullscreen } = useDraggableResizable();
  const { data: item, isLoading, error } = useContentItem(id);
  const invalidate = useContentInvalidate();

  const [title, setTitle] = useState('');
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [draftText, setDraftText] = useState('');
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);

  useEffect(() => { hydrated.current = false; }, [id]);

  useEffect(() => {
    if (!item || hydrated.current) return;
    setTitle(item.title);
    setItems(readListContent(item.content).items);
    if (titleRef.current) titleRef.current.textContent = item.title;
    hydrated.current = true;
  }, [item]);

  const persistItems = async (next: ChecklistItem[]) => {
    if (!id) return;
    setSaving(true);
    try {
      await updateContentItem(id, { content: { items: next } });
      invalidate.invalidateItem(id);
    } catch (e) {
      console.error('save failed', e);
    } finally {
      setSaving(false);
    }
  };

  const persistTitle = async (next: string) => {
    if (!id) return;
    setSaving(true);
    try {
      await updateContentItem(id, { title: next || 'Untitled List' });
      invalidate.invalidateItem(id);
    } catch (e) {
      console.error('title save failed', e);
    } finally {
      setSaving(false);
    }
  };

  const handleTitleBlur = () => {
    const next = (titleRef.current?.textContent ?? '').trim();
    if (next === title) return;
    setTitle(next);
    persistTitle(next);
  };

  const addItem = () => {
    const text = draftText.trim();
    if (!text) return;
    const newItem: ChecklistItem = {
      id: crypto.randomUUID(),
      text,
      done: false,
    };
    const next = [...items, newItem];
    setItems(next);
    setDraftText('');
    persistItems(next);
  };

  const toggleItem = (itemId: string) => {
    const next = items.map((i) => i.id === itemId ? { ...i, done: !i.done } : i);
    setItems(next);
    persistItems(next);
  };

  const deleteItem = (itemId: string) => {
    const next = items.filter((i) => i.id !== itemId);
    setItems(next);
    persistItems(next);
  };

  const editItemText = (itemId: string, text: string) => {
    const next = items.map((i) => i.id === itemId ? { ...i, text } : i);
    setItems(next);
    persistItems(next);
  };

  const doneCount = items.filter((i) => i.done).length;
  const progress = items.length === 0 ? 0 : Math.round((doneCount / items.length) * 100);

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
            {error instanceof Error ? error.message : 'Failed to load list'}
          </p>
        )}
        {!error && isLoading && (
          <p className="text-[13px] text-white/40 py-12 text-center">Loading…</p>
        )}
        {!error && !isLoading && !item && (
          <p className="text-[13px] text-white/40 py-12 text-center">List not found.</p>
        )}

        {item && (
          <>
            <div
              ref={titleRef}
              contentEditable
              suppressContentEditableWarning
              onBlur={handleTitleBlur}
              className="text-2xl font-bold text-[#f5f2ed] outline-none mb-1 empty:before:content-['Untitled_List'] empty:before:text-white/30"
            />
            <p className="text-[11px] text-white/30 mb-4">
              {saving ? 'Saving…' : `${doneCount} of ${items.length} complete · ${progress}%`}
            </p>

            <div className="h-2 bg-[#1c1c26] rounded-full overflow-hidden mb-6">
              <div
                className="h-full bg-[#4ade80] rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>

            <div className="space-y-1">
              {items.map((it) => (
                <div
                  key={it.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg border border-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.03)] transition-colors group"
                >
                  <button
                    onClick={() => toggleItem(it.id)}
                    className="shrink-0 transition-opacity hover:opacity-70"
                  >
                    {it.done
                      ? <CheckCircle2 size={18} className="text-[#4ade80]" />
                      : <Circle size={18} className="text-white/40" />}
                  </button>
                  <input
                    type="text"
                    value={it.text}
                    onChange={(e) => setItems(items.map((i) => i.id === it.id ? { ...i, text: e.target.value } : i))}
                    onBlur={(e) => editItemText(it.id, e.target.value)}
                    className={`flex-1 bg-transparent outline-none text-[14px] ${it.done ? 'line-through text-white/40' : 'text-[#f5f2ed]'}`}
                  />
                  <button
                    onClick={() => deleteItem(it.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded text-white/40 hover:text-red-300 hover:bg-red-300/10 transition-all shrink-0"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2 mt-3 px-3 py-2 rounded-lg border border-dashed border-[rgba(255,255,255,0.1)]">
              <Plus size={14} className="text-white/40 shrink-0" />
              <input
                type="text"
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }}
                placeholder="Add an item — press Enter"
                className="flex-1 bg-transparent outline-none text-[14px] text-[#f5f2ed] placeholder-white/30"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
