// Which matters an agent can see, computed in the browser from the matter
// tree the sidebar already holds (useServerspaces). Display only: the server
// enforces the same rule in /api/mcp, and the server is what an agent meets.
//
// The rule (spec A3, Eden 09-24):
//   * A grant covers the matter and every matter beneath it.
//   * A sealed matter (SecureSpace tier B or C, its own or inherited from any
//     ancestor) is never visible to an agent. A grant cannot override the
//     seal; the seal wins.
//   * An empty scope means nothing.
//
// Pure functions, no imports, so a node harness can drive them directly.

export interface ScopeMatter {
  id: string;
  parent_matterspace_id: string | null;
  ai_tier?: string | null;
}

function byIdMap(matters: readonly ScopeMatter[]): Map<string, ScopeMatter> {
  const m = new Map<string, ScopeMatter>();
  for (const x of matters) m.set(x.id, x);
  return m;
}

/** The matter itself, then its parent, then its parent's parent… */
export function ancestorsInclusive(matters: readonly ScopeMatter[], matterId: string): string[] {
  const byId = byIdMap(matters);
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = matterId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = byId.get(cur)?.parent_matterspace_id ?? null;
  }
  return out;
}

/** True when the matter or any ancestor is sealed (tier other than A). */
export function isEffectivelySealed(matters: readonly ScopeMatter[], matterId: string): boolean {
  const byId = byIdMap(matters);
  return ancestorsInclusive(matters, matterId).some((id) => {
    const m = byId.get(id);
    return !!m && m.ai_tier !== 'A';
  });
}

/** Every sealed matter, own tier or inherited. */
export function sealedMatterIds(matters: readonly ScopeMatter[]): Set<string> {
  const out = new Set<string>();
  for (const m of matters) if (isEffectivelySealed(matters, m.id)) out.add(m.id);
  return out;
}

/**
 * Whether an agent holding `scope` can see `matterId`: the matter or one of
 * its ancestors is granted, and nothing on the way up is sealed.
 */
export function scopeCoversMatter(
  matters: readonly ScopeMatter[],
  scope: readonly string[] | null | undefined,
  matterId: string,
): boolean {
  if (!scope || scope.length === 0) return false;
  if (isEffectivelySealed(matters, matterId)) return false;
  const granted = new Set(scope);
  return ancestorsInclusive(matters, matterId).some((id) => granted.has(id));
}

/**
 * Whether an AGENT can see `matterId`, given its row: with scope_all
 * (migration 088, "All my matters (except SecureSpaces)") every matter the
 * user can see except a sealed one; otherwise its listed grant. Only a literal
 * `true` counts as all, as on the server.
 */
export function agentCoversMatter(
  matters: readonly ScopeMatter[],
  agent: { matter_scope: readonly string[] | null | undefined; scope_all?: boolean | null },
  matterId: string,
): boolean {
  if (agent.scope_all === true) return !isEffectivelySealed(matters, matterId);
  return scopeCoversMatter(matters, agent.matter_scope, matterId);
}

/** Every matter the scope reaches, descendants included, seals excluded. */
export function coveredMatterIds(
  matters: readonly ScopeMatter[],
  scope: readonly string[] | null | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const m of matters) if (scopeCoversMatter(matters, scope, m.id)) out.add(m.id);
  return out;
}

/**
 * The grant as it should be stored: sealed matters dropped (a seal cannot be
 * granted), and any matter already covered by a ticked ancestor dropped (the
 * ancestor carries it). Order follows the input.
 */
export function normalizeScope(
  matters: readonly ScopeMatter[],
  ticked: readonly string[],
): string[] {
  const set = new Set(ticked);
  return ticked.filter((id, i) => {
    if (ticked.indexOf(id) !== i) return false;
    if (isEffectivelySealed(matters, id)) return false;
    const ups = ancestorsInclusive(matters, id).slice(1);
    return !ups.some((a) => set.has(a));
  });
}
