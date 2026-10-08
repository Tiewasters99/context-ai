import { useState, useMemo, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import {
  Home,
  Plus,
  ChevronRight,
  ChevronDown,
  Settings,
  LogOut,
  Bot,
  PanelLeft,
  Users,
  Trash2,
  Pencil,
  Plug,
  UserPlus,
  Folder,
  LayoutGrid,
  ListChecks,
  Lock,
  Stamp,
} from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  pointerWithin,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { useServerspaces, useServerspacesRefresh } from '@/hooks/useServerspaces';
import { ensureMySecureSpace } from '@/lib/securechat';
import { runInAssistant } from '@/lib/assistant-bus';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';
import ContextMenu, { type ContextMenuState } from '@/components/ui/ContextMenu';
import { getVaultClip, pasteVaultClip } from '@/lib/vault-clipboard';
import NewMatterModal, { type NewMatterContext } from '@/components/matter/NewMatterModal';
import DeleteMatterModal, { type DeleteMatterTarget, collectDescendantIds } from '@/components/matter/DeleteMatterModal';
import ShareModal from '@/components/serverspace/ShareModal';
import NewServerspaceModal from '@/components/serverspace/NewServerspaceModal';
import SecureSpacesSection from '@/components/securespace/SecureSpacesSection';
import SealMatterModal, { type SealTarget } from '@/components/securespace/SealMatterModal';
import { SiteSearchMount } from '@/components/search/SiteSearch';
import { MoveMatterConfirm, MovedToast, MOVED_TOAST_MS } from '@/components/matter/MoveMatterConfirm';
import { AGENT_TOKENS_KEY, useAgentTokens } from '@/hooks/useAgentTokens';
import { agentLabel, isLiveAgent, listAgentTokens } from '@/lib/agentTokens';
import { isAgentsNotReady } from '@/lib/agentTasks';
import {
  ancestorsAbove,
  computeMoveImpact,
  movedText,
  moveWords,
  withParent,
  type MoveAgent,
  type MoveWords,
} from '@/lib/matter-move';

// Drag-and-drop ids are encoded as "matter:<uuid>" or "ss-root:<uuid>" so
// dragEnd can tell whether the drop target is a matter (nest underneath)
// or a serverspace's top-level area (re-parent to null inside that serverspace).
// The SecureSpaces shelf at the bottom of the rail is a third target: dropping
// a matter there doesn't re-parent it, it opens the seal confirmation.
type DragData = { kind: 'matter'; matterId: string; serverspaceId: string };
type DropData =
  | { kind: 'matter'; matterId: string; serverspaceId: string }
  | { kind: 'ss-root'; serverspaceId: string }
  | { kind: 'securespaces' };

// A re-parent: which matter, from where, to where. Kept so the same update
// can be made after the confirmation, and undone afterwards.
interface MatterMove {
  matterId: string;
  serverspaceId: string;
  oldParentId: string | null;
  newParentId: string | null;
  /** "Moved Teman into UKC", said by the Undo toast. */
  doneText: string;
}

interface SidebarProps {
  onToggleAssistant?: () => void;
  // Real open/closed state of the assistant panel, owned by MainLayout — the
  // sidebar used to track its own copy, which desynced when the panel was
  // closed from its own X.
  assistantOpen?: boolean;
  // Rendered inside MainLayout's off-canvas drawer on phones. In that mode
  // the sidebar is never collapsed (the drawer either covers the screen or
  // is slid away entirely) and takes a phone-friendly width.
  isMobile?: boolean;
}

export default function Sidebar({ onToggleAssistant, assistantOpen = false, isMobile = false }: SidebarProps) {
  const { user, signOut } = useAuth();
  const location = useLocation();
  // An open brief in the Brief Desk needs the width for the brief, the
  // authority beside it and the cite table (Eden, 09-27: "that side bar is just
  // in the way here"). So the rail folds to its icons on entering a brief and
  // unfolds on leaving the desk; the toggle still opens it while there.
  // Adjusted during render on a route change, React's pattern for state that
  // follows a prop, rather than in an effect.
  const onBrief = /^\/app\/brief\/[^/]+/.test(location.pathname);
  const [collapsedState, setCollapsedState] = useState(onBrief);
  const [wasOnBrief, setWasOnBrief] = useState(onBrief);
  if (onBrief !== wasOnBrief) {
    setWasOnBrief(onBrief);
    setCollapsedState(onBrief);
  }
  // On mobile the rail is always full-width inside the drawer.
  const collapsed = isMobile ? false : collapsedState;
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [showNewServerspace, setShowNewServerspace] = useState(false);

  const [newMatterContext, setNewMatterContext] = useState<NewMatterContext | null>(null);
  // When the New-matter modal was opened from the SecureSpaces shelf, the
  // matter is born sealed (ai_tier B) instead of being sealed after the fact.
  const [newMatterSealed, setNewMatterSealed] = useState(false);
  const [sealTarget, setSealTarget] = useState<SealTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteMatterTarget | null>(null);
  const [expandedMatters, setExpandedMatters] = useState<Set<string>>(new Set());
  const [shareTarget, setShareTarget] = useState<{ scope: 'serverspace' | 'matterspace'; id: string; name: string } | null>(null);
  // Why SecureChat didn't open. A brand-new account has no serverspace, and
  // the button used to do nothing at all — the one onboarding step in the
  // product is "create a serverspace", so say that instead of nothing.
  const [secureChatNotice, setSecureChatNotice] = useState<string | null>(null);

  const { data: serverspaces = [] } = useServerspaces();
  const refreshServerspaces = useServerspacesRefresh();

  // Drag-and-drop state for re-parenting matters in the sidebar tree.
  const [dragging, setDragging] = useState<DragData | null>(null);
  const [reparentError, setReparentError] = useState<string | null>(null);
  // Press and HOLD to drag (Eden, 09-30). It used to be any 5px of movement,
  // so a click that slipped while the button was down picked a matter up and
  // dropped it on its neighbour: that is how Teman landed inside UKC. Now
  // the row must be held still (within 5px) for a quarter of a second before
  // it lifts; moving sooner cancels the drag, and the press stays a click.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  // Every move is asked about first, saying from where to where and what it
  // changes about who can see the matter (lib/matter-move.ts); every move
  // can be undone for ten seconds.
  const queryClient = useQueryClient();
  useAgentTokens();   // warm the agents read the move check needs
  const [checkingMove, setCheckingMove] = useState(false);
  const [pendingMove, setPendingMove] = useState<{ move: MatterMove; words: MoveWords } | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [movedToast, setMovedToast] = useState<MatterMove | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Descendants of the currently-dragged matter — used to grey out invalid
  // drop targets (a matter can't be dropped under one of its own children).
  const draggingDescendants = useMemo(() => {
    if (!dragging) return new Set<string>();
    return new Set(collectDescendantIds(serverspaces, dragging.matterId));
  }, [dragging, serverspaces]);

  // Flat lookup for the drag overlay's display name.
  const draggingMatterName = useMemo(() => {
    if (!dragging) return null;
    for (const s of serverspaces) {
      const m = s.matterspaces.find((x) => x.id === dragging.matterId);
      if (m) return m.name;
    }
    return null;
  }, [dragging, serverspaces]);

  const onDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as DragData | undefined;
    if (data?.kind === 'matter') {
      setDragging(data);
      setReparentError(null);
    }
  };

  const onDragEnd = async (e: DragEndEvent) => {
    const src = e.active.data.current as DragData | undefined;
    const dst = e.over?.data.current as DropData | undefined;
    setDragging(null);
    if (!src || !dst) return;

    // Dropped on the SecureSpaces shelf: not a re-parent — open the seal
    // confirmation for this matter (no-op if it's already sealed).
    if (dst.kind === 'securespaces') {
      const m = serverspaces
        .flatMap((s) => s.matterspaces)
        .find((x) => x.id === src.matterId);
      if (!m || m.ai_tier !== 'A') return;
      // collectDescendantIds includes the matter itself.
      const descendantCount = collectDescendantIds(serverspaces, src.matterId).length - 1;
      setSealTarget({
        matterId: src.matterId,
        matterName: m.name,
        mode: 'seal',
        descendantCount,
      });
      return;
    }

    // Resolve target: matter row → nest under that matter; ss-root → top-level.
    const newParentId = dst.kind === 'matter' ? dst.matterId : null;
    const targetServerspaceId = dst.serverspaceId;

    // No-op: dropped onto self, or onto its current parent.
    if (src.matterId === newParentId) return;
    const currentParent = serverspaces
      .flatMap((s) => s.matterspaces)
      .find((m) => m.id === src.matterId)?.parent_matterspace_id ?? null;
    if (currentParent === newParentId && src.serverspaceId === targetServerspaceId) return;

    // Cross-serverspace drops are blocked by the matterspaces parent-check
    // trigger (migration 008). Catch in UI instead of letting the user see
    // a raw db error.
    if (src.serverspaceId !== targetServerspaceId) {
      setReparentError('Matters can only be re-parented within the same serverspace.');
      return;
    }

    // Cycle prevention: can't drop a matter under one of its own descendants.
    if (newParentId && draggingDescendants.has(newParentId)) {
      setReparentError('Cannot nest a matter under one of its own sub-matters.');
      return;
    }

    // One move at a time: a second drop while the first is being checked or
    // confirmed is ignored.
    if (checkingMove || pendingMove || !user) return;
    const space = serverspaces.find((s) => s.id === targetServerspaceId);
    if (!space) return;
    const matters = space.matterspaces;
    const nameOf = (id: string) =>
      matters.find((m) => m.id === id)?.name ?? 'a matter above it that you cannot open';
    const name = nameOf(src.matterId);
    const move: MatterMove = {
      matterId: src.matterId,
      serverspaceId: targetServerspaceId,
      oldParentId: currentParent,
      newParentId,
      doneText: movedText(name, newParentId ? nameOf(newParentId) : space.name, !newParentId),
    };

    // Every move is asked about (Eden, 10-02: moving is for fixing a
    // misfiled matter), and the card says from where to where. What can be
    // read about access first is added to it.
    setCheckingMove(true);
    let words: MoveWords;
    try {
      // Who is shared above the matter now, and above it after the move.
      // Only matters in the tree are asked for: row-level security returns
      // nothing (not an error) for a matter this account cannot open, so an
      // empty answer there would read as "nobody" when it means "unknown".
      const ids = [...new Set([
        src.matterId,
        ...ancestorsAbove(matters, src.matterId).ids,
        ...ancestorsAbove(withParent(matters, src.matterId, newParentId), src.matterId).ids,
      ])];
      const [mm, sm, agents] = await Promise.all([
        supabase
          .from('matterspace_members')
          .select('matterspace_id, user_id, user:profiles(email, display_name)')
          .in('matterspace_id', ids),
        supabase.from('serverspace_members').select('user_id').eq('serverspace_id', targetServerspaceId),
        loadAgentsForMove(),
      ]);
      const membersOf = new Map<string, string[] | null>();
      const labels = new Map<string, string>();
      if (!mm.error) {
        for (const id of ids) membersOf.set(id, []);
        for (const r of (mm.data ?? []) as Array<{ matterspace_id: string; user_id: string; user: unknown }>) {
          membersOf.get(r.matterspace_id)?.push(r.user_id);
          const u = (Array.isArray(r.user) ? r.user[0] : r.user) as { email?: string | null; display_name?: string | null } | null;
          labels.set(r.user_id, u?.display_name || u?.email || 'someone');
        }
      }
      const impact = computeMoveImpact({
        matters,
        matterId: src.matterId,
        newParentId,
        membersOf,
        serverspaceMembers: sm.error ? null : (sm.data ?? []).map((r: { user_id: string }) => r.user_id),
        me: user.id,
        agents,
      });
      words = moveWords(impact, nameOf, (u) => labels.get(u) ?? 'someone', space.name);
    } catch (err) {
      // The reads failed: the same card, with every sharing list and the
      // agents marked as not checked, rather than moving blind.
      console.error('move check:', err);
      words = moveWords(
        computeMoveImpact({
          matters,
          matterId: src.matterId,
          newParentId,
          membersOf: new Map(),
          serverspaceMembers: null,
          me: user.id,
          agents: null,
        }),
        nameOf,
        () => 'someone',
        space.name,
      );
    } finally {
      setCheckingMove(false);
    }

    setMoveError(null);
    setPendingMove({ move, words });
  };

  // The signed-in user's own live agents, for the move check. null = they
  // could not be read (the dialog then says so); no agents feature yet = none.
  const loadAgentsForMove = async (): Promise<MoveAgent[] | null> => {
    try {
      const list = await queryClient.fetchQuery({ queryKey: AGENT_TOKENS_KEY, queryFn: listAgentTokens, staleTime: 30_000 });
      return list.filter((a) => isLiveAgent(a)).map((a) => ({
        id: a.id,
        label: agentLabel(a),
        matter_scope: a.matter_scope,
        scope_all: a.scope_all,
      }));
    } catch (err) {
      return isAgentsNotReady(err) ? [] : null;
    }
  };

  // The one write a move (or its undo) makes. Returns an error message, or null.
  const applyMove = async (move: MatterMove, parentId: string | null): Promise<string | null> => {
    const { error } = await supabase
      .from('matterspaces')
      .update({ parent_matterspace_id: parentId })
      .eq('id', move.matterId);
    if (error) return error.message;
    // Expand the destination so the user immediately sees the moved matter.
    if (parentId) {
      setExpandedMatters((prev) => new Set(prev).add(parentId));
    } else {
      setExpandedSpaces((prev) => new Set(prev).add(move.serverspaceId));
    }
    await refreshServerspaces();
    return null;
  };

  const showMovedToast = (move: MatterMove) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setUndoBusy(false);
    setMovedToast(move);
    toastTimer.current = setTimeout(() => setMovedToast(null), MOVED_TOAST_MS);
  };

  const dismissMovedToast = () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
    setMovedToast(null);
  };

  const confirmMove = async () => {
    if (!pendingMove || moveBusy) return;
    setMoveBusy(true);
    setMoveError(null);
    const error = await applyMove(pendingMove.move, pendingMove.move.newParentId);
    setMoveBusy(false);
    if (error) { setMoveError(`Not moved: ${error}`); return; }
    const move = pendingMove.move;
    setPendingMove(null);
    showMovedToast(move);
  };

  const undoMove = async () => {
    if (!movedToast || undoBusy) return;
    // Hold the toast while the undo is written, so it cannot time out mid-write.
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setUndoBusy(true);
    const error = await applyMove(movedToast, movedToast.oldParentId);
    setUndoBusy(false);
    dismissMovedToast();
    if (error) setReparentError(`Could not undo the move: ${error}`);
  };

  const openNewMatter = (
    serverspaceId: string,
    parentMatterId: string | null,
    contextLabel: string,
  ) => {
    setNewMatterContext({ serverspaceId, parentMatterId, contextLabel });
  };

  const toggleMatter = (id: string) => {
    setExpandedMatters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openDeleteMatter = (matterId: string, matterName: string) => {
    const descendantIds = collectDescendantIds(serverspaces, matterId);
    setDeleteTarget({ matterId, matterName, descendantIds });
  };

  const displayName = user?.user_metadata?.display_name ?? user?.email ?? 'User';

  const toggleExpanded = (id: string) => {
    setExpandedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const isActive = (path: string) => location.pathname === path;

  const sidebarWidth = isMobile ? 'w-[82vw] max-w-[20rem]' : collapsed ? 'w-16' : 'w-64';

  return (
    <aside
      // On a phone the sidebar lives inside a fixed drawer and must fill
      // THAT, not the screen: 100vh on iOS is the viewport with Safari's
      // bars collapsed, so an h-screen sidebar ran past the drawer by the
      // height of the toolbar — and Sign Out, at the bottom, sat under it
      // with nothing to scroll (2026-10-07).
      className={`${sidebarWidth} ${isMobile ? 'h-full' : 'h-screen'} flex flex-col shrink-0 transition-all duration-200 ease-in-out border-r border-[rgba(255,255,255,0.08)] backdrop-blur-[30px]`}
      style={{ backgroundColor: 'rgba(8, 8, 14, 0.82)' }}
    >
      {/* Brand + Collapse Toggle */}
      <div className="flex items-center justify-between px-4 h-13 border-b border-[rgba(255,255,255,0.06)]">
        {!collapsed && (
          <span className="text-[15px] font-semibold text-white tracking-tight">
            Context<span className="text-[#d4a054]">spaces</span><span className="text-white">.ai</span>
          </span>
        )}
        {!isMobile && (
          <button
            onClick={() => setCollapsedState(!collapsedState)}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.04)] text-white/70 transition-colors"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <PanelLeft size={16} strokeWidth={1.75} />
          </button>
        )}
      </div>

      {/* User Section */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[rgba(255,255,255,0.06)]">
        <div className="w-7 h-7 rounded-full bg-[#e8b84a] flex items-center justify-center text-[11px] font-semibold text-[#0e0e12] shrink-0">
          {displayName[0]?.toUpperCase() ?? 'U'}
        </div>
        {!collapsed && (
          <div className="flex items-center justify-between flex-1 min-w-0">
            <span className="text-[13px] font-medium text-white truncate">
              {displayName}
            </span>
            <Link
              to="/app/settings"
              className="p-1 rounded-md hover:bg-[rgba(255,255,255,0.04)] text-white/70 transition-colors"
            >
              <Settings size={14} strokeWidth={1.75} />
            </Link>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-2.5">
        {/* My Contextspace */}
        <Link
          to="/app"
          className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors ${
            isActive('/app')
              ? 'bg-[#16161d] text-white font-medium'
              : 'text-white hover:bg-[rgba(255,255,255,0.04)]'
          }`}
        >
          <Home size={15} className="shrink-0" strokeWidth={1.75} />
          {!collapsed && <span>My Contextspace</span>}
        </Link>

        {/* Find a document by name, across every matter. Also Ctrl/Cmd+K,
            which is what makes it reachable from the Vault — the Vault covers
            this rail entirely — and why it is mounted even when collapsed. */}
        <SiteSearchMount collapsed={collapsed} />

        {/* The Assistant — the one door to everything else: it explains how
            the place works and, on request, does the work. It sits up here
            with the rooms rather than down with the account plumbing. */}
        <button
          onClick={() => onToggleAssistant?.()}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors mt-px ${
            assistantOpen
              ? 'bg-[rgba(212,160,84,0.08)] text-[#e8b84a]'
              : 'text-white hover:bg-[rgba(255,255,255,0.04)]'
          }`}
        >
          <Bot size={15} className="shrink-0" strokeWidth={1.75} />
          {!collapsed && <span>Assistant</span>}
        </button>

        {/* Agents (2026-09-25): every connected AI and every task handed to
            one — the front door for tasks. Core ('agentTasks' in
            lib/surfaces.mjs), so it needs no plan filter here. Not the frozen
            agent-charters room at /app/agents. */}
        <Link
          to="/app/agent-tasks"
          className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors mt-px ${
            location.pathname.startsWith('/app/agent-tasks')
              ? 'bg-[#16161d] text-white font-medium'
              : 'text-white hover:bg-[rgba(255,255,255,0.04)]'
          }`}
          title="Every connected AI, and the tasks you have handed them"
        >
          <ListChecks size={15} className="shrink-0" strokeWidth={1.75} />
          {!collapsed && <span>Agents</span>}
        </Link>

        {/* The Brief Desk (2026-09-27): Eden asked for it as a door of its
            own — "Open Brief Desk, import brief, open brief, cite-check".
            /app/brief is claimed by no surface in lib/surfaces.mjs, so it is
            open on every plan, like the dashboard. */}
        <Link
          to="/app/brief"
          className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors mt-px ${
            location.pathname.startsWith('/app/brief')
              ? 'bg-[#16161d] text-white font-medium'
              : 'text-white hover:bg-[rgba(255,255,255,0.04)]'
          }`}
          title="Import a brief, edit it, and check every cite"
        >
          <Stamp size={15} className="shrink-0" strokeWidth={1.75} />
          {!collapsed && <span>Brief Desk</span>}
        </Link>

        {/* The top level is deliberately short (2026-09-08): home, the
            Assistant, Agents (09-25), the Suite. Calendar, the Mediation Center, the Student
            Hub and The Office keep their routes and are reached from the
            Productivity Suite — every tool a room, not every room a door.
            The Document Builder is still a stub (/app/document-builder).

            Plan gating (2026-09-19): because of that, every entry on this
            rail is core — My Contextspace, the Assistant panel and the
            SecureSpaces shelf have no gated route at all, and the Productivity
            Suite, Connections and Settings are core surfaces in lib/plan.ts.
            So there is nothing here to hide and no filter to write. If a
            non-core room is ever promoted to the rail, give it a surface in
            lib/plan.ts and wrap its entry in surfacePresentation(...) — do
            not re-decide it here. */}

        {/* Productivity Suite */}
        <Link
          to="/app/suite"
          className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors mt-px ${
            isActive('/app/suite')
              ? 'bg-[#16161d] text-white font-medium'
              : 'text-white hover:bg-[rgba(255,255,255,0.04)]'
          }`}
        >
          <LayoutGrid size={15} className="shrink-0" strokeWidth={1.75} />
          {!collapsed && <span>Productivity Suite</span>}
        </Link>

        {/* Serverspaces Header */}
        <div className="flex items-center justify-between mt-6 mb-1.5 px-3">
          {!collapsed && (
            <span className="text-[11px] font-semibold text-white/70 uppercase tracking-wider">
              Serverspaces
            </span>
          )}
          <button
            onClick={() => setShowNewServerspace(true)}
            className="p-0.5 rounded hover:bg-[rgba(255,255,255,0.04)] text-white/70 hover:text-[#e8b84a] transition-colors"
            aria-label="Create new serverspace"
            title="Add new Serverspace"
          >
            <Plus size={14} strokeWidth={1.75} />
          </button>
        </div>

        {/* Serverspace List — wrapped in DndContext so matters can be
            drag-and-dropped between parents within the same serverspace. */}
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
        {checkingMove && !collapsed && (
          <div className="mx-2 mb-2 px-2 py-1.5 rounded-md border border-white/10 bg-white/[0.03] text-[11px] text-white/60 leading-snug">
            Checking who can see it…
          </div>
        )}
        {reparentError && !collapsed && (
          <div className="mx-2 mb-2 px-2 py-1.5 rounded-md border border-red-400/30 bg-red-400/10 text-[11px] text-red-300 leading-snug">
            {reparentError}
            <button
              onClick={() => setReparentError(null)}
              className="float-right text-red-200 hover:text-red-100 -mt-0.5"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        <div className="space-y-px">
          {serverspaces.map((space) => {
            const isExpanded = expandedSpaces.has(space.id);
            return (
              <div key={space.id}>
                <div
                  className={`group flex items-center gap-1 rounded-md transition-colors ${
                    isActive(`/app/serverspace/${space.id}`)
                      ? 'bg-[#16161d] text-white'
                      : 'text-white hover:bg-[rgba(255,255,255,0.04)]'
                  }`}
                >
                  <button
                    onClick={() => toggleExpanded(space.id)}
                    className={`flex-1 flex items-center gap-2.5 px-3 py-2 text-[13px] text-left min-w-0 ${
                      isActive(`/app/serverspace/${space.id}`) ? 'font-medium' : ''
                    }`}
                  >
                    <Users size={15} className="shrink-0" strokeWidth={1.75} />
                    {!collapsed && (
                      <>
                        <span className="flex-1 truncate">{space.name}</span>
                        {isExpanded ? (
                          <ChevronDown size={13} className="text-white/70 shrink-0" />
                        ) : (
                          <ChevronRight size={13} className="text-white/70 shrink-0" />
                        )}
                      </>
                    )}
                  </button>
                  {!collapsed && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setShareTarget({ scope: 'serverspace', id: space.id, name: space.name }); }}
                      className="p-1.5 mr-1.5 rounded text-white/30 opacity-0 group-hover:opacity-100 hover:text-[#e8b84a] hover:bg-[rgba(255,255,255,0.04)] transition-all shrink-0"
                      aria-label="Share serverspace"
                      title="Share serverspace"
                    >
                      <UserPlus size={13} strokeWidth={2} />
                    </button>
                  )}
                </div>

                {/* Matterspaces — recursive tree, wrapped in a droppable so
                    matters dragged here land as top-level under this serverspace. */}
                {isExpanded && !collapsed && (
                  <ServerspaceDropZone
                    serverspaceId={space.id}
                    dragging={dragging}
                  >
                    {buildMatterTree(space.matterspaces).map((node) => (
                      <MatterNode
                        key={node.matter.id}
                        node={node}
                        ancestorLabel={space.name}
                        serverspaceId={space.id}
                        expandedMatters={expandedMatters}
                        toggleMatter={toggleMatter}
                        onAddChild={openNewMatter}
                        onDelete={openDeleteMatter}
                        onShare={(id, name) => setShareTarget({ scope: 'matterspace', id, name })}
                        isActive={isActive}
                        dragging={dragging}
                        draggingDescendants={draggingDescendants}
                        inheritedSealed={false}
                      />
                    ))}
                    <button
                      onClick={() => openNewMatter(space.id, null, space.name)}
                      className="flex items-center gap-1.5 w-full px-2.5 py-1.5 rounded-md text-[12px] text-white/50 hover:bg-[rgba(255,255,255,0.04)] hover:text-[#e8b84a] transition-colors text-left"
                    >
                      <Plus size={11} strokeWidth={2} />
                      <span>New matter</span>
                    </button>
                  </ServerspaceDropZone>
                )}
              </div>
            );
          })}
        </div>

        {/* SecureSpaces — sealed matters shelf (Beta). Lives inside the
            DndContext so a matter dragged from the tree above can be dropped
            here to seal it. */}
        <SecureSpacesSection
          serverspaces={serverspaces}
          collapsed={collapsed}
          matterDragActive={!!dragging}
          isActive={isActive}
          onNewSecureSpace={(serverspaceId, serverspaceName) => {
            setNewMatterSealed(true);
            setNewMatterContext({
              serverspaceId,
              parentMatterId: null,
              contextLabel: serverspaceName,
            });
          }}
          onUnseal={(row) =>
            setSealTarget({
              matterId: row.matter.id,
              matterName: row.matter.name,
              mode: 'unseal',
              descendantCount: row.descendantCount,
            })
          }
          // The same dialog the SecureChat notice offers, so the shelf's two
          // dead ends on a brand-new account both lead to the one step that
          // fixes them.
          onCreateServerspace={() => setShowNewServerspace(true)}
          onOpenSecureChat={() => {
            // Find-or-create the born-sealed personal room, then hand the
            // Assistant a promptless command: MainLayout opens the panel,
            // Assistant scopes to the room, and no model call is spent
            // until the user actually says something.
            void (async () => {
              if (serverspaces.length === 0) {
                setSecureChatNotice(
                  'SecureChat lives inside a serverspace, and you don’t have one yet.',
                );
                return;
              }
              setSecureChatNotice(null);
              try {
                const room = await ensureMySecureSpace(serverspaces[0].id);
                await refreshServerspaces();
                runInAssistant({ matterId: room.id, matterName: room.name, sealed: true });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error('SecureChat:', message);
                setSecureChatNotice(`SecureChat could not open: ${message}`);
              }
            })();
          }}
        />
        {secureChatNotice && !collapsed && (
          <div
            className="mx-2 mt-1.5 rounded-md border px-2.5 py-2 text-[11px] leading-snug text-white/65"
            style={{ borderColor: 'rgba(90,168,143,0.35)', backgroundColor: 'rgba(90,168,143,0.07)' }}
          >
            {secureChatNotice}
            {serverspaces.length === 0 && (
              <button
                onClick={() => {
                  setSecureChatNotice(null);
                  setShowNewServerspace(true);
                }}
                className="block mt-1 font-medium transition-colors hover:text-[#e8b84a]"
                style={{ color: '#5aa88f' }}
              >
                Create a serverspace →
              </button>
            )}
          </div>
        )}
        <DragOverlay>
          {dragging && draggingMatterName && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#1c1c26] border border-[#e8b84a]/40 text-[12px] text-[#f5f1e8] shadow-lg shadow-black/40">
              <Folder size={12} className="text-[#d4a054]" strokeWidth={1.75} />
              <span className="font-medium">{draggingMatterName}</span>
            </div>
          )}
        </DragOverlay>
        </DndContext>
      </nav>

      {/* Bottom Actions — account plumbing, not rooms. Clears the phone's
          home indicator, so the last row is a tap target, not a gesture bar. */}
      <div
        className="border-t border-[rgba(255,255,255,0.06)] p-2.5 space-y-px shrink-0"
        style={isMobile ? { paddingBottom: 'calc(0.625rem + env(safe-area-inset-bottom))' } : undefined}
      >
        <Link
          to="/app/connections"
          className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors ${
            location.pathname.startsWith('/app/connections')
              ? 'bg-[#16161d] text-white font-medium'
              : 'text-white hover:bg-[rgba(255,255,255,0.04)]'
          }`}
          title="Connect Contextspaces to Claude, Gmail, and more"
        >
          <Plug size={15} className="shrink-0" strokeWidth={1.75} />
          {!collapsed && <span>Connections</span>}
        </Link>

        <Link
          to="/app/settings"
          className="flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] text-white hover:bg-[rgba(255,255,255,0.04)] transition-colors"
        >
          <Settings size={15} className="shrink-0" strokeWidth={1.75} />
          {!collapsed && <span>Settings</span>}
        </Link>

        <button
          onClick={() => signOut()}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] text-white hover:bg-[rgba(255,255,255,0.04)] transition-colors"
        >
          <LogOut size={15} className="shrink-0" strokeWidth={1.75} />
          {!collapsed && <span>Sign Out</span>}
        </button>
      </div>
      {newMatterContext && (
        <NewMatterModal
          context={newMatterContext}
          sealed={newMatterSealed}
          onClose={() => {
            setNewMatterContext(null);
            setNewMatterSealed(false);
          }}
          onCreated={() => {
            if (newMatterContext.parentMatterId) {
              setExpandedMatters((prev) => new Set(prev).add(newMatterContext.parentMatterId!));
            }
          }}
        />
      )}
      {pendingMove && (
        <MoveMatterConfirm
          words={pendingMove.words}
          busy={moveBusy}
          error={moveError}
          onCancel={() => { if (!moveBusy) { setPendingMove(null); setMoveError(null); } }}
          onConfirm={() => void confirmMove()}
        />
      )}
      {movedToast && (
        <MovedToast
          text={movedToast.doneText}
          busy={undoBusy}
          onUndo={() => void undoMove()}
          onDismiss={dismissMovedToast}
        />
      )}
      {sealTarget && (
        <SealMatterModal
          target={sealTarget}
          onClose={() => setSealTarget(null)}
        />
      )}
      {deleteTarget && (
        <DeleteMatterModal
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      )}
      {shareTarget && (
        <ShareModal
          scope={shareTarget.scope}
          scopeId={shareTarget.id}
          scopeName={shareTarget.name}
          onClose={() => setShareTarget(null)}
        />
      )}

      {/* New Serverspace Modal — shared with the Dashboard quick action */}
      {showNewServerspace && (
        <NewServerspaceModal onClose={() => setShowNewServerspace(false)} />
      )}
    </aside>
  );
}

// "Drop here to make top-level under this serverspace" zone. The whole
// expanded matter-list area becomes a droppable; nested matter-row
// droppables (inside MatterNode) take priority via pointerWithin, so
// this zone only "wins" when the user releases on whitespace.
function ServerspaceDropZone({
  serverspaceId,
  dragging,
  children,
}: {
  serverspaceId: string;
  dragging: DragData | null;
  children: React.ReactNode;
}) {
  const dropId = `ss-root:${serverspaceId}`;
  const dropData: DropData = { kind: 'ss-root', serverspaceId };
  const { setNodeRef, isOver } = useDroppable({ id: dropId, data: dropData });

  const isDragging = !!dragging;
  const isValid = !!dragging && dragging.serverspaceId === serverspaceId;
  // Highlight the area as a valid drop only when something is being dragged
  // from the SAME serverspace; cross-serverspace drops are not allowed.
  const ring =
    isDragging && isOver && isValid
      ? 'ring-1 ring-[#e8b84a]/60 bg-[#e8b84a]/5'
      : isDragging && isOver && !isValid
        ? 'ring-1 ring-red-400/40'
        : '';

  return (
    <div
      ref={setNodeRef}
      className={`ml-5 pl-3.5 border-l border-[rgba(255,255,255,0.06)] mt-0.5 space-y-px rounded-r-md transition-shadow ${ring}`}
    >
      {children}
    </div>
  );
}

interface MatterNodeProps {
  node: MatterTreeNode;
  ancestorLabel: string;
  serverspaceId: string;
  expandedMatters: Set<string>;
  toggleMatter: (id: string) => void;
  onAddChild: (
    serverspaceId: string,
    parentMatterId: string | null,
    contextLabel: string,
  ) => void;
  onDelete: (matterId: string, matterName: string) => void;
  onShare: (matterId: string, matterName: string) => void;
  isActive: (path: string) => boolean;
  dragging: DragData | null;
  draggingDescendants: Set<string>;
  // True when any ancestor matter is sealed — the seal inherits downward, so
  // sub-matters of a SecureSpace show the lock even though their own ai_tier
  // is still 'A'.
  inheritedSealed: boolean;
}

function MatterNode({
  node,
  ancestorLabel,
  serverspaceId,
  expandedMatters,
  toggleMatter,
  onAddChild,
  onDelete,
  onShare,
  isActive,
  dragging,
  draggingDescendants,
  inheritedSealed,
}: MatterNodeProps) {
  const { matter, children } = node;
  const hasChildren = children.length > 0;
  // Rename in place (Eden, 10-02: a misspelled sub-matter had no rename here).
  // The same single update the matter page's heading makes; Enter or leaving
  // the box saves, Escape or an empty name cancels.
  const refreshServerspaces = useServerspacesRefresh();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(matter.name);
  const [renameErr, setRenameErr] = useState<string | null>(null);
  // Paste what was Cut or Copied in the Vault into this matter (10-02). With
  // nothing on the clipboard the browser's own menu shows, as before.
  const [pasteMenu, setPasteMenu] = useState<ContextMenuState | null>(null);
  const [pasteNote, setPasteNote] = useState<{ ok: boolean; text: string } | null>(null);
  const openPasteMenu = (e: React.MouseEvent) => {
    const clip = getVaultClip();
    if (!clip || renaming) return;
    e.preventDefault();
    const n = clip.items.length;
    setPasteMenu({
      x: e.clientX, y: e.clientY, items: [{
        label: `Paste ${n.toLocaleString()} document${n === 1 ? '' : 's'} into ${matter.name}`,
        hint: clip.mode === 'cut' ? 'move' : 'copy',
        onSelect: () => {
          setPasteNote({ ok: true, text: 'Pasting…' });
          void pasteVaultClip(matter.id, matter.name).then((r) => {
            setPasteNote(r);
            setTimeout(() => setPasteNote((cur) => (cur === r ? null : cur)), 8000);
          });
        },
      }],
    });
  };
  const saveRename = async () => {
    const next = draft.trim();
    setRenaming(false);
    if (!next || next === matter.name) { setDraft(matter.name); return; }
    const { error } = await supabase.from('matterspaces').update({ name: next }).eq('id', matter.id);
    if (error) { setDraft(matter.name); setRenameErr(`Not renamed: ${error.message}`); return; }
    setRenameErr(null);
    refreshServerspaces();
  };
  const isExpanded = expandedMatters.has(matter.id);
  const myLabel = `${ancestorLabel} / ${matter.name}`;
  const path = `/app/matterspace/${matter.id}`;
  const sealed = inheritedSealed || matter.ai_tier !== 'A';

  const dragData: DragData = { kind: 'matter', matterId: matter.id, serverspaceId };
  const dropData: DropData = { kind: 'matter', matterId: matter.id, serverspaceId };

  const {
    setNodeRef: setDragRef,
    attributes,
    listeners,
    isDragging: thisRowIsDragging,
  } = useDraggable({ id: `matter-drag:${matter.id}`, data: dragData });

  // This matter row is also a droppable so other matters can be nested
  // underneath it.
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `matter-drop:${matter.id}`,
    data: dropData,
  });

  // Drop-validity feedback. Hide highlights entirely when nothing is
  // being dragged so the UI stays calm during normal use.
  const isOwnDragSource = dragging?.matterId === matter.id;
  const isDescendantOfDragged = !isOwnDragSource && draggingDescendants.has(matter.id);
  const isSameServerspaceAsDragged = !!dragging && dragging.serverspaceId === serverspaceId;
  const isValidDropTarget =
    !!dragging && !isOwnDragSource && !isDescendantOfDragged && isSameServerspaceAsDragged;
  const dropHighlight =
    isOver && isValidDropTarget
      ? 'ring-1 ring-[#e8b84a]/70 bg-[#e8b84a]/10'
      : isOver && !!dragging && !isValidDropTarget
        ? 'ring-1 ring-red-400/50'
        : '';
  const sourceDim = thisRowIsDragging ? 'opacity-40' : '';

  // Combine refs (drag + drop) on the same row element.
  const setRowRef = (el: HTMLElement | null) => {
    setDragRef(el);
    setDropRef(el);
  };

  return (
    <div>
      <div
        ref={setRowRef}
        {...attributes}
        {...listeners}
        onContextMenu={openPasteMenu}
        className={`group flex items-center gap-1 rounded-md transition-colors ${
          isActive(path)
            ? 'bg-[#16161d] text-white'
            : 'text-white/70 hover:bg-[rgba(255,255,255,0.04)]'
        } ${dropHighlight} ${sourceDim}`}
      >
        {hasChildren ? (
          <button
            onClick={() => toggleMatter(matter.id)}
            className="p-1 text-[#e8b84a]/80 hover:text-[#e8b84a] transition-colors shrink-0"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown size={13} strokeWidth={2.5} /> : <ChevronRight size={13} strokeWidth={2.5} />}
          </button>
        ) : (
          <span className="w-[21px] shrink-0" />
        )}
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => void saveRename()}
            onKeyDown={(e) => {
              // The row is draggable: keep keys (Space, Enter) and the pointer
              // in the box, not on the drag handle.
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') { setDraft(matter.name); setRenaming(false); }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={`Rename ${matter.name}`}
            className="flex-1 min-w-0 my-0.5 h-7 px-1.5 rounded bg-white/[0.08] border border-[#e8b84a]/60 text-[12px] text-white outline-none"
          />
        ) : (
        <Link
          to={path}
          onDoubleClick={(e) => { e.preventDefault(); setDraft(matter.name); setRenaming(true); }}
          className={`flex-1 truncate py-1.5 text-[12px] ${
            isActive(path) ? 'font-medium text-white' : 'hover:text-white'
          }`}
          title={sealed ? `${matter.name} — sealed` : undefined}
        >
          {sealed && (
            <Lock
              size={10}
              strokeWidth={2.25}
              className="inline-block mr-1 -mt-px shrink-0"
              style={{ color: '#5aa88f' }}
            />
          )}
          {matter.name}
        </Link>
        )}
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDraft(matter.name);
            setRenaming(true);
          }}
          className="p-1 rounded text-white/30 opacity-0 group-hover:opacity-100 hover:text-[#e8b84a] hover:bg-[rgba(255,255,255,0.04)] transition-all shrink-0"
          aria-label="Rename matter"
          title="Rename"
        >
          <Pencil size={11} strokeWidth={2} />
        </button>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAddChild(serverspaceId, matter.id, myLabel);
          }}
          className="p-1 rounded text-white/30 opacity-0 group-hover:opacity-100 hover:text-[#e8b84a] hover:bg-[rgba(255,255,255,0.04)] transition-all shrink-0"
          aria-label="Add sub-matter"
          title="Add sub-matter"
        >
          <Plus size={11} strokeWidth={2} />
        </button>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onShare(matter.id, matter.name);
          }}
          className="p-1 rounded text-white/30 opacity-0 group-hover:opacity-100 hover:text-[#e8b84a] hover:bg-[rgba(255,255,255,0.04)] transition-all shrink-0"
          aria-label="Share matter"
          title="Share matter"
        >
          <UserPlus size={11} strokeWidth={2} />
        </button>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete(matter.id, matter.name);
          }}
          className="p-1 mr-1 rounded text-white/30 opacity-0 group-hover:opacity-100 hover:text-red-300 hover:bg-red-300/10 transition-all shrink-0"
          aria-label="Delete matter"
          title="Delete matter"
        >
          <Trash2 size={11} strokeWidth={2} />
        </button>
      </div>
      {renameErr && <p className="px-2 py-1 text-[11px] text-red-300">{renameErr}</p>}
      {pasteNote && <p className={`px-2 py-1 text-[11px] ${pasteNote.ok ? 'text-white/60' : 'text-red-300'}`}>{pasteNote.text}</p>}
      <ContextMenu menu={pasteMenu} onClose={() => setPasteMenu(null)} />
      {isExpanded && hasChildren && (
        <div className="ml-3 pl-2 border-l border-[rgba(255,255,255,0.06)] mt-0.5 space-y-px">
          {children.map((child) => (
            <MatterNode
              key={child.matter.id}
              node={child}
              ancestorLabel={myLabel}
              serverspaceId={serverspaceId}
              expandedMatters={expandedMatters}
              toggleMatter={toggleMatter}
              onAddChild={onAddChild}
              onDelete={onDelete}
              onShare={onShare}
              isActive={isActive}
              dragging={dragging}
              draggingDescendants={draggingDescendants}
              inheritedSealed={sealed}
            />
          ))}
        </div>
      )}
    </div>
  );
}

