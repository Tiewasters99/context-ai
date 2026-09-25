// Tick the matters an agent may see.
//
// Built on the same tree the sidebar draws (useServerspaces + buildMatterTree)
// so every matter appears once, in the same place. Sub-matters can be ticked
// on their own. Ticking a matter covers everything beneath it, so its
// sub-matters show as included rather than as separate boxes to tick.
// Sealed matters (SecureSpace, own tier or inherited) are shown, disabled,
// with the reason — never hidden, and never grantable.
//
// Migration 088: when the caller passes onScopeAllChange, a box at the top
// offers "All my matters (except SecureSpaces)". Ticking it greys and
// disables the tree but leaves `value` alone, so unticking it gives back
// exactly the matters that were ticked before.

import { useMemo, type ReactElement } from 'react';
import { Lock } from 'lucide-react';
import { useServerspaces } from '@/hooks/useServerspaces';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';

const SEALED_REASON = 'In a SecureSpace. No outside agent can see it, whatever is ticked.';
export const SCOPE_ALL_LABEL = 'All my matters (except SecureSpaces)';
export const SCOPE_ALL_HINT = 'Includes matters you create later. You can narrow it any time.';

export default function AgentMatterPicker({
  value,
  onChange,
  scopeAll = false,
  onScopeAllChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** 088: "All my matters (except SecureSpaces)" is ticked. */
  scopeAll?: boolean;
  /** Shows the "All my matters" box; omit it to offer the tree alone. */
  onScopeAllChange?: (next: boolean) => void;
}) {
  const allOn = !!onScopeAllChange && scopeAll;
  const { data: serverspaces = [], isLoading, error } = useServerspaces();
  const ticked = useMemo(() => new Set(value), [value]);

  const groups = useMemo(
    () => serverspaces.map((s) => ({ id: s.id, name: s.name, roots: buildMatterTree(s.matterspaces ?? []) })),
    [serverspaces],
  );

  const toggle = (id: string) => {
    if (allOn) return;
    if (ticked.has(id)) onChange(value.filter((x) => x !== id));
    else onChange([...value, id]);
  };

  const allBox = onScopeAllChange ? (
    <label className="flex items-start gap-2 px-2 py-2 mb-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] cursor-pointer hover:bg-white/[0.03]" data-card-inert>
      <input
        type="checkbox"
        className="mt-0.5 accent-[#e8b84a]"
        checked={scopeAll}
        onChange={(e) => onScopeAllChange(e.target.checked)}
      />
      <span className="leading-snug">
        <span className="block text-[13px] text-white/90">{SCOPE_ALL_LABEL}</span>
        <span className="block text-[11px] text-white/45 mt-0.5">{SCOPE_ALL_HINT}</span>
      </span>
    </label>
  ) : null;

  if (isLoading) return <>{allBox}<p className="text-[12px] text-white/40 italic">Reading your matters…</p></>;
  if (error) return <>{allBox}<p className="text-[12px] text-red-300">Could not read your matters.</p></>;
  if (groups.every((g) => g.roots.length === 0)) {
    return <>{allBox}<p className="text-[12px] text-white/50">You have no matters yet.</p></>;
  }

  const renderNode = (
    node: MatterTreeNode,
    depth: number,
    parentSealed: boolean,
    parentTicked: boolean,
  ): ReactElement => {
    const m = node.matter;
    const sealed = parentSealed || m.ai_tier !== 'A';
    const own = ticked.has(m.id);
    const included = parentTicked && !sealed;
    const checked = !sealed && (own || parentTicked);
    const disabled = allOn || sealed || parentTicked;
    return (
      <div key={m.id}>
        <label
          className={`flex items-start gap-2 py-1 pr-2 rounded ${disabled ? 'cursor-default' : 'cursor-pointer hover:bg-white/[0.03]'}`}
          style={{ paddingLeft: 6 + depth * 18 }}
          title={sealed ? SEALED_REASON : included ? 'Included with the matter above.' : undefined}
        >
          <input
            type="checkbox"
            className="mt-0.5 accent-[#e8b84a]"
            checked={checked}
            disabled={disabled}
            onChange={() => toggle(m.id)}
          />
          <span className={`text-[13px] leading-snug ${sealed ? 'text-white/35' : 'text-white/85'}`}>
            {m.short_code ? <span className="text-white/40 mr-1.5">{m.short_code}</span> : null}
            {m.name}
            {sealed && (
              <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-white/40">
                <Lock size={10} /> SecureSpace, never visible to an agent
              </span>
            )}
            {!sealed && included && (
              <span className="ml-2 text-[11px] text-white/40">included with the matter above</span>
            )}
          </span>
        </label>
        {node.children.map((c) => renderNode(c, depth + 1, sealed, parentTicked || (own && !sealed)))}
      </div>
    );
  };

  return (
    <>
    {allBox}
    <div
      className={`rounded-lg border border-[rgba(255,255,255,0.08)] max-h-[320px] overflow-y-auto py-1 ${allOn ? 'opacity-40' : ''}`}
      aria-disabled={allOn || undefined}
      title={allOn ? 'Every matter is included. Untick "All my matters" to choose.' : undefined}
      data-card-inert
    >
      {groups.map((g) => (
        g.roots.length === 0 ? null : (
          <div key={g.id} className="py-1">
            <p className="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-white/35">{g.name}</p>
            {g.roots.map((n) => renderNode(n, 0, false, false))}
          </div>
        )
      ))}
    </div>
    </>
  );
}
