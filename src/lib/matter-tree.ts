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
