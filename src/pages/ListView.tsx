import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Circle, CheckCircle2, Trash2, X, GripVertical, Calendar, ArrowUpDown, FileText, Folder, MoreHorizontal } from 'lucide-react';
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
import CanvasPinToggle from '@/components/canvas/CanvasPinToggle';
import CoverModeToggle from '@/components/ui/CoverModeToggle';
import ModalPortal from '@/components/ui/ModalPortal';
import NewMatterModal, { type NewMatterContext } from '@/components/matter/NewMatterModal';
import { supabase } from '@/lib/supabase';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import type { EmbeddableViewProps } from '@/lib/canvas';
import { useCoverExpanded } from '@/hooks/useCoverExpanded';
import {
  useContentItem,
  updateContentItem,
  createContentItem,
  useContentInvalidate,
} from '@/hooks/useContentItems';

interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  due?: string | null;       // YYYY-MM-DD or null
  linked_page_id?: string | null;   // child page spawned from this item, if any
  linked_matter_id?: string | null; // sub-matter spawned from this item, if any
}

// The parent matter a list lives in, when it lives in one at all. Lists
// filed directly in a serverspace have no matter to nest under, so the
// "Make sub-matter" action is unavailable there.
interface ParentMatter {
  id: string;
  name: string;
  serverspace_id: string;
}

const NO_MATTER_REASON =
  'This list is not filed inside a matter, so there is nothing to nest a sub-matter under.';

// Repair rather than discard.
//
// This used to drop any entry whose `id` or `text` was not a string. Items
// written by agents, imports, and the MCP tools routinely arrive without an
// `id`, so a list could hold 21 entries and render 16 — the header under-
// counted, and worse, the next save wrote back only the 16 that parsed,
// silently deleting the rest. Now a missing id is synthesised (deterministic,
// so it stays stable across re-syncs and React keys don't churn) and a
// non-string text is coerced. Only an entry that is not an object at all —
// which carries nothing to keep — is skipped.
function readListContent(content: Record<string, unknown> | undefined): ChecklistItem[] {
  const raw = content?.items;
  if (!Array.isArray(raw)) return [];
  const out: ChecklistItem[] = [];
  const seen = new Set<string>();
  raw.forEach((r, idx) => {
    if (!r || typeof r !== 'object') return;
    const o = r as Record<string, unknown>;
    let id = typeof o.id === 'string' && o.id ? o.id : `item-${idx}`;
    // Two entries sharing an id would collide as React keys and as edit
    // targets; keep the first and give the duplicate its own.
    if (seen.has(id)) id = `${id}-${idx}`;
    seen.add(id);
    const text =
      typeof o.text === 'string' ? o.text
      : o.text == null ? ''
      : String(o.text);
    const due = typeof o.due === 'string' ? o.due : null;
    const linked_page_id = typeof o.linked_page_id === 'string' ? o.linked_page_id : null;
    const linked_matter_id = typeof o.linked_matter_id === 'string' ? o.linked_matter_id : null;
    out.push({ id, text, done: !!o.done, due, linked_page_id, linked_matter_id });
  });
  return out;
}

// Check which linked pages and sub-matters still exist and return the items
// with the dead references stripped — or null when nothing needed clearing.
// A failed read is never read as "gone": we only clear on a definite answer,
// so a target hidden by RLS keeps its link rather than losing it.
async function withoutDeadLinks(current: ChecklistItem[]): Promise<ChecklistItem[] | null> {
  const pageIds = [...new Set(current.map((i) => i.linked_page_id).filter((v): v is string => !!v))];
  const matterIds = [...new Set(current.map((i) => i.linked_matter_id).filter((v): v is string => !!v))];
  if (pageIds.length === 0 && matterIds.length === 0) return null;

  const [pagesRes, mattersRes] = await Promise.all([
    pageIds.length
      ? supabase.from('content_items').select('id').in('id', pageIds)
      : Promise.resolve({ data: [] as { id: string }[], error: null }),
    matterIds.length
      ? supabase.from('matterspaces').select('id').in('id', matterIds)
      : Promise.resolve({ data: [] as { id: string }[], error: null }),
  ]);
  if (pagesRes.error || mattersRes.error) return null;

  const livePages = new Set((pagesRes.data ?? []).map((r) => r.id));
  const liveMatters = new Set((mattersRes.data ?? []).map((r) => r.id));

  let changed = false;
  const next = current.map((i) => {
    let out = i;
    if (i.linked_page_id && !livePages.has(i.linked_page_id)) {
      out = { ...out, linked_page_id: null };
      changed = true;
    }
    if (i.linked_matter_id && !liveMatters.has(i.linked_matter_id)) {
      out = { ...out, linked_matter_id: null };
      changed = true;
    }
    return out;
  });
  return changed ? next : null;
}

type SortMode = 'manual' | 'due';

export default function ListView({ id: propId, embedded = false, onClose }: EmbeddableViewProps = {}) {
  const params = useParams();
  const id = propId ?? params.id;
  const navigate = useNavigate();
  const { cardRef, toggleFullscreen } = useDraggableResizable(embedded ? undefined : 'cs.listview.card');
  const [coverExpanded, setCoverExpanded] = useCoverExpanded(id);
  const { data: item, isLoading, error } = useContentItem(id);
  const invalidate = useContentInvalidate();

  const [title, setTitle] = useState('');
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [draftText, setDraftText] = useState('');
  const [saving, setSaving] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('manual');
  const [parentMatter, setParentMatter] = useState<ParentMatter | null>(null);
  const [newMatterContext, setNewMatterContext] = useState<NewMatterContext | null>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);
  const hydrated = useRef(false);
  // Mirror of `items` so async handlers (the dead-link sweep, the
  // sub-matter callback) can read the latest array without stale closures.
  const itemsRef = useRef<ChecklistItem[]>([]);
  // Which item is waiting on the New Sub-Matter modal to come back.
  const pendingSubMatterFor = useRef<string | null>(null);
  // Dead-link sweep runs once per list load.
  const sweptFor = useRef<string | null>(null);
  // JSON of the server's items as we last adopted them. Comparing against it
  // tells a genuinely new server state apart from a refetch that echoes back
  // what we just wrote.
  const adoptedRef = useRef<string | null>(null);
  // `saving` as a ref: the sync effect must read it without re-running when
  // it flips, and a save in flight is the one moment our copy outranks the
  // server's.
  const savingRef = useRef(false);

  useEffect(() => { itemsRef.current = items; }, [items]);

  useEffect(() => { hydrated.current = false; sweptFor.current = null; adoptedRef.current = null; }, [id]);

  // Hydrate on first load, and re-sync afterwards whenever the server copy
  // actually changes. The old guard hydrated exactly once per id, so a list
  // an agent (or another tab, or another card on the canvas) edited while
  // this card was open stayed frozen at its stale contents and count until
  // a full reload.
  useEffect(() => {
    if (!item) return;
    const serverItems = readListContent(item.content);
    const serverJson = JSON.stringify(serverItems);
    if (serverJson === adoptedRef.current) return;
    if (savingRef.current) return;   // our write is in flight — it wins
    adoptedRef.current = serverJson;
    setItems(serverItems);
    itemsRef.current = serverItems;
    if (!hydrated.current) {
      setTitle(item.title);
      if (titleRef.current) titleRef.current.textContent = item.title;
      hydrated.current = true;
      // Links dangle harmlessly when an item is deleted, but a deleted target
      // would leave a marker pointing at nothing. Once per list load, drop the
      // references whose page or sub-matter is definitely gone.
      if (sweptFor.current !== item.id) {
        const listId = item.id;
        sweptFor.current = listId;
        void (async () => {
          const cleaned = await withoutDeadLinks(itemsRef.current);
          if (!cleaned) return;
          setItems(cleaned);
          itemsRef.current = cleaned;
          // Adopt the cleaned shape, or the resync effect would treat the
          // server's echo of this very write as fresh remote state.
          adoptedRef.current = JSON.stringify(cleaned);
          try {
            await updateContentItem(listId, { content: { items: cleaned } });
          } catch (e) {
            console.error('clearing dead item links failed', e);
          }
        })();
      }
      // Empty list on first load → focus the bottom input so the user can
      // start typing or press Enter to spawn a first empty bullet.
      if (serverItems.length === 0) {
        setTimeout(() => draftInputRef.current?.focus(), 0);
      }
    }
  }, [item]);

  // A list filed in a matterspace can spawn sub-matters; one filed straight
  // into a serverspace cannot. Load the parent matter (for its serverspace
  // and name) so the New Sub-Matter modal gets the right context.
  const spaceId = item?.space_id;
  const spaceType = item?.space_type;
  useEffect(() => {
    if (!spaceId || spaceType !== 'matterspace') { setParentMatter(null); return; }
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('matterspaces')
        .select('id, name, serverspace_id')
        .eq('id', spaceId)
        .maybeSingle();
      if (!cancelled) setParentMatter((data as ParentMatter | null) ?? null);
    })();
    return () => { cancelled = true; };
  }, [spaceId, spaceType]);

  const persistItems = async (next: ChecklistItem[]) => {
    if (!id) return;
    setSaving(true);
    savingRef.current = true;
    try {
      await updateContentItem(id, { content: { items: next } });
      adoptedRef.current = JSON.stringify(next);
      invalidate.invalidateItem(id);
    } catch (e) {
      console.error('save failed', e);
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };

  const persistTitle = async (next: string) => {
    if (!id) return;
    setSaving(true);
    savingRef.current = true;
    try {
      await updateContentItem(id, { title: next || 'Untitled List' });
      invalidate.invalidateItem(id);
    } catch (e) {
      console.error('title save failed', e);
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };

  const handleTitleBlur = () => {
    const next = (titleRef.current?.textContent ?? '').trim();
    if (next === title) return;
    setTitle(next);
    persistTitle(next);
  };

  // Returns the new item's id so callers (the bottom-input Enter handler)
  // can move focus to the freshly created bullet when the draft was empty.
  const addItem = (): string => {
    const text = draftText.trim();
    const newId = crypto.randomUUID();
    const newItem: ChecklistItem = { id: newId, text, done: false, due: null, linked_page_id: null, linked_matter_id: null };
    const next = [...items, newItem];
    setItems(next);
    setDraftText('');
    persistItems(next);
    return newId;
  };

  // Enter on an inline item input: save the current text and insert a fresh
  // item right below. Returns the new item's id so the caller can focus it.
  const insertItemAfter = (afterItemId: string, currentText: string): string => {
    const newId = crypto.randomUUID();
    const newItem: ChecklistItem = { id: newId, text: '', done: false, due: null, linked_page_id: null, linked_matter_id: null };
    const next: ChecklistItem[] = [];
    for (const i of items) {
      next.push(i.id === afterItemId ? { ...i, text: currentText } : i);
      if (i.id === afterItemId) next.push(newItem);
    }
    setItems(next);
    persistItems(next);
    return newId;
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

  // Expand a list item into a full page. If the item already has a linked
  // page, just navigate; otherwise create a new content_item of type 'page'
  // in the same space, store its id back on the item, and navigate.
  const expandItem = async (itemId: string) => {
    if (!item) return;
    const target = items.find((i) => i.id === itemId);
    if (!target) return;

    if (target.linked_page_id) {
      navigate(`/app/page/${target.linked_page_id}`);
      return;
    }

    setSaving(true);
    try {
      const page = await createContentItem({
        space: { spaceId: item.space_id, spaceType: item.space_type },
        contentType: 'page',
        title: target.text.trim() || 'Untitled Page',
      });
      const next = items.map((i) =>
        i.id === itemId ? { ...i, linked_page_id: page.id } : i,
      );
      setItems(next);
      await updateContentItem(item.id, { content: { items: next } });
      invalidate.invalidateItem(item.id);
      invalidate.invalidateList(
        { spaceId: item.space_id, spaceType: item.space_type },
        'page',
      );
      navigate(`/app/page/${page.id}`);
    } catch (e) {
      console.error('expand failed', e);
    } finally {
      setSaving(false);
    }
  };

  // Break a list item out into a sub-matter of the matter this list sits in.
  // If the item already has one, just open it. Otherwise hand off to the
  // shared New Sub-Matter modal — the single creation path for matterspaces,
  // so RLS and serverspace inheritance stay correct and the user still gets
  // to review the name and short code before anything is written.
  const makeSubMatter = (itemId: string) => {
    const target = itemsRef.current.find((i) => i.id === itemId);
    if (!target) return;

    if (target.linked_matter_id) {
      navigate(`/app/matterspace/${target.linked_matter_id}`);
      return;
    }
    if (!parentMatter) return;

    pendingSubMatterFor.current = itemId;
    setNewMatterContext({
      serverspaceId: parentMatter.serverspace_id,
      parentMatterId: parentMatter.id,
      contextLabel: parentMatter.name,
    });
  };

  // The modal created the sub-matter; seed it with a list of the same name
  // (a home for the sub-items), record it on the item, then open it.
  const handleSubMatterCreated = async (matterId: string) => {
    const itemId = pendingSubMatterFor.current;
    pendingSubMatterFor.current = null;
    if (!itemId || !item) return;
    const target = itemsRef.current.find((i) => i.id === itemId);

    setSaving(true);
    try {
      await createContentItem({
        space: { spaceId: matterId, spaceType: 'matterspace' },
        contentType: 'list',
        title: target?.text.trim() || 'Untitled List',
        content: { items: [] },
      });
      const next = itemsRef.current.map((i) =>
        i.id === itemId ? { ...i, linked_matter_id: matterId } : i,
      );
      setItems(next);
      itemsRef.current = next;
      await updateContentItem(item.id, { content: { items: next } });
      invalidate.invalidateItem(item.id);
    } catch (e) {
      console.error('sub-matter setup failed', e);
    } finally {
      setSaving(false);
    }
    navigate(`/app/matterspace/${matterId}?tab=Lists`);
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

  const body = (
    <>
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
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); } }}
              title="Click to rename this list"
              className="text-2xl font-bold text-[#f5f2ed] outline-none mb-1 rounded px-1 -mx-1 hover:bg-[rgba(255,255,255,0.04)] focus:bg-[rgba(255,255,255,0.06)] transition-colors empty:before:content-['Untitled_List'] empty:before:text-white/45"
            />
            <div className="flex items-center justify-between mb-4">
              <p className="text-[12px] text-white/55">
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
                      onEnter={(currentText) => insertItemAfter(it.id, currentText)}
                      onExpand={() => expandItem(it.id)}
                      onSubMatter={() => makeSubMatter(it.id)}
                      subMatterDisabledReason={parentMatter ? null : NO_MATTER_REASON}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            <div className="flex items-center gap-2 mt-3 px-3 py-2 rounded-lg border border-dashed border-[rgba(255,255,255,0.1)]">
              <Plus size={14} className="text-white/40 shrink-0" />
              <input
                ref={draftInputRef}
                type="text"
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const wasEmpty = !draftText.trim();
                  const newId = addItem();
                  if (wasEmpty) {
                    // Empty Enter → focus the freshly created bullet so the
                    // user can keep chaining Enter to spawn more.
                    requestAnimationFrame(() => {
                      const el = document.querySelector<HTMLInputElement>(`[data-item-id="${newId}"]`);
                      el?.focus();
                    });
                  }
                }}
                placeholder="Press Enter to add a bullet"
                className="flex-1 bg-transparent outline-none text-[14px] text-[#f5f2ed] placeholder-white/55"
              />
            </div>
          </>
        )}
    </>
  );

  // Inside a canvas panel the panel supplies the frame, the ribbon and the
  // controls; the view contributes only its contents.
  if (embedded) {
    return <div className="px-4 py-3">{body}</div>;
  }

  return (
    <div>
      <CoverImage
        coverUrl={item?.cover_url ?? null}
        onCoverChange={handleCoverChange}
        editable={true}
        expanded={coverExpanded}
        onExpandChange={setCoverExpanded}
        persistKey={id ? `cs.cover.${id}` : undefined}
      />

      <div ref={cardRef} className="max-w-4xl mx-auto px-8 py-8 rounded-xl backdrop-blur-[30px] border border-[rgba(255,255,255,0.06)] my-8 cursor-grab select-none" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
        {/* Close + drag handle + pin to canvas + fullscreen */}
        <div className="flex items-center justify-between mb-4 -mt-1">
          <button
            onClick={() => (onClose ? onClose() : navigate(-1))}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
            title="Back"
          >
            <X size={14} strokeWidth={2} />
          </button>
          <div className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors" title="Drag to move" />
          <div className="flex items-center gap-1">
            <CoverModeToggle hasCover={!!item?.cover_url} expanded={coverExpanded} onToggle={() => setCoverExpanded(!coverExpanded)} />
            <CanvasPinToggle kind="list" id={id} title={title || item?.title || 'Untitled List'} />
            <FullscreenToggle onToggle={toggleFullscreen} />
          </div>
        </div>

        {body}
      </div>

      {newMatterContext && (
        <NewMatterModal
          context={newMatterContext}
          onClose={() => { pendingSubMatterFor.current = null; setNewMatterContext(null); }}
          onCreated={(matterId) => { void handleSubMatterCreated(matterId); }}
          initialName={
            itemsRef.current.find((i) => i.id === pendingSubMatterFor.current)?.text.trim() || ''
          }
        />
      )}
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
  onEnter: (currentText: string) => string;
  onExpand: () => void;
  onSubMatter: () => void;
  // Null when the action is available; otherwise the plain-English reason
  // it isn't, shown under the greyed-out menu entry.
  subMatterDisabledReason: string | null;
}

function SortableItem({ item, today, sortable, onToggle, onChangeText, onChangeDue, onDelete, onEnter, onExpand, onSubMatter, subMatterDisabledReason }: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: !sortable });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Draft local text so each keystroke doesn't trigger a save round-trip.
  // Synced from the server copy by adjusting state during render rather than
  // in an effect — the effect version double-rendered every remote change and
  // the react-hooks lint now rejects it (you-might-not-need-an-effect).
  const [text, setText] = useState(item.text);
  const [prevServerText, setPrevServerText] = useState(item.text);
  if (item.text !== prevServerText) {
    setPrevServerText(item.text);
    setText(item.text);
  }

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
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const newId = onEnter(text);
            // Focus the freshly inserted item's input on the next paint.
            requestAnimationFrame(() => {
              const el = document.querySelector<HTMLInputElement>(`[data-item-id="${newId}"]`);
              el?.focus();
            });
          }
        }}
        data-item-id={item.id}
        className={`flex-1 bg-transparent outline-none text-[14px] ${item.done ? 'line-through text-white/40' : 'text-[#f5f2ed]'}`}
      />
      <DueDateField
        value={item.due ?? ''}
        onChange={onChangeDue}
        overdue={!!overdue}
        todayDue={!!todayDue}
        muted={item.done}
      />
      {/* Standing markers: an item that has a page or a sub-matter says so
          without being hovered, and the marker itself opens the target. */}
      {item.linked_page_id && (
        <button
          onClick={onExpand}
          className="p-1 rounded shrink-0 text-[#e8b84a] hover:bg-[rgba(232,184,74,0.1)] transition-colors"
          title="Open page"
        >
          <FileText size={13} />
        </button>
      )}
      {item.linked_matter_id && (
        <button
          onClick={onSubMatter}
          className="p-1 rounded shrink-0 text-[#e8b84a] hover:bg-[rgba(232,184,74,0.1)] transition-colors"
          title="Open sub-matter"
        >
          <Folder size={13} />
        </button>
      )}
      <ItemActionsMenu
        item={item}
        onExpand={onExpand}
        onSubMatter={onSubMatter}
        subMatterDisabledReason={subMatterDisabledReason}
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


interface ItemActionsMenuProps {
  item: ChecklistItem;
  onExpand: () => void;
  onSubMatter: () => void;
  subMatterDisabledReason: string | null;
}

// The quiet per-item menu. It stays out of the way until the row is hovered,
// and it is portalled to <body> with fixed coordinates so a resized (and
// therefore scrolling) list card can't clip it.
function ItemActionsMenu({ item, onExpand, onSubMatter, subMatterDisabledReason }: ItemActionsMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  const open = () => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const MENU_HEIGHT = subMatterDisabledReason ? 132 : 84;
    const below = r.bottom + 6;
    const top = below + MENU_HEIGHT > window.innerHeight ? Math.max(8, r.top - 6 - MENU_HEIGHT) : below;
    setAnchor({ top, right: Math.max(8, window.innerWidth - r.right) });
  };

  useEffect(() => {
    if (!anchor) return;
    // A pointerdown on the trigger itself is left alone so the button can
    // toggle the menu shut on the following click instead of reopening it.
    const close = (e?: Event) => {
      const t = e?.target;
      if (t instanceof Node && buttonRef.current?.contains(t)) return;
      setAnchor(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAnchor(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor]);

  const entry = 'w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors';

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => (anchor ? setAnchor(null) : open())}
        className={`p-1 rounded transition-all shrink-0 text-white/40 hover:text-white hover:bg-[rgba(255,255,255,0.06)] ${
          anchor ? 'opacity-100 text-white' : 'opacity-0 group-hover:opacity-100'
        }`}
        title="More"
      >
        <MoreHorizontal size={13} />
      </button>

      {anchor && (
        <ModalPortal>
          <div
            style={{ top: anchor.top, right: anchor.right }}
            onPointerDown={(e) => e.stopPropagation()}
            className="fixed z-[70] min-w-[210px] rounded-lg border border-[rgba(255,255,255,0.12)] bg-[#12121a] py-1 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
          >
            <button
              onClick={() => { setAnchor(null); onExpand(); }}
              className={`${entry} text-white/80 hover:bg-[rgba(255,255,255,0.06)] hover:text-white`}
            >
              <FileText size={12} className="shrink-0 text-white/45" />
              {item.linked_page_id ? 'Open page' : 'Open as page'}
            </button>

            {item.linked_matter_id || !subMatterDisabledReason ? (
              <button
                onClick={() => { setAnchor(null); onSubMatter(); }}
                className={`${entry} text-white/80 hover:bg-[rgba(255,255,255,0.06)] hover:text-white`}
              >
                <Folder size={12} className="shrink-0 text-white/45" />
                {item.linked_matter_id ? 'Open sub-matter' : 'Make sub-matter'}
              </button>
            ) : (
              <>
                <div className={`${entry} text-white/30 cursor-not-allowed`} aria-disabled="true">
                  <Folder size={12} className="shrink-0 text-white/20" />
                  Make sub-matter
                </div>
                <p className="px-3 pb-1.5 text-[10px] leading-snug text-white/35">
                  {subMatterDisabledReason}
                </p>
              </>
            )}
          </div>
        </ModalPortal>
      )}
    </>
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
  const inputRef = useRef<HTMLInputElement>(null);
  const colorClass = muted
    ? 'text-white/30'
    : overdue
      ? 'text-red-300'
      : todayDue
        ? 'text-[#e8b84a]'
        : value
          ? 'text-white/70'
          : 'text-white/30 hover:text-white/60';

  // Modern browsers won't open a date picker from a label wrapping an
  // input styled to zero size — call showPicker() explicitly off a ref.
  const openPicker = () => {
    const el = inputRef.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') {
      try { el.showPicker(); return; } catch { /* fall through */ }
    }
    el.focus();
    el.click();
  };

  return (
    <span className={`relative inline-flex items-center gap-1 text-[11px] shrink-0 px-2 py-1 rounded hover:bg-[rgba(255,255,255,0.04)] transition-colors ${colorClass}`}>
      <button
        type="button"
        onClick={openPicker}
        className="flex items-center gap-1 cursor-pointer"
        title="Due date"
      >
        <Calendar size={11} />
        {value
          ? <span>{formatShortDate(value)}</span>
          : <span className="hidden group-hover:inline">Due</span>}
      </button>
      {value && !muted && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="text-white/30 hover:text-red-300 transition-colors"
          title="Clear due date"
        >
          <X size={10} />
        </button>
      )}
      <input
        ref={inputRef}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 pointer-events-none"
        tabIndex={-1}
        aria-hidden="true"
      />
    </span>
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
