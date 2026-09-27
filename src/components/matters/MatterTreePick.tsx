// Choose ONE matter from the tree the sidebar draws — for "Add a case", where
// the flat drop-down hid the sub-matters (Eden, 09-27: a missing case had to
// go to DeCamara › Appeal, and the list read as "only the Sandbox").
//
// Built on useServerspaces + buildMatterTree, the same tree the sidebar and
// the agent picker use, so every matter appears once, in its place, with its
// sub-matters beneath it. Sealed matters (own tier or inherited) are shown
// and can be chosen — a case can be filed in a SecureSpace — but say so.
// A filter box narrows by name when the tree is long; a match keeps its
// ancestors so the path still reads.

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Check, ChevronRight, Lock, Search } from 'lucide-react';
import { useServerspaces } from '@/hooks/useServerspaces';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';

export default function MatterTreePick({ value, onChange, maxHeight = 260 }: {
  value: string | null;
  onChange: (matterId: string) => void;
  maxHeight?: number;
}) {
  const { data: serverspaces = [], isLoading, error } = useServerspaces();
  const [q, setQ] = useState('');
  const groups = useMemo(
    () => serverspaces.map((s) => ({ id: s.id, name: s.name, roots: buildMatterTree(s.matterspaces ?? []) })),
    [serverspaces],
  );
  const total = useMemo(() => serverspaces.reduce((n, s) => n + (s.matterspaces?.length ?? 0), 0), [serverspaces]);
  // The chosen matter in view when the tree first draws (300 matters deep,
  // the brief's own would otherwise sit below the fold).
  const box = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !box.current) return;
    const el = box.current.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el) return;
    scrolled.current = true;
    el.scrollIntoView({ block: 'center' });
  }, [groups, value]);

  // The filter keeps a matching node, its ancestors (so the path reads) and
  // everything beneath a match (a hit on "DeCamara" shows its Appeal).
  const needle = q.trim().toLowerCase();
  const prune = (nodes: MatterTreeNode[], underHit: boolean): MatterTreeNode[] => {
    if (!needle) return nodes;
    const out: MatterTreeNode[] = [];
    for (const n of nodes) {
      const hit = underHit || n.matter.name.toLowerCase().includes(needle) || (n.matter.short_code ?? '').toLowerCase().includes(needle);
      const kids = prune(n.children, hit);
      if (hit || kids.length) out.push({ matter: n.matter, children: hit ? n.children : kids });
    }
    return out;
  };

  if (isLoading) return <p className="text-[12px] text-white/40 italic">Reading your matters…</p>;
  if (error) return <p className="text-[12px] text-red-300">Could not read your matters.</p>;
  if (groups.every((g) => g.roots.length === 0)) return <p className="text-[12px] text-white/50">You have no matters yet.</p>;

  const renderNode = (node: MatterTreeNode, depth: number, parentSealed: boolean): ReactElement => {
    const m = node.matter;
    const sealed = parentSealed || m.ai_tier !== 'A';
    const chosen = m.id === value;
    return (
      <div key={m.id}>
        <button
          type="button"
          onClick={() => onChange(m.id)}
          aria-pressed={chosen}
          data-matter-id={m.id}
          className={`w-full flex items-center gap-1.5 py-1 pr-2 rounded text-left ${chosen ? 'bg-[#e8b84a]/[0.12]' : 'hover:bg-white/[0.04]'}`}
          style={{ paddingLeft: 6 + depth * 16 }}
          title={sealed ? 'In a SecureSpace. The case is filed under the seal.' : undefined}
        >
          <span className="w-3.5 shrink-0 inline-flex justify-center text-white/25">
            {node.children.length ? <ChevronRight size={11} className="rotate-90" /> : null}
          </span>
          <span className={`flex-1 min-w-0 truncate text-[13px] leading-snug ${chosen ? 'text-[#e8b84a]' : sealed ? 'text-white/60' : 'text-white/85'}`}>
            {m.short_code ? <span className="text-white/40 mr-1.5">{m.short_code}</span> : null}
            {m.name}
            {sealed && <Lock size={10} className="inline ml-1.5 -mt-0.5 text-white/35" />}
          </span>
          {chosen && <Check size={13} className="shrink-0 text-[#e8b84a]" />}
        </button>
        {node.children.map((c) => renderNode(c, depth + 1, sealed))}
      </div>
    );
  };

  const shown = groups.map((g) => ({ ...g, roots: prune(g.roots, false) }));
  const nothing = shown.every((g) => g.roots.length === 0);
  return (
    <div data-card-inert>
      {total > 8 && (
        <label className="flex items-center gap-2 mb-1.5 px-2.5 h-8 rounded-lg bg-white/[0.04] border border-white/[0.08] focus-within:border-[#e8b84a]/50">
          <Search size={12} className="text-white/35 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a matter by name"
            className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-white/85 placeholder:text-white/30"
            aria-label="Find a matter by name"
          />
        </label>
      )}
      <div ref={box} className="rounded-lg border border-white/[0.08] overflow-y-auto py-1" style={{ maxHeight }}>
        {nothing && <p className="px-3 py-2 text-[12px] text-white/45">No matter is named like that.</p>}
        {shown.map((g) => (
          g.roots.length === 0 ? null : (
            <div key={g.id} className="py-1">
              <p className="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-white/35">{g.name}</p>
              {g.roots.map((n) => renderNode(n, 0, false))}
            </div>
          )
        ))}
      </div>
    </div>
  );
}
