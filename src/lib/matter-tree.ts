// Shared matter-tree builder used by Sidebar and Dashboard so both views
// render the same hierarchy from the same flat list returned by
// useServerspaces. Roots are matters with parent_matterspace_id == null
// or whose parent is missing from the same list (defensive — shouldn't
// happen given a single serverspace, but prevents silently dropping rows).

import type { ServerspaceMatter } from '@/hooks/useServerspaces';

export interface MatterTreeNode {
  matter: ServerspaceMatter;
  children: MatterTreeNode[];
}

export function buildMatterTree(matters: ServerspaceMatter[]): MatterTreeNode[] {
  const byId = new Map<string, MatterTreeNode>();
  for (const m of matters) byId.set(m.id, { matter: m, children: [] });
  const roots: MatterTreeNode[] = [];
  for (const m of matters) {
    const node = byId.get(m.id)!;
    const parentId = m.parent_matterspace_id;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortByName = (a: MatterTreeNode, b: MatterTreeNode) =>
    a.matter.name.localeCompare(b.matter.name);
  const sortRec = (nodes: MatterTreeNode[]) => {
    nodes.sort(sortByName);
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/**
 * The nearest matter that holds every one of `ids` beneath it (or is one of
 * them): the matter a brief "draws on" when its appendix and its cases sit in
 * sibling folders. Null when the ids share no ancestor in the list.
 */
export function nearestCommonAncestor(
  matters: Pick<ServerspaceMatter, 'id' | 'parent_matterspace_id'>[],
  ids: string[],
): string | null {
  const parent = new Map(matters.map((m) => [m.id, m.parent_matterspace_id]));
  const chainOf = (id: string): string[] => {
    const out: string[] = [];
    let cur: string | null | undefined = id;
    while (cur && !out.includes(cur)) { out.push(cur); cur = parent.get(cur); }
    return out;
  };
  const want = ids.filter((id) => parent.has(id));
  if (!want.length) return null;
  const [first, ...rest] = want.map(chainOf);
  return first.find((a) => rest.every((chain) => chain.includes(a))) ?? null;
}

/** A matter is sealed by its own tier or by any ancestor's (the seal inherits downward). */
export function isSealedIn(
  matters: Pick<ServerspaceMatter, 'id' | 'parent_matterspace_id' | 'ai_tier'>[],
  id: string | null | undefined,
): boolean {
  const byId = new Map(matters.map((m) => [m.id, m]));
  const seen = new Set<string>();
  let cur = id ? byId.get(id) : undefined;
  while (cur && !seen.has(cur.id)) {
    if (cur.ai_tier !== 'A') return true;
    seen.add(cur.id);
    cur = cur.parent_matterspace_id ? byId.get(cur.parent_matterspace_id) : undefined;
  }
  return false;
}
