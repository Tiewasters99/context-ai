import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Circle, CheckCircle2, Trash2, X, GripVertical, Calendar, CalendarDays, ChevronLeft, ChevronRight, ChevronDown, ArrowUpDown, FileText, Folder, MoreHorizontal, CornerDownRight } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import CanvasPinToggle from '@/components/canvas/CanvasPinToggle';
import PinToggle from '@/components/ui/PinToggle';
import DelegateButton from '@/components/agents/DelegateButton';
import CoverModeToggle from '@/components/ui/CoverModeToggle';
import ModalPortal from '@/components/ui/ModalPortal';
import NewMatterModal, { type NewMatterContext } from '@/components/matter/NewMatterModal';
import { supabase } from '@/lib/supabase';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import CalendarOverlay from '@/components/calendar/CalendarOverlay';
import type { EmbeddableViewProps } from '@/lib/canvas';
import { useCoverExpanded } from '@/hooks/useCoverExpanded';
import {
  useContentItem,
  useContentItems,
  updateContentItem,
  createContentItem,
  useContentInvalidate,
} from '@/hooks/useContentItems';
import { useAuth } from '@/contexts/AuthContext';
import { useAutosave } from '@/hooks/useUnsavedGuard';
import { saveStatusLine } from '@/lib/draft-store';
import {
  buildTree,
  normalizeOutline,
  insertSiblingAfter,
  appendChild,
  removeItem as removeOutlineItem,
  moveItem as moveOutlineItem,
  indentItem,
  outdentItem,
  ancestorIds,
  subtreeIds,
  type TreeNode,
} from '@/lib/list-tree';

/** What is saved for a list: its name and its items, written together. */
interface ListDraft {
  title: string;
  items: ChecklistItem[];
}

interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  due?: string | null;       // YYYY-MM-DD or null
  // The point this one sits under, or null at the top level. Subpoints nest
  // without limit; the array stays flat and in pre-order (see lib/list-tree).
  parent_id?: string | null;
  // The pages spawned from this item, in the order they were made. A point
  // may carry any number of them. `linked_page_id` is the legacy single slot:
  // read as the first page, and written back as the first page so older
  // readers (the MCP tools' has_page) stay right.
  linked_page_ids: string[];
  linked_page_id?: string | null;
  linked_matter_id?: string | null; // sub-matter spawned from this item, if any
  // One line under the item, written by an agent working the list from a
  // terminal (the MCP update_list_item tool): a question when the item was
  // unclear, or where the result is. Carried through every save here so it
  // survives the next keystroke; cleared with the x beside it.
  note?: string | null;
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
    // Pages: the array, with the legacy single slot folded in (first, since
    // it was the first page), de-duplicated.
    const pageIds: string[] = [];
    if (typeof o.linked_page_id === 'string' && o.linked_page_id) pageIds.push(o.linked_page_id);
    if (Array.isArray(o.linked_page_ids)) {
      for (const p of o.linked_page_ids) if (typeof p === 'string' && p && !pageIds.includes(p)) pageIds.push(p);
    }
    const linked_matter_id = typeof o.linked_matter_id === 'string' ? o.linked_matter_id : null;
    const parent_id = typeof o.parent_id === 'string' && o.parent_id ? o.parent_id : null;
    const note = typeof o.note === 'string' && o.note ? o.note : null;
    out.push({
      id, text, done: !!o.done, due, parent_id,
      linked_page_ids: pageIds,
      linked_page_id: pageIds[0] ?? null,
      linked_matter_id,
      ...(note ? { note } : {}),
    });
  });
  // An unknown or circular parent_id becomes a top-level item, and the
  // array is put back in pre-order — repaired, never dropped.
  return normalizeOutline(out);
}

/** A fresh, empty item. */
function blankItem(text = ''): ChecklistItem {
  return {
    id: crypto.randomUUID(),
    text,
    done: false,
    due: null,
    parent_id: null,
    linked_page_ids: [],
    linked_page_id: null,
    linked_matter_id: null,
  };
}

/** Set an item's pages, keeping the legacy slot in step. */
function withPages(i: ChecklistItem, pageIds: string[]): ChecklistItem {
  return { ...i, linked_page_ids: pageIds, linked_page_id: pageIds[0] ?? null };
}

// Check which linked pages and sub-matters still exist and return the items
// with the dead references stripped — or null when nothing needed clearing.
// A failed read is never read as "gone": we only clear on a definite answer,
// so a target hidden by RLS keeps its link rather than losing it.
async function withoutDeadLinks(current: ChecklistItem[]): Promise<ChecklistItem[] | null> {
  const pageIds = [...new Set(current.flatMap((i) => i.linked_page_ids))];
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
    const livePageIds = i.linked_page_ids.filter((p) => livePages.has(p));
    if (livePageIds.length !== i.linked_page_ids.length) {
      out = withPages(out, livePageIds);
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

// The folded branches of a list, remembered on this computer.
const collapsedKey = (listId: string | undefined) => `cs.list.collapsed.${listId ?? 'none'}`;
function readCollapsed(listId: string | undefined): Set<string> {
  try {
    const raw = localStorage.getItem(collapsedKey(listId));
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}
function writeCollapsed(listId: string | undefined, keys: Set<string>) {
  try {
    if (keys.size === 0) localStorage.removeItem(collapsedKey(listId));
    else localStorage.setItem(collapsedKey(listId), JSON.stringify([...keys]));
  } catch { /* private window, blocked storage: the fold just isn't remembered */ }
}

export default function ListView({ id: propId, embedded = false, onClose }: EmbeddableViewProps = {}) {
  const params = useParams();
  const id = propId ?? params.id;
  const navigate = useNavigate();
  // Geometry is remembered per list, not per view type — one list left small
  // in a corner must not drag every other list into that same corner.
  const { cardRef, toggleFullscreen, pinned, togglePin, isMobile } = useDraggableResizable(
    embedded || !id ? undefined : `cs.listview.card.${id}`,
    { boundToViewport: true },
  );
  const [coverExpanded, setCoverExpanded] = useCoverExpanded(id);
  const { data: item, isLoading, error } = useContentItem(id);
  // The pages of this space, for the row nested under an item that was
  // turned into one: the page's CURRENT title (it may have been renamed
  // since), not the item text it was born with.
  const { data: spacePages } = useContentItems(
    item ? { spaceId: item.space_id, spaceType: item.space_type } : null,
    'page',
  );
  const pageTitles = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of spacePages ?? []) m.set(p.id, p.title);
    return m;
  }, [spacePages]);
  const invalidate = useContentInvalidate();

  const [title, setTitle] = useState('');
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [draftText, setDraftText] = useState('');
  const [saving, setSaving] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('manual');
  const [showCalendar, setShowCalendar] = useState(false);
  // /app/list/:id?item=<itemId> — the calendar links back into a list this
  // way, so the item that was clicked on the calendar is findable here.
  const [searchParams] = useSearchParams();
  const focusItemId = searchParams.get('item');
  const [flashItemId, setFlashItemId] = useState<string | null>(null);
  const [parentMatter, setParentMatter] = useState<ParentMatter | null>(null);
  const [newMatterContext, setNewMatterContext] = useState<NewMatterContext | null>(null);
  // Which branches are folded shut: `${itemId}:sub` for a point's subpoints,
  // `${itemId}:pages` for its pages — the two fold independently. Open is the
  // default (nothing hides work), and the folds are remembered per list on
  // this computer, not in the list itself, so folding never writes a save.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(id));
  useEffect(() => { setCollapsed(readCollapsed(id)); }, [id]);
  const isExpanded = (key: string) => !collapsed.has(key);
  const setExpanded = (key: string, open: boolean) => {
    setCollapsed((prev) => {
      if (open ? !prev.has(key) : prev.has(key)) return prev;
      const next = new Set(prev);
      if (open) next.delete(key); else next.add(key);
      writeCollapsed(id, next);
      return next;
    });
  };
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

  // ONE writer for this list, serialized: a debounced write from typing and
  // an immediate one from a checkbox can no longer overlap, and a failure
  // keeps the list dirty and retries instead of vanishing into console.error.
  const { user } = useAuth();
  const listDraftRef = useRef<ListDraft>({ title: '', items: [] });
  const saver = useAutosave<ListDraft>({
    userId: user?.id,
    itemId: id,
    // See the note on `mirror` in useUnsavedGuard: a list item is a line, not
    // a manuscript, and every structural edit here already lands at once.
    mirror: false,
    save: async (value) => {
      if (!id) return;
      savingRef.current = true;
      try {
        await updateContentItem(id, {
          title: value.title || 'Untitled List',
          content: { items: value.items },
        });
        adoptedRef.current = JSON.stringify(value.items);
        invalidate.invalidateItem(id);
      } finally {
        savingRef.current = false;
      }
    },
  });
  const { change: changeDraft, adopt: adoptDraft, flush: flushDraft } = saver;
  const dirtyRef = useRef(false);
  dirtyRef.current = saver.status.dirty;

  /** A deliberate edit — write it now. */
  const commitNow = (patch: Partial<ListDraft>): Promise<boolean> => {
    listDraftRef.current = { ...listDraftRef.current, ...patch };
    changeDraft(listDraftRef.current);
    return flushDraft();
  };
  /** Typing — write it when the typing stops. */
  const commitSoon = (patch: Partial<ListDraft>) => {
    listDraftRef.current = { ...listDraftRef.current, ...patch };
    changeDraft(listDraftRef.current);
  };


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
    // Our write is in flight, or typed text is waiting to go: either way
    // this copy outranks the server's echo.
    if (savingRef.current || dirtyRef.current) return;
    adoptedRef.current = serverJson;
    setItems(serverItems);
    itemsRef.current = serverItems;
    // This IS the server's copy: the saver's baseline, not a change.
    listDraftRef.current = { title: item.title, items: serverItems };
    adoptDraft(listDraftRef.current);
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
  }, [item, adoptDraft]);

  // Scroll the linked item into view and flash it, once the list is up. A
  // subpoint under a folded branch is unfolded first, or there would be
  // nothing to scroll to.
  const flashedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusItemId || items.length === 0 || flashedFor.current === focusItemId) return;
    const folded = ancestorIds(items, focusItemId).map((a) => `${a}:sub`).filter((k) => collapsed.has(k));
    if (folded.length) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        folded.forEach((k) => next.delete(k));
        writeCollapsed(id, next);
        return next;
      });
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-item-id="${focusItemId}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    flashedFor.current = focusItemId;
    setFlashItemId(focusItemId);
    const t = setTimeout(() => setFlashItemId(null), 4000);
    return () => clearTimeout(t);
    // `items` is read for the ancestors only; re-running on every keystroke
    // would re-flash the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusItemId, items.length, collapsed, id]);

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

  const persistItems = (next: ChecklistItem[]) => commitNow({ items: next });

  const persistTitle = (next: string) => commitNow({ title: next });

  const handleTitleBlur = () => {
    const next = (titleRef.current?.textContent ?? '').trim();
    if (next === title) return;
    setTitle(next);
    void persistTitle(next);
  };

  const handleTitleInput = () => {
    commitSoon({ title: (titleRef.current?.textContent ?? '').trim() });
  };

  // Every structural edit goes through here: the new array is adopted into
  // state and the ref at once (so a second edit in the same tick builds on
  // it), then written.
  const applyItems = (next: ChecklistItem[]) => {
    setItems(next);
    itemsRef.current = next;
    persistItems(next);
  };

  // Returns the new item's id so callers (the bottom-input Enter handler)
  // can move focus to the freshly created bullet when the draft was empty.
  const addItem = (): string => {
    const newItem = blankItem(draftText.trim());
    applyItems([...itemsRef.current, newItem]);
    setDraftText('');
    return newItem.id;
  };

  // Enter on an inline item input: save the current text and insert a fresh
  // sibling right below — below the item's subpoints too, at the same level.
  // Returns the new item's id so the caller can focus it.
  const insertItemAfter = (afterItemId: string, currentText: string): string => {
    const newItem = blankItem();
    const withText = itemsRef.current.map((i) => (i.id === afterItemId ? { ...i, text: currentText } : i));
    applyItems(insertSiblingAfter(withText, afterItemId, newItem));
    return newItem.id;
  };

  // "+ Add subpoint": a fresh point one level under this one, at the end of
  // its subpoints. The branch is opened so the new point is seen and focused.
  const addSubpoint = (parentId: string): string => {
    const newItem = blankItem();
    applyItems(appendChild(itemsRef.current, parentId, newItem));
    setExpanded(`${parentId}:sub`, true);
    requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>(`[data-item-id="${newItem.id}"]`)?.focus();
    });
    return newItem.id;
  };

  // Tab / Shift+Tab on an item: one level in (under the point above it) or
  // one level out. Focus stays on the item — it is the same input, re-keyed
  // by id, so the browser keeps it.
  const indent = (itemId: string): boolean => {
    const next = indentItem(itemsRef.current, itemId);
    if (next === itemsRef.current) return false;
    const parent = next.find((i) => i.id === itemId)?.parent_id;
    if (parent) setExpanded(`${parent}:sub`, true);
    applyItems(next);
    return true;
  };
  const outdent = (itemId: string): boolean => {
    const next = outdentItem(itemsRef.current, itemId);
    if (next === itemsRef.current) return false;
    applyItems(next);
    return true;
  };

  const updateItem = (itemId: string, patch: Partial<ChecklistItem>) => {
    applyItems(itemsRef.current.map((i) => i.id === itemId ? { ...i, ...patch } : i));
  };

  // Delete one point. Its subpoints step up to take its place rather than
  // vanishing with it: removing a heading is not removing the work under it.
  const deleteItem = (itemId: string) => {
    applyItems(removeOutlineItem(itemsRef.current, itemId));
  };

  // "Add page": a NEW page under this point, every time — a point may carry
  // as many pages as it needs. The page is a content_item of type 'page' in
  // the same space, titled after the point (its title is edited on the page
  // itself), its id appended to the point's pages; then it opens.
  const addPage = async (itemId: string) => {
    if (!item) return;
    const target = itemsRef.current.find((i) => i.id === itemId);
    if (!target) return;

    setSaving(true);
    try {
      const page = await createContentItem({
        space: { spaceId: item.space_id, spaceType: item.space_type },
        contentType: 'page',
        title: target.text.trim() || 'Untitled Page',
      });
      const next = itemsRef.current.map((i) =>
        i.id === itemId ? withPages(i, [...i.linked_page_ids, page.id]) : i,
      );
      setItems(next);
      itemsRef.current = next;
      setExpanded(`${itemId}:pages`, true);
      await persistItems(next);
      invalidate.invalidateList(
        { spaceId: item.space_id, spaceType: item.space_type },
        'page',
      );
      navigate(`/app/page/${page.id}`);
    } catch (e) {
      console.error('add page failed', e);
    } finally {
      setSaving(false);
    }
  };

  const openPage = (pageId: string) => navigate(`/app/page/${pageId}`);

  // Take a page off this point. The page itself stays in the matter's Pages
  // tab — only the link under the bullet goes.
  const unlinkPage = (itemId: string, pageId: string) => {
    applyItems(itemsRef.current.map((i) =>
      i.id === itemId ? withPages(i, i.linked_page_ids.filter((p) => p !== pageId)) : i,
    ));
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
      await persistItems(next);
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

  // While a point is dragged its subpoints are hidden: they ride along in
  // the data, and on screen they would otherwise sit inside the dragged
  // block and be the nearest drop target — a drop onto its own subtree,
  // which is refused, so the drag would do nothing.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const handleDragStart = (event: DragStartEvent) => setDraggingId(String(event.active.id));
  const handleDragCancel = () => setDraggingId(null);
  // Belt and braces: the dragged point's own descendants are never candidates.
  const collisionDetection: CollisionDetection = (args) => {
    const activeId = String(args.active.id);
    const own = subtreeIds(itemsRef.current, activeId);
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (c) => String(c.id) === activeId || !own.has(String(c.id)),
      ),
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    // The dragged point takes the target's slot — its level and its place
    // among its siblings — and brings its subpoints along.
    const next = moveOutlineItem(itemsRef.current, String(active.id), String(over.id));
    if (next === itemsRef.current) return;
    applyItems(next);
  };

  const today = new Date().toISOString().slice(0, 10);

  // What is drawn. Manual order is the outline itself; sorting by due date
  // flattens it — every point at one level, dated ones first — because a
  // date order and a nesting order cannot both hold at once.
  const tree = useMemo<TreeNode<ChecklistItem>[]>(() => {
    if (sortMode === 'manual') return buildTree(items);
    const sorted = [...items].sort((a, b) => {
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due) return -1;
      if (b.due) return 1;
      return 0;
    });
    return sorted.map((it) => ({ item: it, depth: 0, children: [] }));
  }, [items, sortMode]);

  const outline: OutlineActions = {
    today,
    flashItemId,
    draggingId,
    // No hover on a phone: the row's controls stay visible there.
    alwaysShowControls: isMobile,
    sortable: sortMode === 'manual',
    nested: sortMode === 'manual',
    pageTitles,
    subMatterDisabledReason: parentMatter ? null : NO_MATTER_REASON,
    isExpanded,
    toggleExpanded: (key) => setExpanded(key, !isExpanded(key)),
    toggle: (id) => { const it = itemsRef.current.find((i) => i.id === id); if (it) updateItem(id, { done: !it.done }); },
    changeText: (id, text) => updateItem(id, { text }),
    typeText: (id, text) => {
      const next = itemsRef.current.map((i) => (i.id === id ? { ...i, text } : i));
      setItems(next);
      itemsRef.current = next;
      commitSoon({ items: next });
    },
    changeDue: (id, due) => updateItem(id, { due: due || null }),
    clearNote: (id) => updateItem(id, { note: null }),
    remove: deleteItem,
    enter: insertItemAfter,
    indent,
    outdent,
    addSubpoint,
    addPage: (id) => { void addPage(id); },
    openPage,
    unlinkPage,
    subMatter: makeSubMatter,
  };

  const doneCount = items.filter((i) => i.done).length;
  const progress = items.length === 0 ? 0 : Math.round((doneCount / items.length) * 100);

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
              onInput={handleTitleInput}
              onBlur={handleTitleBlur}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); } }}
              title="Click to rename this list"
              className="text-2xl font-bold text-[#f5f2ed] outline-none mb-1 rounded px-1 -mx-1 hover:bg-[rgba(255,255,255,0.04)] focus:bg-[rgba(255,255,255,0.06)] transition-colors empty:before:content-['Untitled_List'] empty:before:text-white/45"
            />
            <div className="flex items-center justify-between mb-4">
              <p className="text-[12px] text-white/55">
                {saving
                  ? 'Saving…'
                  : saveStatusLine(saver.status)
                    ?? `${doneCount} of ${items.length} complete · ${progress}%`}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowCalendar(true)}
                  className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-white/50 hover:text-white hover:bg-[rgba(255,255,255,0.04)] transition-colors"
                  title="See these due dates on the calendar"
                >
                  <CalendarDays size={11} />
                  Calendar
                </button>
                <button
                  onClick={() => setSortMode((m) => m === 'manual' ? 'due' : 'manual')}
                  className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-white/50 hover:text-white hover:bg-[rgba(255,255,255,0.04)] transition-colors"
                  title={sortMode === 'manual' ? 'Sort by due date' : 'Manual order'}
                >
                  <ArrowUpDown size={11} />
                  {sortMode === 'manual' ? 'Manual' : 'By due date'}
                </button>
              </div>
            </div>

            <div className="h-2 bg-[#1c1c26] rounded-full overflow-hidden mb-6">
              <div
                className="h-full bg-[#4ade80] rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>

            <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={handleDragStart} onDragCancel={handleDragCancel} onDragEnd={handleDragEnd}>
              {/* One sortable context over the whole outline, in pre-order:
                  rows at every depth stack vertically in exactly that order,
                  so dnd-kit's vertical strategy measures them as one column. */}
              <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
                <OutlineLevel nodes={tree} outline={outline} />
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
        inherit
        matterId={item?.space_type === 'matterspace' ? item.space_id : null}
      />

      <div ref={cardRef} className="max-w-4xl mx-auto px-8 pt-0 pb-8 rounded-xl backdrop-blur-[30px] border border-[rgba(255,255,255,0.06)] my-8 cursor-grab select-none" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
        {/* Close + drag handle + pin to canvas + fullscreen */}
        {/* A ribbon, not a floating row: the card scrolls its own content
            now, so these controls stay pinned to the top of the frame
            instead of scrolling out of reach on a long list. */}
        <div className="md:sticky md:top-0 z-20 flex items-center justify-between -mx-8 px-8 pt-6 pb-3 mb-4 rounded-t-xl border-b border-[rgba(255,255,255,0.08)] bg-[rgba(10,10,18,0.95)] backdrop-blur-[30px]">
          <button
            onClick={() => (onClose ? onClose() : navigate(-1))}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
            title="Back"
          >
            <X size={14} strokeWidth={2} />
          </button>
          <div className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors" title="Drag to move" />
          <div className="flex items-center gap-1">
            <DelegateButton
              variant="ribbon"
              matterId={item?.space_type === 'matterspace' ? item.space_id : null}
              attachment={item ? { kind: 'content_item', id: item.id, label: title || item.title || 'Untitled List' } : null}
              defaultTitle={title || item?.title || 'Untitled List'}
            />
            <CoverModeToggle hasCover={!!item?.cover_url} expanded={coverExpanded} onToggle={() => setCoverExpanded(!coverExpanded)} />
            {/* Fix in place. See the note in PageView. */}
            {!embedded && !isMobile && <PinToggle pinned={pinned} onToggle={togglePin} />}
            <CanvasPinToggle kind="list" id={id} title={title || item?.title || 'Untitled List'} />
            <FullscreenToggle onToggle={toggleFullscreen} />
          </div>
        </div>

        {body}
      </div>

      {showCalendar && (
        <CalendarOverlay
          title="Calendar"
          subtitle={`Due dates from "${title || 'this list'}" are highlighted. Everything else you can see is here too.`}
          highlightListId={id}
          storageKey="cs.calendar.overlay"
          onClose={() => setShowCalendar(false)}
        />
      )}

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


// Everything a row needs, by item id. One object for the whole outline
// instead of a closure per row: the rows recurse, and a branch twelve deep
// still reads the same handlers.
interface OutlineActions {
  today: string;
  flashItemId: string | null;
  /** The point being dragged right now; its subpoints are hidden meanwhile. */
  draggingId: string | null;
  /** Touch screens have no hover: show the row controls outright. */
  alwaysShowControls: boolean;
  /** Rows can be dragged (manual order). */
  sortable: boolean;
  /** Rows nest (manual order). Sorted by due date, every point sits at one level. */
  nested: boolean;
  /** Current titles of the space's pages, by id. */
  pageTitles: Map<string, string>;
  // Null when the action is available; otherwise the plain-English reason
  // it isn't, shown under the greyed-out menu entry.
  subMatterDisabledReason: string | null;
  isExpanded: (key: string) => boolean;
  toggleExpanded: (key: string) => void;
  toggle: (id: string) => void;
  changeText: (id: string, text: string) => void;
  /** Every keystroke. The list debounces it, so a refresh mid-word costs
   *  nothing; changeText still fires on blur and flushes. */
  typeText: (id: string, text: string) => void;
  changeDue: (id: string, due: string) => void;
  clearNote: (id: string) => void;
  remove: (id: string) => void;
  enter: (id: string, currentText: string) => string;
  /** True when the point actually moved; false leaves the key to the browser. */
  indent: (id: string) => boolean;
  outdent: (id: string) => boolean;
  addSubpoint: (id: string) => string;
  addPage: (id: string) => void;
  openPage: (pageId: string) => void;
  unlinkPage: (id: string, pageId: string) => void;
  subMatter: (id: string) => void;
}

/** One level of the outline: the rows of these nodes, each with its own
 *  branches under it. The top level and every nested level draw the same. */
function OutlineLevel({ nodes, outline }: { nodes: TreeNode<ChecklistItem>[]; outline: OutlineActions }) {
  return (
    <div className="space-y-1">
      {nodes.map((n) => (
        <SortableItem key={n.item.id} node={n} outline={outline} />
      ))}
    </div>
  );
}

function SortableItem({ node, outline }: { node: TreeNode<ChecklistItem>; outline: OutlineActions }) {
  const item = node.item;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: !outline.sortable });

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

  const { today } = outline;
  const overdue = item.due && !item.done && item.due < today;
  const todayDue = item.due && !item.done && item.due === today;
  const flash = outline.flashItemId === item.id;

  const subCount = outline.nested ? node.children.length : 0;
  const pages = item.linked_page_ids;
  const subOpen = outline.isExpanded(`${item.id}:sub`) && outline.draggingId !== item.id;
  // Hover-revealed on a pointer screen, always there on a touch screen.
  const reveal = outline.alwaysShowControls ? 'opacity-100' : 'opacity-0 group-hover:opacity-100';
  const pagesOpen = outline.isExpanded(`${item.id}:pages`);
  // The branch line shows whenever there is something under the point. With
  // nothing under it, the row's own + and its menu are the way in.
  const hasBranches = subCount > 0 || pages.length > 0;

  const focusItem = (id: string, caretAtEnd = false) => {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>(`[data-item-id="${id}"]`);
      if (!el) return;
      el.focus();
      if (caretAtEnd) { const n = el.value.length; el.setSelectionRange(n, n); }
    });
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-lg border transition-colors group ${
        flash
          ? 'border-[#e8b84a] bg-[rgba(232,184,74,0.12)]'
          : 'border-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.03)]'
      }`}
    >
    <div className="flex items-center gap-2 px-2 py-2">
      {outline.sortable && (
        <button
          {...attributes}
          {...listeners}
          className={`${reveal} p-0.5 rounded text-white/30 hover:text-white/70 transition-all shrink-0 cursor-grab active:cursor-grabbing`}
          title="Drag to reorder — drop on another point to sit beside it"
        >
          <GripVertical size={13} />
        </button>
      )}
      <button onClick={() => outline.toggle(item.id)} className="shrink-0 transition-opacity hover:opacity-70" title={item.done ? 'Mark incomplete' : 'Mark done'}>
        {item.done
          ? <CheckCircle2 size={18} className="text-[#4ade80]" />
          : <Circle size={18} className="text-white/40" />}
      </button>
      <div className="flex-1 min-w-0 flex flex-col">
      <input
        type="text"
        value={text}
        onChange={(e) => { setText(e.target.value); outline.typeText(item.id, e.target.value); }}
        // No `text !== item.text` guard: typeText has already synced the
        // item, so the guard would short-circuit blur and leave the debounce
        // pending. Committing an unchanged value writes nothing (the saver
        // compares signatures), so this is free and it flushes.
        onBlur={() => outline.changeText(item.id, text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            // A sibling below, at this level. Focus it on the next paint.
            focusItem(outline.enter(item.id, text));
          } else if (e.key === 'Tab' && outline.nested) {
            // Tab nests this point under the one above it; Shift+Tab steps
            // it back out. The outliner's keyboard, so a branch can be
            // typed without reaching for the mouse. When there is nowhere
            // to go, the key is left to the browser so focus can leave.
            const moved = e.shiftKey ? outline.outdent(item.id) : outline.indent(item.id);
            if (moved) {
              e.preventDefault();
              // The input remounts under its new parent; put the caret back at the end.
              focusItem(item.id, true);
            }
          }
        }}
        data-item-id={item.id}
        className={`w-full bg-transparent outline-none text-[14px] ${item.done ? 'line-through text-white/40' : 'text-[#f5f2ed]'}`}
      />
      {/* An agent's line under the item (update_list_item): a question, or
          where the result is. Read it, then clear it with the x. */}
      {item.note && (
        <div className="flex items-start gap-1 mt-0.5 text-[12px] leading-snug text-[#e8b84a]/85">
          <span className="min-w-0 break-words italic">{item.note}</span>
          <button
            onClick={() => outline.clearNote(item.id)}
            className="shrink-0 p-0.5 rounded text-white/30 hover:text-white/70 transition-colors"
            title="Clear note"
          >
            <X size={11} />
          </button>
        </div>
      )}
      </div>
      <DueDateField
        value={item.due ?? ''}
        onChange={(due) => outline.changeDue(item.id, due)}
        overdue={!!overdue}
        todayDue={!!todayDue}
        muted={item.done}
      />
      {/* Standing marker: an item that has a sub-matter says so without
          being hovered, and the marker itself opens it. (A point's pages
          and subpoints are the branches under it, below.) */}
      {item.linked_matter_id && (
        <button
          onClick={() => outline.subMatter(item.id)}
          className="p-1 rounded shrink-0 text-[#e8b84a] hover:bg-[rgba(232,184,74,0.1)] transition-colors"
          title="Open sub-matter"
        >
          <Folder size={13} />
        </button>
      )}
      {/* The + Eden asked for: a subpoint under this point, one click, as
          far down as the thought goes. */}
      {outline.nested && (
        <button
          onClick={() => outline.addSubpoint(item.id)}
          className={`${reveal} p-1 rounded text-white/40 hover:text-[#e8b84a] hover:bg-[rgba(232,184,74,0.1)] transition-all shrink-0`}
          title="Add subpoint"
        >
          <Plus size={13} />
        </button>
      )}
      <ItemActionsMenu
        item={item}
        nested={outline.nested}
        alwaysVisible={outline.alwaysShowControls}
        onAddSubpoint={() => outline.addSubpoint(item.id)}
        onAddPage={() => outline.addPage(item.id)}
        onSubMatter={() => outline.subMatter(item.id)}
        subMatterDisabledReason={outline.subMatterDisabledReason}
      />
      <button
        onClick={() => outline.remove(item.id)}
        className={`${reveal} p-1 rounded text-white/40 hover:text-red-300 hover:bg-red-300/10 transition-all shrink-0`}
        title={subCount > 0 ? 'Delete this point (its subpoints move up a level)' : 'Delete'}
      >
        <Trash2 size={13} />
      </button>
    </div>

    {/* The branch line, right under the point: subpoints fold on the left,
        pages fold on the right, each on its own. */}
    {hasBranches && (
      <div className="flex items-center justify-between gap-3 pl-[38px] pr-3 pb-1.5 -mt-1 text-[11.5px]">
        <div className="flex items-center gap-1 min-w-0">
          {subCount > 0 ? (
            <>
              <button
                onClick={() => outline.toggleExpanded(`${item.id}:sub`)}
                className="flex items-center gap-1 text-white/55 hover:text-white transition-colors"
                title={subOpen ? 'Fold the subpoints' : 'Unfold the subpoints'}
              >
                {subOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <CornerDownRight size={11} className="opacity-70" />
                <span>{subCount} {subCount === 1 ? 'subpoint' : 'subpoints'}</span>
              </button>
              <button
                onClick={() => outline.addSubpoint(item.id)}
                className="p-0.5 rounded text-white/35 hover:text-[#e8b84a] hover:bg-[rgba(232,184,74,0.1)] transition-colors"
                title="Add subpoint"
              >
                <Plus size={11} />
              </button>
            </>
          ) : <span />}
        </div>
        <div className="flex items-center gap-1 min-w-0">
          {pages.length > 0 && (
            <>
              <button
                onClick={() => outline.addPage(item.id)}
                className="p-0.5 rounded text-white/35 hover:text-[#e8b84a] hover:bg-[rgba(232,184,74,0.1)] transition-colors"
                title="Add another page under this point"
              >
                <Plus size={11} />
              </button>
              <button
                onClick={() => outline.toggleExpanded(`${item.id}:pages`)}
                className="flex items-center gap-1 text-[#e8b84a]/80 hover:text-[#e8b84a] transition-colors"
                title={pagesOpen ? 'Fold the pages' : 'Unfold the pages'}
              >
                <FileText size={11} />
                <span>{pages.length} {pages.length === 1 ? 'page' : 'pages'}</span>
                {pagesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            </>
          )}
        </div>
      </div>
    )}

    {/* The pages, stacked at the right under their point, each titled as the
        page is titled now. Click opens; the x takes the page off this point
        and leaves it in the matter. */}
    {pages.length > 0 && pagesOpen && (
      <div className="flex justify-end pl-[38px] pr-3 pb-2">
        <div className="w-full sm:w-[62%] space-y-0.5">
          {pages.map((pid) => (
            <div key={pid} className="group/page flex items-center gap-2 rounded-md border border-[rgba(232,184,74,0.18)] bg-[rgba(232,184,74,0.05)] pl-2.5 pr-1 py-1 text-[13px] text-[#e8b84a]/90 hover:text-[#e8b84a] hover:bg-[rgba(232,184,74,0.1)] transition-colors">
              <button
                onClick={() => outline.openPage(pid)}
                className="flex-1 min-w-0 flex items-center gap-2 text-left"
                title="Open page"
              >
                <FileText size={13} className="shrink-0" />
                <span className="truncate">{outline.pageTitles.get(pid) ?? 'Untitled Page'}</span>
              </button>
              <button
                onClick={() => outline.unlinkPage(item.id, pid)}
                className={`${outline.alwaysShowControls ? 'opacity-100' : 'opacity-0 group-hover/page:opacity-100'} p-1 rounded text-white/35 hover:text-red-300 transition-all shrink-0`}
                title="Take this page off the point (the page stays in the matter)"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      </div>
    )}

    {/* The subpoints, indented under their point, each able to branch again. */}
    {subCount > 0 && subOpen && (
      <div className="ml-[26px] mr-1 mb-1.5 pl-2 border-l border-[rgba(255,255,255,0.08)]">
        <OutlineLevel nodes={node.children} outline={outline} />
      </div>
    )}
    </div>
  );
}


interface ItemActionsMenuProps {
  item: ChecklistItem;
  nested: boolean;
  alwaysVisible: boolean;
  onAddSubpoint: () => void;
  onAddPage: () => void;
  onSubMatter: () => void;
  subMatterDisabledReason: string | null;
}

// The quiet per-item menu. It stays out of the way until the row is hovered,
// and it is portalled to <body> with fixed coordinates so a resized (and
// therefore scrolling) list card can't clip it.
function ItemActionsMenu({ item, nested, alwaysVisible, onAddSubpoint, onAddPage, onSubMatter, subMatterDisabledReason }: ItemActionsMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  const open = () => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const ENTRY = 32;
    const MENU_HEIGHT = 8 + ENTRY * (nested ? 3 : 2) + (subMatterDisabledReason ? 48 : 0);
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
  const pageCount = item.linked_page_ids.length;

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => (anchor ? setAnchor(null) : open())}
        className={`p-1 rounded transition-all shrink-0 text-white/40 hover:text-white hover:bg-[rgba(255,255,255,0.06)] ${
          anchor ? 'opacity-100 text-white' : alwaysVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
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
            {nested && (
              <button
                onClick={() => { setAnchor(null); onAddSubpoint(); }}
                className={`${entry} text-white/80 hover:bg-[rgba(255,255,255,0.06)] hover:text-white`}
              >
                <CornerDownRight size={12} className="shrink-0 text-white/45" />
                Add subpoint
              </button>
            )}

            <button
              onClick={() => { setAnchor(null); onAddPage(); }}
              className={`${entry} text-white/80 hover:bg-[rgba(255,255,255,0.06)] hover:text-white`}
            >
              <FileText size={12} className="shrink-0 text-white/45" />
              {pageCount > 0 ? 'Add another page' : 'Add page'}
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
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null);

  const colorClass = muted
    ? 'text-white/30'
    : overdue
      ? 'text-red-300'
      : todayDue
        ? 'text-[#e8b84a]'
        : value
          ? 'text-white/70'
          : 'text-white/30 hover:text-white/60';

  // The popover is portalled to <body>, so a resized (overflow-hidden)
  // list card can't clip it. Anchor it off the trigger's live rect.
  const openPicker = () => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = 250;
    setRect({
      left: Math.min(Math.max(8, r.left - width + r.width), window.innerWidth - width - 8),
      top: r.bottom + 6,
    });
    setOpen(true);
  };

  return (
    <span
      ref={anchorRef}
      className={`relative inline-flex items-center gap-1 text-[11px] shrink-0 px-2 py-1 rounded hover:bg-[rgba(255,255,255,0.04)] transition-colors ${colorClass}`}
    >
      <button
        type="button"
        onClick={openPicker}
        className="flex items-center gap-1 cursor-pointer"
        title="Due date — opens the calendar"
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
      {open && rect && (
        <DuePickerPopover
          value={value}
          left={rect.left}
          top={rect.top}
          onPick={(d) => { onChange(d); setOpen(false); }}
          onClear={() => { onChange(''); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

// A real month grid, not the browser's date control: pick a day, clear the
// date, or step into the full Contextspaces calendar. This is what the
// calendar icon on a list item opens.
function DuePickerPopover({
  value, left, top, onPick, onClear, onClose,
}: {
  value: string;
  left: number;
  top: number;
  onPick: (d: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const pad = (n: number) => String(n).padStart(2, '0');
  const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayKey = key(new Date());
  const [cursor, setCursor] = useState(() => {
    const base = value ? new Date(value + 'T00:00:00') : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const gridStart = new Date(cursor);
  gridStart.setDate(1 - cursor.getDay());
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    days.push(d);
  }

  const shift = (n: number) =>
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1));

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[70]" onClick={onClose}>
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ left, top, width: 250 }}
          className="fixed rounded-lg border border-[rgba(255,255,255,0.16)] bg-[#0d0d14] shadow-2xl p-2.5"
        >
          <div className="flex items-center justify-between mb-1.5">
            <button onClick={() => shift(-1)} className="p-1 rounded text-white/45 hover:text-white hover:bg-[rgba(255,255,255,0.06)]" title="Previous month">
              <ChevronLeft size={13} />
            </button>
            <span className="text-[11.5px] text-[#f5f2ed]">
              {cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
            </span>
            <button onClick={() => shift(1)} className="p-1 rounded text-white/45 hover:text-white hover:bg-[rgba(255,255,255,0.06)]" title="Next month">
              <ChevronRight size={13} />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-px mb-0.5">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <div key={i} className="text-[9px] text-white/30 text-center py-0.5">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px">
            {days.map((d) => {
              const k = key(d);
              const inMonth = d.getMonth() === cursor.getMonth();
              const selected = k === value;
              return (
                <button
                  key={k}
                  onClick={() => onPick(k)}
                  className={`text-[11px] tabular-nums rounded py-1 transition-colors ${
                    selected
                      ? 'bg-[#f0c850] text-[#0e0e12] font-bold'
                      : k === todayKey
                        ? 'text-[#e8b84a] hover:bg-[rgba(255,255,255,0.07)]'
                        : inMonth
                          ? 'text-white/75 hover:bg-[rgba(255,255,255,0.07)]'
                          : 'text-white/20 hover:bg-[rgba(255,255,255,0.05)]'
                  }`}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between mt-2 pt-2 border-t border-[rgba(255,255,255,0.08)]">
            <button
              onClick={() => onPick(todayKey)}
              className="text-[10.5px] text-white/55 hover:text-white transition-colors"
            >
              Today
            </button>
            {value && (
              <button
                onClick={onClear}
                className="text-[10.5px] text-white/40 hover:text-red-300 transition-colors"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => { onClose(); navigate('/app/calendar'); }}
              className="text-[10.5px] text-[#e8b84a] hover:text-[#f5d565] transition-colors"
            >
              Open calendar →
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
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
