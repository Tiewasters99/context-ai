// Choose one matter, from the same tree the sidebar draws. Sub-matters sit
// indented under their parent. A matter in a SecureSpace (its own tier or
// inherited) is listed but cannot be chosen: no connected AI can see it.
//
// A native <select> on purpose: it is the one tree picker that works the
// same on a phone.

import { useMemo, type ReactElement } from 'react';
import { useServerspaces } from '@/hooks/useServerspaces';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';
import { isEffectivelySealed } from '@/lib/agent-scope';
import { cardField } from './AgentCard';

export const SEALED_OPTION_SUFFIX = ' — SecureSpace, no AI can see it';

export default function MatterSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (matterId: string) => void;
}) {
  const { data: serverspaces = [], isLoading } = useServerspaces();
  const all = useMemo(() => serverspaces.flatMap((s) => s.matterspaces ?? []), [serverspaces]);

  const groups = useMemo(() => serverspaces.map((s) => {
    const out: ReactElement[] = [];
    const walk = (nodes: MatterTreeNode[], depth: number) => {
      for (const n of nodes) {
        const sealed = isEffectivelySealed(all, n.matter.id);
        out.push(
          <option key={n.matter.id} value={n.matter.id} disabled={sealed}>
            {`${'   '.repeat(depth)}${n.matter.name}${sealed ? SEALED_OPTION_SUFFIX : ''}`}
          </option>,
        );
        walk(n.children, depth + 1);
      }
    };
    walk(buildMatterTree(s.matterspaces ?? []), 0);
    return { id: s.id, name: s.name, options: out };
  }), [serverspaces, all]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cardField}
      aria-label="Matter"
    >
      <option value="" disabled>{isLoading ? 'Reading your matters…' : 'Choose a matter…'}</option>
      {groups.map((g) => (
        <optgroup key={g.id} label={g.name}>{g.options}</optgroup>
      ))}
    </select>
  );
}
