// Every matter this person can open, as one flat list with its path
// ("Legal › DeCamara v. Bryn Mawr › Appeal") and whether it is sealed (a seal
// inherits downward). Built from the same serverspaces query the sidebar uses,
// never a parallel one.

import { useMemo } from 'react';
import { useServerspaces } from '@/hooks/useServerspaces';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';

export interface MatterOption { id: string; label: string; sealed: boolean }

export function useMatterOptions(): { options: MatterOption[]; loading: boolean } {
  const { data: spaces = [], isLoading } = useServerspaces();
  const options = useMemo(() => {
    const out: MatterOption[] = [];
    for (const s of spaces) {
      const walk = (nodes: MatterTreeNode[], trail: string[], sealedAbove: boolean) => {
        for (const n of nodes) {
          const sealed = sealedAbove || n.matter.ai_tier !== 'A';
          const path = [...trail, n.matter.name];
          out.push({ id: n.matter.id, label: path.join(' › '), sealed });
          walk(n.children, path, sealed);
        }
      };
      walk(buildMatterTree(s.matterspaces), [s.name], false);
    }
    return out;
  }, [spaces]);
  return { options, loading: isLoading };
}
