// The outline behind a list.
//
// A list's items are stored FLAT, in pre-order, with an optional `parent_id`
// on each: a subpoint is an item whose parent_id names another item in the
// same list. Everything else that reads a list — the calendar's due dates,
// the MCP get_list / update_list_item tools, the dead-link sweep — walks the
// flat array and keeps working unchanged; only the list view cares about the
// tree, and it builds one here from the array and writes the array back from
// the tree.
//
// Repair, never discard: an item whose parent is missing, is itself, or sits
// in a cycle is read as a top-level item. Order among siblings is array order.

export interface OutlineItem {
  id: string;
  parent_id?: string | null;
}

export interface TreeNode<T extends OutlineItem> {
  item: T;
  depth: number;
  children: TreeNode<T>[];
}

/** The forest the flat array describes. Orphans and cycle members surface as roots. */
export function buildTree<T extends OutlineItem>(items: T[]): TreeNode<T>[] {
  const byId = new Map<string, T>();
  for (const it of items) byId.set(it.id, it);

  // Resolve each item's effective parent: null when the parent is unknown,
  // is the item itself, or the chain of parents loops back.
  const effectiveParent = new Map<string, string | null>();
  for (const it of items) {
    const p = it.parent_id ?? null;
    if (!p || p === it.id || !byId.has(p)) { effectiveParent.set(it.id, null); continue; }
    const seen = new Set<string>([it.id]);
    let cur: string | null = p;
    let cyclic = false;
    while (cur) {
      if (seen.has(cur)) { cyclic = true; break; }
      seen.add(cur);
      const next: string | null = byId.get(cur)?.parent_id ?? null;
      cur = next && byId.has(next) ? next : null;
    }
    effectiveParent.set(it.id, cyclic ? null : p);
  }

  const nodes = new Map<string, TreeNode<T>>();
  for (const it of items) nodes.set(it.id, { item: it, depth: 0, children: [] });
  const roots: TreeNode<T>[] = [];
  for (const it of items) {
    const node = nodes.get(it.id)!;
    const p = effectiveParent.get(it.id);
    if (p) nodes.get(p)!.children.push(node);
    else roots.push(node);
  }
  const setDepth = (list: TreeNode<T>[], depth: number) => {
    for (const n of list) { n.depth = depth; setDepth(n.children, depth + 1); }
  };
  setDepth(roots, 0);
  return roots;
}

/** Pre-order: each item followed by its subtree. parent_id is normalised to
 *  what the tree actually says (a repaired orphan is written back as a root). */
export function flattenTree<T extends OutlineItem>(roots: TreeNode<T>[]): T[] {
  const out: T[] = [];
  const walk = (list: TreeNode<T>[], parent: string | null) => {
    for (const n of list) {
      const pid = n.item.parent_id ?? null;
      out.push(pid === parent ? n.item : { ...n.item, parent_id: parent });
      walk(n.children, n.item.id);
    }
  };
  walk(roots, null);
  return out;
}

/** The array, re-serialised from its own tree: orphans repaired, pre-order restored. */
export function normalizeOutline<T extends OutlineItem>(items: T[]): T[] {
  return flattenTree(buildTree(items));
}

export function findNode<T extends OutlineItem>(roots: TreeNode<T>[], id: string): TreeNode<T> | null {
  for (const n of roots) {
    if (n.item.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/** The ids of an item and everything under it. */
export function subtreeIds<T extends OutlineItem>(items: T[], id: string): Set<string> {
  const node = findNode(buildTree(items), id);
  const out = new Set<string>();
  if (!node) return out;
  const walk = (n: TreeNode<T>) => { out.add(n.item.id); n.children.forEach(walk); };
  walk(node);
  return out;
}

/** Parent, grandparent, … of an item (nearest first), as the tree resolves them. */
export function ancestorIds<T extends OutlineItem>(items: T[], id: string): string[] {
  const roots = buildTree(items);
  const path: string[] = [];
  const walk = (list: TreeNode<T>[], trail: string[]): boolean => {
    for (const n of list) {
      if (n.item.id === id) { path.push(...trail); return true; }
      if (walk(n.children, [n.item.id, ...trail])) return true;
    }
    return false;
  };
  walk(roots, []);
  return path;
}

/** Repaired parent of an item, or null for a top-level item. */
export function parentOf<T extends OutlineItem>(items: T[], id: string): string | null {
  const a = ancestorIds(items, id);
  return a[0] ?? null;
}

/** Insert `item` as the sibling right after `afterId` — after its whole
 *  subtree in the flat array, so the new item does not land among the
 *  reference item's own subpoints. */
export function insertSiblingAfter<T extends OutlineItem>(items: T[], afterId: string, item: T): T[] {
  const roots = buildTree(items);
  const parent = parentOf(items, afterId);
  const siblings = parent ? findNode(roots, parent)!.children : roots;
  const idx = siblings.findIndex((n) => n.item.id === afterId);
  const node: TreeNode<T> = { item: { ...item, parent_id: parent }, depth: 0, children: [] };
  if (idx < 0) siblings.push(node); else siblings.splice(idx + 1, 0, node);
  return flattenTree(roots);
}

/** Append `item` as the last subpoint of `parentId`. */
export function appendChild<T extends OutlineItem>(items: T[], parentId: string, item: T): T[] {
  const roots = buildTree(items);
  const parent = findNode(roots, parentId);
  if (!parent) return insertSiblingAfter(items, parentId, item);
  parent.children.push({ item: { ...item, parent_id: parentId }, depth: 0, children: [] });
  return flattenTree(roots);
}

/** Remove one item. Its subpoints move up to take its place rather than
 *  vanishing with it: deleting a heading is not deleting the work under it. */
export function removeItem<T extends OutlineItem>(items: T[], id: string): T[] {
  const roots = buildTree(items);
  const parent = parentOf(items, id);
  const siblings = parent ? findNode(roots, parent)!.children : roots;
  const idx = siblings.findIndex((n) => n.item.id === id);
  if (idx < 0) return items;
  const [gone] = siblings.splice(idx, 1);
  siblings.splice(idx, 0, ...gone.children);
  return flattenTree(roots);
}

/** Remove one item AND everything under it. */
export function removeSubtree<T extends OutlineItem>(items: T[], id: string): T[] {
  const ids = subtreeIds(items, id);
  return normalizeOutline(items.filter((i) => !ids.has(i.id)));
}

/** Drag-and-drop: `activeId` takes `overId`'s place — same parent as the
 *  target, same slot among its siblings — and its subpoints come along.
 *  A drop onto one's own descendant is refused (it would orphan the subtree). */
export function moveItem<T extends OutlineItem>(items: T[], activeId: string, overId: string): T[] {
  if (activeId === overId) return items;
  if (subtreeIds(items, activeId).has(overId)) return items;
  const roots = buildTree(items);
  const active = findNode(roots, activeId);
  const over = findNode(roots, overId);
  if (!active || !over) return items;

  // Detach the active node (children ride along inside it).
  const fromParent = parentOf(items, activeId);
  const fromList = fromParent ? findNode(roots, fromParent)!.children : roots;
  const fromIdx = fromList.findIndex((n) => n.item.id === activeId);
  fromList.splice(fromIdx, 1);

  const toParent = parentOf(items, overId);
  const toList = toParent ? findNode(roots, toParent)!.children : roots;
  const toIdx = toList.findIndex((n) => n.item.id === overId);
  // Moving down inside one sibling list: the gap left above shifts the
  // target up by one, so land AFTER it to end up where the pointer was.
  const sameList = fromList === toList;
  const insertAt = sameList && fromIdx < toIdx ? toIdx + 1 : toIdx;
  toList.splice(insertAt, 0, active);
  return flattenTree(roots);
}

/** Tab: become the last subpoint of the sibling just above. No sibling above → unchanged. */
export function indentItem<T extends OutlineItem>(items: T[], id: string): T[] {
  const roots = buildTree(items);
  const parent = parentOf(items, id);
  const siblings = parent ? findNode(roots, parent)!.children : roots;
  const idx = siblings.findIndex((n) => n.item.id === id);
  if (idx <= 0) return items;
  const [node] = siblings.splice(idx, 1);
  siblings[idx - 1].children.push(node);
  return flattenTree(roots);
}

/** Shift+Tab: step out one level, landing right after the former parent.
 *  Already top-level → unchanged. */
export function outdentItem<T extends OutlineItem>(items: T[], id: string): T[] {
  const roots = buildTree(items);
  const parent = parentOf(items, id);
  if (!parent) return items;
  const parentNode = findNode(roots, parent)!;
  const idx = parentNode.children.findIndex((n) => n.item.id === id);
  const [node] = parentNode.children.splice(idx, 1);
  const grand = parentOf(items, parent);
  const upper = grand ? findNode(roots, grand)!.children : roots;
  const pIdx = upper.findIndex((n) => n.item.id === parent);
  upper.splice(pIdx + 1, 0, node);
  return flattenTree(roots);
}
