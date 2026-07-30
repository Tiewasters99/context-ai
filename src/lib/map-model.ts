// Pure model for the Knowledge Map: turns get_matter_map() rows into a
// packed circle hierarchy plus the two encodings (heat, pull). No React,
// no DOM — KnowledgeMap.tsx owns rendering; everything here is testable
// math. Encodings are deliberately limited to the two the design fixed:
// radius = document mass, fill temperature = activity recency, and one
// ring treatment for deadline pull. Resist adding more.

import { hierarchy, pack, type HierarchyCircularNode } from 'd3-hierarchy';
import { piecewise, interpolateRgb } from 'd3-interpolate';

export interface MapMatterRow {
  id: string;
  name: string;
  short_code: string | null;
  parent_matterspace_id: string | null;
  serverspace_id: string;
  serverspace_name: string;
  doc_count: number;
  last_activity_at: string | null;
  next_deadline: string | null;       // YYYY-MM-DD
  next_deadline_label: string | null;
  overdue_count: number;
  status: MatterStatus;
  headline: string | null;
  next_action: string | null;
  next_action_owner: string | null;
  state_updated_at: string | null;
}

export type MatterStatus = 'active' | 'urgent' | 'waiting' | 'dormant' | 'archived';

export interface MapDatum {
  kind: 'root' | 'serverspace' | 'matter';
  id: string;
  name: string;
  /** URL key: short_code when present, else id. '' for the root. */
  code: string;
  row: MapMatterRow | null;
  /** Utility spaces (e.g. the owner-only Chats archive) render collapsed
      and dimmed — one circle, no children — so hundreds of conversation
      sub-matters don't visually swamp real matters. */
  utility: boolean;
  /** Own (non-rolled-up) contribution to the packed area. */
  selfValue: number;
  subtreeDocs: number;
  lastActivityAt: string | null;
  children?: MapDatum[];
}

export type MapNode = HierarchyCircularNode<MapDatum>;

// Serverspaces that are archives/utilities rather than practice areas.
// Matched by name; extend the list as more utility spaces appear.
const UTILITY_SERVERSPACES = new Set(['chats']);

// Log-scaled mass: a 7,000-doc case reads large without drowning the map,
// and an empty matter still gets a visible dot (+2 keeps log2 ≥ 1).
const massValue = (docs: number) => Math.log2(docs + 2);

const laterOf = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
};

export function buildMapHierarchy(rows: MapMatterRow[]): MapDatum {
  // Group rows by serverspace, preserving first-seen order, then build
  // each serverspace's matter tree the same way buildMatterTree does
  // (orphans defensively become roots).
  const bySpace = new Map<string, { name: string; rows: MapMatterRow[] }>();
  for (const r of rows) {
    const s = bySpace.get(r.serverspace_id);
    if (s) s.rows.push(r);
    else bySpace.set(r.serverspace_id, { name: r.serverspace_name, rows: [r] });
  }

  const spaces: MapDatum[] = [];
  for (const [spaceId, { name, rows: spaceRows }] of bySpace) {
    const byId = new Map<string, MapDatum>();
    for (const r of spaceRows) {
      byId.set(r.id, {
        kind: 'matter',
        id: r.id,
        name: r.name,
        code: r.short_code ?? r.id,
        row: r,
        utility: false,
        selfValue: massValue(r.doc_count),
        subtreeDocs: r.doc_count,
        lastActivityAt: r.last_activity_at,
        children: [],
      });
    }
    const roots: MapDatum[] = [];
    for (const r of spaceRows) {
      const node = byId.get(r.id)!;
      const parent = r.parent_matterspace_id
        ? byId.get(r.parent_matterspace_id)
        : undefined;
      if (parent) parent.children!.push(node);
      else roots.push(node);
    }

    let subtreeDocs = 0;
    let lastActivity: string | null = null;
    for (const r of spaceRows) {
      subtreeDocs += r.doc_count;
      lastActivity = laterOf(lastActivity, r.last_activity_at);
    }

    const utility = UTILITY_SERVERSPACES.has(name.trim().toLowerCase());
    spaces.push({
      kind: 'serverspace',
      id: spaceId,
      name,
      code: spaceId,
      row: null,
      utility,
      // Collapsed utility spaces carry their whole subtree's (log) mass on
      // themselves; ordinary serverspaces get a floor so an empty space
      // still renders as a small circle.
      selfValue: utility
        ? massValue(subtreeDocs)
        : roots.length === 0
          ? 1
          : 0,
      subtreeDocs,
      lastActivityAt: lastActivity,
      children: utility ? [] : roots,
    });
  }
  spaces.sort((a, b) => a.name.localeCompare(b.name));

  return {
    kind: 'root',
    id: 'root',
    name: 'Practice',
    code: '',
    row: null,
    utility: false,
    selfValue: 0,
    subtreeDocs: spaces.reduce((n, s) => n + s.subtreeDocs, 0),
    lastActivityAt: null,
    children: spaces,
  };
}

export function layoutMap(root: MapDatum, size: number): MapNode {
  const h = hierarchy(root)
    .sum((d) => d.selfValue)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return pack<MapDatum>().size([size, size]).padding(5)(h);
}

// ── Heat: exponential decay over last activity, half-life 7 days ──────────
export function heat(lastActivityAt: string | null, now: number): number {
  if (!lastActivityAt) return 0;
  const days = (now - Date.parse(lastActivityAt)) / 86_400_000;
  if (!Number.isFinite(days)) return 0;
  if (days <= 0) return 1;
  return Math.pow(2, -days / 7);
}

// Perceptually ordered cool→warm ramp on the CVD-safe blue↔gold axis,
// lightness-monotonic (L 0.36 → 0.81), landing on the house gold. The dim
// cool end is deliberate: dormant matters recede into the near-black field.
// Color carries magnitude only — identity always comes from labels.
const HEAT_STOPS = ['#333c52', '#46587a', '#6f7f96', '#b08d5e', '#e8b84a'];
export const heatColor: (t: number) => string = piecewise(
  interpolateRgb,
  HEAT_STOPS,
);

// ── Pull: deadline urgency. One ring treatment per node, never more. ──────
export type Urgency =
  | { level: 'none' }
  | { level: 'soon'; daysLeft: number }   // pulsing ring
  | { level: 'overdue'; count: number };  // steady heavier ring

export function urgency(row: MapMatterRow, now: number): Urgency {
  if (row.overdue_count > 0) return { level: 'overdue', count: row.overdue_count };
  if (row.next_deadline) {
    const [y, m, d] = row.next_deadline.split('-').map(Number);
    const days = Math.round(
      (new Date(y, m - 1, d).getTime() - startOfDay(now)) / 86_400_000,
    );
    if (days <= 7) return { level: 'soon', daysLeft: Math.max(days, 0) };
  }
  // A manually flagged 'urgent' matter pulls even without a dated deadline.
  if (row.status === 'urgent') return { level: 'soon', daysLeft: 7 };
  return { level: 'none' };
}

const startOfDay = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export const STATUS_COLORS: Record<MatterStatus, string> = {
  active: '#d4a054',
  urgent: '#f87171',
  waiting: '#fbbf24',
  dormant: '#7e7a72',
  archived: '#5a5665',
};

export function formatDeadline(dateStr: string, now: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days = Math.round((date.getTime() - startOfDay(now)) / 86_400_000);
  const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (days < 0) return `${label} · ${-days}d overdue`;
  if (days === 0) return `${label} · today`;
  if (days === 1) return `${label} · tomorrow`;
  return `${label} · in ${days}d`;
}
