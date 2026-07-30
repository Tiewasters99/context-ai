// The Knowledge Map — the practice as one living field. Zoomable circle
// packing (d3.pack) over the serverspace → matter tree, driven by live
// ledger state from get_matter_map(). Two encodings and no more: fill
// temperature = activity recency (7-day half-life), and a single ring
// treatment for deadline pull (pulse ≤ 7 days, steady heavier ring when
// overdue). Radius = log document mass. Clicking a parent dives (URL
// syncs to /app/map/:code so browser back works); clicking a leaf opens
// its card; "Enter matter" lands on the existing working surface.
//
// Touch-first: there is no hover anywhere — tap zooms/selects, and the
// focused node's state reads out in the bottom card, which is also where
// inline ledger editing lives (Phase 3).

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowUpRight, CalendarClock, ChevronRight, ListTodo, Pencil, X,
} from 'lucide-react';
import { interpolateZoom } from 'd3-interpolate';
import Spinner from '@/components/ui/Spinner';
import PinToggle from '@/components/ui/PinToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import { useMatterMap, useSetMatterState, useMatterMapInvalidate } from '@/hooks/useMatterMap';
import { createMatterEvent, useMatterEventsInvalidate } from '@/hooks/useMatterEvents';
import {
  buildMapHierarchy, layoutMap, heat, heatColor, urgency, formatDeadline,
  STATUS_COLORS,
  type MapNode, type MatterStatus,
} from '@/lib/map-model';

const SIZE = 960;
const CENTER = SIZE / 2;
// Heat/urgency need a stable "now" per data load (render must stay pure, so
// it can't call Date.now() itself). react-query's dataUpdatedAt provides it;
// this module-scope stamp is only the pre-first-fetch fallback.
const LOADED_AT = Date.now();
const STATUSES: MatterStatus[] = ['active', 'urgent', 'waiting', 'dormant', 'archived'];

// ── container measurement, so label sizes hold up on a phone ─────────────
function useContainerScale(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const side = Math.max(320, Math.min(el.clientWidth, el.clientHeight || el.clientWidth));
      setScale(SIZE / side); // 1 screen px = `scale` viewBox units
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  return [ref, scale];
}

export default function KnowledgeMap() {
  const navigate = useNavigate();
  const { code } = useParams();
  const { data: rows, isLoading, error, dataUpdatedAt } = useMatterMap();
  const [containerRef, px] = useContainerScale(); // px = viewBox units per screen pixel

  const now = dataUpdatedAt || LOADED_AT;

  const { packedRoot, byCode } = useMemo(() => {
    if (!rows || rows.length === 0) return { packedRoot: null, byCode: null };
    const packed = layoutMap(buildMapHierarchy(rows), SIZE);
    const index = new Map<string, MapNode>();
    for (const d of packed.descendants()) {
      if (d.data.code) index.set(d.data.code, d);
      index.set(d.data.id, d);
    }
    return { packedRoot: packed, byCode: index };
  }, [rows]);

  const focus: MapNode | null =
    (code && byCode?.get(code)) || packedRoot || null;

  // Selection is keyed to the focus code, so diving/zooming clears it
  // without an effect; the node is re-resolved from the current layout so
  // a refetch never leaves the card holding a stale row.
  const [sel, setSel] = useState<{ key: string; id: string } | null>(null);
  const selected: MapNode | null =
    (sel && sel.key === (code ?? '') && byCode?.get(sel.id)) || null;
  const setSelected = useCallback(
    (node: MapNode | null) =>
      setSel(node ? { key: code ?? '', id: node.data.id } : null),
    [code],
  );
  const [editing, setEditing] = useState<MapNode | null>(null);

  // ── zoom animation: interpolateZoom between [cx, cy, width] views ──────
  const viewRef = useRef<[number, number, number]>([CENTER, CENTER, SIZE]);
  const [view, setView] = useState<[number, number, number]>([CENTER, CENTER, SIZE]);
  const reducedMotion = useMemo(
    () => typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  useEffect(() => {
    if (!focus) return;
    const target: [number, number, number] =
      focus.parent === null
        ? [CENTER, CENTER, SIZE]
        : [focus.x, focus.y, focus.r * 2.15];
    const from = viewRef.current;
    if (from[0] === target[0] && from[1] === target[1] && from[2] === target[2]) return;
    if (reducedMotion) {
      const raf = requestAnimationFrame(() => {
        viewRef.current = target;
        setView(target);
      });
      return () => cancelAnimationFrame(raf);
    }
    const interp = interpolateZoom(from, target);
    const duration = Math.min(850, Math.max(320, interp.duration * 0.9));
    let start: number | null = null;
    let raf = 0;
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (ts: number) => {
      if (start === null) start = ts;
      const t = Math.min(1, (ts - start) / duration);
      const v = interp(ease(t)) as [number, number, number];
      viewRef.current = v;
      setView(v);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // Re-run when the focus target moves (new focus, or relayout after refetch).
  }, [focus, reducedMotion]);

  const mapPath = useCallback(
    (node: MapNode) => (node.parent === null ? '/app/map' : `/app/map/${node.data.code}`),
    [],
  );

  const goUp = useCallback(() => {
    if (selected) { setSelected(null); return; }
    if (focus?.parent) navigate(mapPath(focus.parent));
  }, [selected, setSelected, focus, navigate, mapPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editing) { setEditing(null); return; }
      goUp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goUp, editing]);

  const handleNodeClick = useCallback((d: MapNode) => {
    if (d.data.utility) { navigate(`/app/serverspace/${d.data.id}`); return; }
    if (d === focus) { goUp(); return; }
    if (d.children && d.children.length > 0) { navigate(mapPath(d)); return; }
    setSelected(selected === d ? null : d);
  }, [focus, navigate, mapPath, goUp, selected, setSelected]);

  // ── states ──────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="h-full min-h-[60vh] flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }
  if (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const missingFn = /get_matter_map/.test(msg) && /schema cache|does not exist|find the function/i.test(msg);
    return (
      <CenteredNote title={missingFn ? 'The map needs migration 042' : 'The map could not load'}>
        {missingFn
          ? 'Run supabase/migrations/042_matter_state_ledger.sql in the Supabase SQL editor, then reload this page.'
          : msg}
      </CenteredNote>
    );
  }
  if (!packedRoot || !focus) {
    return (
      <CenteredNote title="Nothing to map yet">
        Create a serverspace and a matter, and the map will grow from there.
      </CenteredNote>
    );
  }

  const k = SIZE / view[2];
  const toScreen = (d: MapNode) => ({
    x: (d.x - view[0]) * k + CENTER,
    y: (d.y - view[1]) * k + CENTER,
    r: d.r * k,
  });

  const cardNode = selected ?? (focus.parent !== null ? focus : null);

  return (
    <div ref={containerRef} className="relative h-full min-h-[calc(100vh-3.25rem)] overflow-hidden select-none">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 w-full h-full cursor-zoom-out"
        onClick={goUp}
      >
        {packedRoot.descendants().map((d) => {
          if (d.parent === null) return null;
          const { x, y, r } = toScreen(d);
          if (r < 1.2) return null;
          if (x + r < -40 || x - r > SIZE + 40 || y + r < -40 || y - r > SIZE + 40) return null;

          const isMatter = d.data.kind === 'matter';
          const row = d.data.row;
          const hasChildren = !!d.children && d.children.length > 0;
          const t = heat(d.data.lastActivityAt, now);
          const color = heatColor(t);
          const urg = isMatter && row ? urgency(row, now) : ({ level: 'none' } as const);
          const isSelected = selected === d;

          let fill: string; let fillOpacity: number; let stroke: string; let strokeDash: string | undefined;
          if (d.data.utility) {
            fill = '#333c52'; fillOpacity = 0.26; stroke = 'rgba(255,255,255,0.14)'; strokeDash = `${4 * px} ${5 * px}`;
          } else if (!isMatter) {
            fill = '#ffffff'; fillOpacity = 0.02; stroke = 'rgba(255,255,255,0.10)';
          } else if (hasChildren) {
            fill = color; fillOpacity = 0.07; stroke = color;
          } else {
            fill = color; fillOpacity = 0.82; stroke = 'rgba(0,0,0,0.28)';
          }

          return (
            <g key={d.data.id}>
              <circle
                cx={x} cy={y} r={r}
                fill={fill} fillOpacity={fillOpacity}
                stroke={isSelected ? '#e8b84a' : stroke}
                strokeOpacity={isSelected ? 0.9 : isMatter && hasChildren ? 0.4 : 1}
                strokeWidth={(isSelected ? 2 : 1) * px}
                strokeDasharray={strokeDash}
                className="cursor-pointer"
                onClick={(e) => { e.stopPropagation(); handleNodeClick(d); }}
              />
              {urg.level !== 'none' && (
                <circle
                  cx={x} cy={y} r={r + 4 * px}
                  fill="none"
                  stroke="#f87171"
                  strokeWidth={(urg.level === 'overdue' ? 2.4 : 1.4) * px}
                  strokeOpacity={urg.level === 'overdue' ? 0.85 : 0.6}
                  className={urg.level === 'soon' ? 'km-pulse' : undefined}
                  pointerEvents="none"
                />
              )}
            </g>
          );
        })}

        {/* Labels: the current field only (children of focus), plus a leaf
            focus labels itself. Identity always comes from text, not color. */}
        {packedRoot.descendants().map((d) => {
          if (d.parent !== focus && d !== focus) return null;
          if (d === focus && d.children && d.children.length > 0) return null;
          if (d.parent === null) return null;
          const { x, y, r } = toScreen(d);
          if (r < 26 * px) return null;
          const fontPx = Math.max(11, Math.min(15, r / (3.6 * px)));
          const font = fontPx * px;
          const maxChars = Math.max(6, Math.floor((r * 2) / (font * 0.62)));
          const name = d.data.name.length > maxChars
            ? d.data.name.slice(0, maxChars - 1).trimEnd() + '…'
            : d.data.name;
          const isSpace = d.data.kind === 'serverspace';
          return (
            <text
              key={`label-${d.data.id}`}
              x={x} y={isSpace && d.children?.length ? y - r + font * 1.8 : y}
              textAnchor="middle" dominantBaseline="middle"
              fill="#f0ebe3" fillOpacity={d.data.utility ? 0.55 : 0.92}
              fontSize={font}
              style={{
                fontFamily: isSpace ? '"Playfair Display Variable", serif' : undefined,
                fontWeight: isSpace ? 500 : 450,
                letterSpacing: isSpace ? '0.02em' : '-0.01em',
                paintOrder: 'stroke',
                stroke: 'rgba(5,5,10,0.75)',
                strokeWidth: font / 5,
              }}
              pointerEvents="none"
            >
              {name}
            </text>
          );
        })}
      </svg>

      {/* Breadcrumb — also the zoom-out control */}
      <nav className="absolute top-3 left-3 z-20 flex items-center flex-wrap gap-0.5 max-w-[calc(100%-1.5rem)]">
        {focus.ancestors().reverse().map((a, i, arr) => (
          <span key={a.data.id} className="flex items-center gap-0.5">
            {i > 0 && <ChevronRight size={12} className="text-white/30" strokeWidth={2} />}
            <button
              onClick={() => navigate(mapPath(a))}
              className={`px-2 py-1 rounded-md text-[12px] transition-colors backdrop-blur-[20px] ${
                i === arr.length - 1
                  ? 'text-[#e8b84a] bg-[rgba(8,8,14,0.6)] font-medium'
                  : 'text-white/60 hover:text-white bg-[rgba(8,8,14,0.35)]'
              }`}
            >
              {a.data.name}
            </button>
          </span>
        ))}
      </nav>

      <Legend />

      {cardNode && (
        <FocusCard
          node={cardNode}
          now={now}
          onEnter={() =>
            cardNode.data.kind === 'matter'
              ? navigate(`/app/matterspace/${cardNode.data.id}`)
              : navigate(`/app/serverspace/${cardNode.data.id}`)
          }
          onEdit={cardNode.data.kind === 'matter' ? () => setEditing(cardNode) : undefined}
          onClose={() => (selected ? setSelected(null) : goUp())}
        />
      )}

      {editing && editing.data.row && (
        <MatterStateEditor node={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function CenteredNote({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="h-full min-h-[60vh] flex items-center justify-center px-6">
      <div className="glass-strong rounded-xl px-6 py-5 max-w-md">
        <h2 className="text-[15px] font-semibold text-[#f5f2ed]">{title}</h2>
        <p className="text-[13px] text-white/60 mt-1.5 leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

// ── the focused/selected node's readout + entry to inline editing ────────
function FocusCard({
  node, now, onEnter, onEdit, onClose,
}: {
  node: MapNode;
  now: number;
  onEnter: () => void;
  onEdit?: () => void;
  onClose: () => void;
}) {
  const row = node.data.row;
  const isMatter = node.data.kind === 'matter';
  const childCount = node.children?.length ?? 0;
  return (
    <div className="absolute bottom-16 md:bottom-5 left-1/2 -translate-x-1/2 z-30 w-[min(92vw,540px)]">
      <div className="glass-strong rounded-xl px-4 py-3.5">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              {isMatter && row && (
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: STATUS_COLORS[row.status] }}
                  title={row.status}
                />
              )}
              <h3 className="text-[14px] font-semibold text-[#f5f2ed] truncate">{node.data.name}</h3>
              {isMatter && row && (
                <span className="text-[11px] text-white/40 shrink-0">{row.status}</span>
              )}
            </div>
            {isMatter && row ? (
              <>
                <p className={`text-[13px] mt-1 leading-snug ${row.headline ? 'text-[#f5f1e8]' : 'text-white/35 italic'}`}>
                  {row.headline ?? 'No headline yet — edit to set one.'}
                </p>
                {row.next_action && (
                  <p className="flex items-center gap-1.5 text-[12px] text-white/65 mt-1.5">
                    <ListTodo size={13} className="text-[#d4a054] shrink-0" strokeWidth={1.75} />
                    <span className="truncate">
                      {row.next_action}
                      {row.next_action_owner && (
                        <span className="text-white/40"> — {row.next_action_owner}</span>
                      )}
                    </span>
                  </p>
                )}
                {(row.next_deadline || row.overdue_count > 0) && (
                  <p className="flex items-center gap-1.5 text-[12px] mt-1.5">
                    <CalendarClock size={13} className={row.overdue_count > 0 ? 'text-[#f87171]' : 'text-[#d4a054]'} strokeWidth={1.75} />
                    {row.overdue_count > 0 && (
                      <span className="text-[#f87171] font-medium">
                        {row.overdue_count} overdue
                      </span>
                    )}
                    {row.next_deadline && (
                      <span className="text-white/65 truncate">
                        {formatDeadline(row.next_deadline, now)}
                        {row.next_deadline_label && ` — ${row.next_deadline_label}`}
                      </span>
                    )}
                  </p>
                )}
                <p className="text-[11px] text-white/35 mt-1.5">
                  {row.doc_count} doc{row.doc_count === 1 ? '' : 's'}
                  {childCount > 0 && ` · ${childCount} sub-matter${childCount === 1 ? '' : 's'}`}
                </p>
              </>
            ) : (
              <p className="text-[12px] text-white/50 mt-1">
                {childCount} matter{childCount === 1 ? '' : 's'} · {node.data.subtreeDocs} docs
                {node.data.utility && ' · archive space'}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 -mr-1 rounded-md text-white/40 hover:text-white hover:bg-[rgba(255,255,255,0.08)] transition-colors shrink-0"
            aria-label="Close"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={onEnter}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[rgba(212,160,84,0.14)] text-[12px] font-medium text-[#e8b84a] hover:bg-[rgba(212,160,84,0.22)] transition-colors"
          >
            {isMatter ? 'Enter matter' : 'Open serverspace'}
            <ArrowUpRight size={13} strokeWidth={2} />
          </button>
          {onEdit && (
            <button
              onClick={onEdit}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] text-white/65 hover:text-white hover:bg-[rgba(255,255,255,0.06)] transition-colors"
            >
              <Pencil size={12} strokeWidth={1.75} />
              Edit state
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Phase 3: inline ledger editing. Every save goes through the
//    set_matter_state RPC (guaranteed ledger event); deadlines write to
//    the calendar (matter_events) so the map and Calendar tab agree. ─────
function MatterStateEditor({ node, onClose }: { node: MapNode; onClose: () => void }) {
  const row = node.data.row!;
  const navigate = useNavigate();
  const setState = useSetMatterState();
  const invalidateMap = useMatterMapInvalidate();
  const invalidateEvents = useMatterEventsInvalidate();
  const { cardRef, pinned, togglePin, isMobile } = useDraggableResizable('cs.map.editCard');

  const [status, setStatus] = useState<MatterStatus>(row.status);
  const [headline, setHeadline] = useState(row.headline ?? '');
  const [nextAction, setNextAction] = useState(row.next_action ?? '');
  const [owner, setOwner] = useState(row.next_action_owner ?? '');
  const [dlDate, setDlDate] = useState('');
  const [dlLabel, setDlLabel] = useState('');
  const [dlSaving, setDlSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Send only changed fields; '' clears (the RPC's nullif convention).
  const save = async () => {
    setErr(null);
    const diff = (val: string, orig: string | null) =>
      val === (orig ?? '') ? undefined : val;
    try {
      await setState.mutateAsync({
        matterId: row.id,
        patch: {
          status: status === row.status ? undefined : status,
          headline: diff(headline.trim(), row.headline),
          next_action: diff(nextAction.trim(), row.next_action),
          next_action_owner: diff(owner.trim(), row.next_action_owner),
        },
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const addDeadline = async () => {
    if (!dlDate) return;
    setDlSaving(true);
    setErr(null);
    try {
      await createMatterEvent({
        matterspace_id: row.id,
        title: dlLabel.trim() || 'Deadline',
        event_date: dlDate,
        event_time: null,
        event_type: 'deadline',
        notes: null,
      });
      invalidateEvents();
      invalidateMap();
      setDlDate('');
      setDlLabel('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDlSaving(false);
    }
  };

  const field = 'w-full px-2.5 py-1.5 rounded-md bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.12)] text-[13px] text-[#f5f1e8] placeholder:text-white/30 focus:outline-none focus:border-[rgba(232,184,74,0.5)] transition-colors';
  const label = 'block text-[11px] font-medium text-[#8a8693] uppercase tracking-wider mb-1';

  return (
    <div className={`fixed inset-0 z-40 flex ${isMobile ? 'items-end' : 'items-center'} justify-center`}>
      <div className="absolute inset-0 bg-black/55" onClick={onClose} />
      <div
        ref={cardRef}
        className={`relative glass-strong w-[min(94vw,440px)] px-5 pb-5 pt-3 ${
          isMobile ? 'rounded-t-xl' : 'rounded-xl cursor-grab'
        }`}
      >
        {/* Ribbon: close · drag pill · pin */}
        <div className={`items-center justify-between mb-3 ${isMobile ? 'hidden' : 'flex'}`}>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X size={14} strokeWidth={2} />
          </button>
          <div className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors" title="Drag to move" />
          <PinToggle pinned={pinned} onToggle={togglePin} />
        </div>
        {isMobile && (
          <div className="flex justify-end mb-2">
            <button onClick={onClose} className="p-1.5 rounded-md text-white/60" aria-label="Close">
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        )}

        <h3 className="text-[14px] font-semibold text-[#f5f2ed] truncate">{node.data.name}</h3>
        <p className="text-[11px] text-white/40 mb-4">Ledger state — every save is logged.</p>

        <div className="space-y-3.5">
          <div>
            <span className={label}>Status</span>
            <div className="flex flex-wrap gap-1.5">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  className={`px-2.5 py-1 rounded-full text-[12px] border transition-colors ${
                    status === s
                      ? 'border-[rgba(232,184,74,0.6)] text-[#e8b84a] bg-[rgba(212,160,84,0.1)]'
                      : 'border-[rgba(255,255,255,0.12)] text-white/55 hover:text-white'
                  }`}
                >
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
                    style={{ backgroundColor: STATUS_COLORS[s] }}
                  />
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className={label}>Headline</span>
            <input
              className={field}
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              placeholder="Horski deposition 7/31 — outline in progress"
            />
          </div>
          <div className="grid grid-cols-[1fr_110px] gap-2">
            <div>
              <span className={label}>Next action</span>
              <input
                className={field}
                value={nextAction}
                onChange={(e) => setNextAction(e.target.value)}
                placeholder="Finish outline"
              />
            </div>
            <div>
              <span className={label}>Owner</span>
              <input
                className={field}
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="you / agent"
              />
            </div>
          </div>

          <div className="pt-1 border-t border-[rgba(255,255,255,0.08)]">
            <span className={`${label} mt-2`}>
              Deadline{row.next_deadline ? ` — next: ${row.next_deadline_label ?? row.next_deadline}` : ''}
            </span>
            <div className="grid grid-cols-[130px_1fr_auto] gap-2">
              <input
                type="date"
                className={field}
                value={dlDate}
                onChange={(e) => setDlDate(e.target.value)}
              />
              <input
                className={field}
                value={dlLabel}
                onChange={(e) => setDlLabel(e.target.value)}
                placeholder="What's due"
              />
              <button
                onClick={addDeadline}
                disabled={!dlDate || dlSaving}
                className="px-3 py-1.5 rounded-md text-[12px] font-medium text-[#e8b84a] bg-[rgba(212,160,84,0.12)] hover:bg-[rgba(212,160,84,0.2)] disabled:opacity-40 transition-colors"
              >
                Add
              </button>
            </div>
            <button
              onClick={() => navigate(`/app/matterspace/${row.id}?tab=Calendar`)}
              className="text-[11px] text-white/40 hover:text-[#e8b84a] mt-1.5 transition-colors"
            >
              Full calendar →
            </button>
          </div>
        </div>

        {err && <p className="text-[12px] text-[#f87171] mt-3">{err}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-md text-[12px] text-white/60 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={setState.isPending}
            className="px-4 py-1.5 rounded-md text-[12px] font-semibold text-[#0a0a10] bg-[#d4a054] hover:bg-[#e8b84a] disabled:opacity-50 transition-colors"
          >
            {setState.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="absolute bottom-5 right-4 z-20 hidden md:flex flex-col gap-1.5 items-end pointer-events-none">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-white/40">quiet</span>
        <div
          className="w-24 h-1.5 rounded-full"
          style={{ background: 'linear-gradient(to right, #333c52, #46587a, #6f7f96, #b08d5e, #e8b84a)' }}
        />
        <span className="text-[10px] text-white/40">active</span>
      </div>
      <div className="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="#f87171" strokeWidth="1.2" className="km-pulse" />
        </svg>
        <span className="text-[10px] text-white/40">deadline ≤ 7 days</span>
      </div>
      <div className="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="#f87171" strokeWidth="2" strokeOpacity="0.85" />
        </svg>
        <span className="text-[10px] text-white/40">overdue</span>
      </div>
    </div>
  );
}
