import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Circle, CheckCircle2, Trash2, X, GripVertical, Calendar, ArrowUpDown } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
  due?: string | null;  // YYYY-MM-DD or null
}

function readListContent(content: Record<string, unknown> | undefined): ChecklistItem[] {
  const raw = content?.items;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r): ChecklistItem | null => {
      if (!r || typeof r !== 'object') return null;
      const o = r as Record<string, unknown>;
      if (typeof o.id !== 'string' || typeof o.text !== 'string') return null;
      const due = typeof o.due === 'string' ? o.due : null;
      return { id: o.id, text: o.text, done: !!o.done, due };
    })
    .filter((x): x is ChecklistItem => x !== null);
}

type SortMode = 'manual' | 'due';

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
  const [sortMode, setSortMode] = useState<SortMode>('manual');
  const titleRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);

  useEffect(() => { hydrated.current = false; }, [id]);

  useEffect(() => {
    if (!item || hydrated.current) return;
    setTitle(item.title);
    setItems(readListContent(item.content));
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
      due: null,
    };
    const next = [...items, newItem];
    setItems(next);
    setDraftText('');
    persistItems(next);
  };

  const updateItem = (itemId: string, patch: Partial<ChecklistItem>) => {
    const next = items.map((i) => i.id === itemId ? { ...i, ...patch } : i);
    setItems(next);
    persistItems(next);
  };

  const deleteItem = (itemId: string) => {
    const next = items.filter((i) => i.id !== itemId);
    setItems(next);
    persistItems(next);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((i) => i.id === active.id);
    const newIndex = items.findIndex((i) => i.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(items, oldIndex, newIndex);
    setItems(next);
    persistItems(next);
  };

  // Display order: manual respects array order; due-date sort puts undated last.
  const displayItems = useMemo(() => {
    if (sortMode === 'manual') return items;
    return [...items].sort((a, b) => {
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due) return -1;
      if (b.due) return 1;
      return 0;
    });
  }, [items, sortMode]);

  const doneCount = items.filter((i) => i.done).length;
  const progress = items.length === 0 ? 0 : Math.round((doneCount / items.length) * 100);
  const today = new Date().toISOString().slice(0, 10);

  const handleCoverChange = async (url: string | null) => {
    if (!id) return;
    await updateContentItem(id, { cover_url: url });
    invalidate.invalidateItem(id);
  };

  return (
    <div>
      <CoverImage
        coverUrl={item?.cover_url ?? null}
        onCoverChange={handleCoverChange}
        editable={true}
      />

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
            <div className="flex items-center justify-between mb-4">
              <p className="text-[11px] text-white/30">
                {saving ? 'Saving…' : `${doneCount} of ${items.length} complete · ${progress}%`}
              </p>
              <button
                onClick={() => setSortMode((m) => m === 'manual' ? 'due' : 'manual')}
                className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-white/50 hover:text-white hover:bg-[rgba(255,255,255,0.04)] transition-colors"
                title={sortMode === 'manual' ? 'Sort by due date' : 'Manual order'}
              >
                <ArrowUpDown size={11} />
                {sortMode === 'manual' ? 'Manual' : 'By due date'}
              </button>
            </div>

            <div className="h-2 bg-[#1c1c26] rounded-full overflow-hidden mb-6">
              <div
                className="h-full bg-[#4ade80] rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={displayItems.map((i) => i.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-1">
                  {displayItems.map((it) => (
                    <SortableItem
                      key={it.id}
                      item={it}
                      today={today}
                      sortable={sortMode === 'manual'}
                      onToggle={() => updateItem(it.id, { done: !it.done })}
                      onChangeText={(text) => updateItem(it.id, { text })}
                      onChangeDue={(due) => updateItem(it.id, { due: due || null })}
                      onDelete={() => deleteItem(it.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

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


interface SortableItemProps {
  item: ChecklistItem;
  today: string;
  sortable: boolean;
  onToggle: () => void;
  onChangeText: (text: string) => void;
  onChangeDue: (due: string) => void;
  onDelete: () => void;
}

function SortableItem({ item, today, sortable, onToggle, onChangeText, onChangeDue, onDelete }: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: !sortable });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Draft local text so each keystroke doesn't trigger a save round-trip.
  const [text, setText] = useState(item.text);
  useEffect(() => { setText(item.text); }, [item.text]);

  const overdue = item.due && !item.done && item.due < today;
  const todayDue = item.due && !item.done && item.due === today;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 px-2 py-2 rounded-lg border border-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.03)] transition-colors group"
    >
      {sortable && (
        <button
          {...attributes}
          {...listeners}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-white/30 hover:text-white/70 transition-all shrink-0 cursor-grab active:cursor-grabbing"
          title="Drag to reorder"
        >
          <GripVertical size={13} />
        </button>
      )}
      <button onClick={onToggle} className="shrink-0 transition-opacity hover:opacity-70" title={item.done ? 'Mark incomplete' : 'Mark done'}>
        {item.done
          ? <CheckCircle2 size={18} className="text-[#4ade80]" />
          : <Circle size={18} className="text-white/40" />}
      </button>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== item.text) onChangeText(text); }}
        className={`flex-1 bg-transparent outline-none text-[14px] ${item.done ? 'line-through text-white/40' : 'text-[#f5f2ed]'}`}
      />
      <DueDateField
        value={item.due ?? ''}
        onChange={onChangeDue}
        overdue={!!overdue}
        todayDue={!!todayDue}
        muted={item.done}
      />
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 p-1 rounded text-white/40 hover:text-red-300 hover:bg-red-300/10 transition-all shrink-0"
        title="Delete"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}


interface DueDateFieldProps {
  value: string;
  onChange: (value: string) => void;
  overdue: boolean;
  todayDue: boolean;
  muted: boolean;
}

function DueDateField({ value, onChange, overdue, todayDue, muted }: DueDateFieldProps) {
  const colorClass = muted
    ? 'text-white/30'
    : overdue
      ? 'text-red-300'
      : todayDue
        ? 'text-[#e8b84a]'
        : value
          ? 'text-white/70'
          : 'text-white/30 hover:text-white/60';

  // Wrap the date input in a label so the icon/calendar opens it on click.
  return (
    <label className={`flex items-center gap-1 cursor-pointer text-[11px] shrink-0 px-2 py-1 rounded hover:bg-[rgba(255,255,255,0.04)] transition-colors ${colorClass}`} title="Due date">
      <Calendar size={11} />
      {value
        ? <span>{formatShortDate(value)}</span>
        : <span className="hidden group-hover:inline">Due</span>}
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute opacity-0 w-0 h-0 -z-10"
      />
    </label>
  );
}

function formatShortDate(iso: string): string {
  // YYYY-MM-DD -> "Apr 28" or "Apr 28, 2027" if not current year.
  try {
    const d = new Date(iso + 'T00:00:00');
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  } catch {
    return iso;
  }
}
