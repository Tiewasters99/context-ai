import { useState, useRef, useEffect, useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { X,
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
  Plug,
  UserPlus,
  Folder,
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
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';
import NewMatterModal, { type NewMatterContext } from '@/components/matter/NewMatterModal';
import DeleteMatterModal, { type DeleteMatterTarget, collectDescendantIds } from '@/components/matter/DeleteMatterModal';
import ShareModal from '@/components/serverspace/ShareModal';

// Drag-and-drop ids are encoded as "matter:<uuid>" or "ss-root:<uuid>" so
// dragEnd can tell whether the drop target is a matter (nest underneath)
// or a serverspace's top-level area (re-parent to null inside that serverspace).
type DragData = { kind: 'matter'; matterId: string; serverspaceId: string };
type DropData =
  | { kind: 'matter'; matterId: string; serverspaceId: string }
  | { kind: 'ss-root'; serverspaceId: string };

interface SidebarProps {
  onToggleAssistant?: () => void;
}

export default function Sidebar({ onToggleAssistant }: SidebarProps) {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [aiAssistantEnabled, setAiAssistantEnabled] = useState(false);
  const [showNewServerspace, setShowNewServerspace] = useState(false);
  const [newServerspaceName, setNewServerspaceName] = useState('');
  const newServerspaceRef = useRef<HTMLInputElement>(null);

  const [newMatterContext, setNewMatterContext] = useState<NewMatterContext | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteMatterTarget | null>(null);
  const [expandedMatters, setExpandedMatters] = useState<Set<string>>(new Set());
  const [shareTarget, setShareTarget] = useState<{ scope: 'serverspace' | 'matterspace'; id: string; name: string } | null>(null);

  useEffect(() => {
    if (showNewServerspace) newServerspaceRef.current?.focus();
  }, [showNewServerspace]);

  const { data: serverspaces = [] } = useServerspaces();
  const refreshServerspaces = useServerspacesRefresh();
  const [clientspaceId, setClientspaceId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Drag-and-drop state for re-parenting matters in the sidebar tree.
  const [dragging, setDragging] = useState<DragData | null>(null);
  const [reparentError, setReparentError] = useState<string | null>(null);
  // Distance-activation so single clicks on rows continue to navigate
  // via the embedded <Link>; only an actual movement engages drag mode.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

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

    const { error } = await supabase
      .from('matterspaces')
      .update({ parent_matterspace_id: newParentId })
      .eq('id', src.matterId);
    if (error) {
      setReparentError(error.message);
      return;
    }
    // Expand the destination so the user immediately sees the moved matter.
    if (newParentId) {
      setExpandedMatters((prev) => new Set(prev).add(newParentId));
    } else {
      setExpandedSpaces((prev) => new Set(prev).add(targetServerspaceId));
    }
    await refreshServerspaces();
  };

  // Fetch the user's clientspace id once so we know the parent FK for
  // any new serverspace they create.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user) return;
      const { data: cs } = await supabase
        .from('clientspaces')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (cancelled) return;
      if (cs) setClientspaceId(cs.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

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

  const handleCreateServerspace = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newServerspaceName.trim();
    if (!name || creating) return;
    if (!clientspaceId) {
      setCreateError(
        'No clientspace found for your account. Refresh the page and try again.',
      );
      return;
    }
    setCreating(true);
    setCreateError(null);
    const { error } = await supabase
      .from('serverspaces')
      .insert({ clientspace_id: clientspaceId, name });
    setCreating(false);
    if (error) {
      setCreateError(error.message);
      return;
    }
    setShowNewServerspace(false);
    setNewServerspaceName('');
    // Invalidate the shared cache — sidebar and dashboard both refetch.
    await refreshServerspaces();
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

  const sidebarWidth = collapsed ? 'w-16' : 'w-64';

  return (
    <aside
      className={`${sidebarWidth} h-screen flex flex-col shrink-0 transition-all duration-200 ease-in-out border-r border-[rgba(255,255,255,0.08)] backdrop-blur-[30px]`}
      style={{ backgroundColor: 'rgba(8, 8, 14, 0.82)' }}
    >
      {/* Brand + Collapse Toggle */}
      <div className="flex items-center justify-between px-4 h-13 border-b border-[rgba(255,255,255,0.06)]">
        {!collapsed && (
          <span className="text-[15px] font-semibold text-white tracking-tight">
            Context<span className="text-[#d4a054]">spaces</span><span className="text-white">.ai</span>
          </span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.04)] text-white/70 transition-colors"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <PanelLeft size={16} strokeWidth={1.75} />
        </button>
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

      {/* Bottom Actions */}
      <div className="border-t border-[rgba(255,255,255,0.06)] p-2.5 space-y-px">
        <button
          onClick={() => { setAiAssistantEnabled(!aiAssistantEnabled); onToggleAssistant?.(); }}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors ${
            aiAssistantEnabled
              ? 'bg-[rgba(212,160,84,0.08)] text-[#e8b84a]'
              : 'text-white hover:bg-[rgba(255,255,255,0.04)]'
          }`}
        >
          <Bot size={15} className="shrink-0" strokeWidth={1.75} />
          {!collapsed && <span>AI Assistant</span>}
        </button>

        <Link
          to="/app/claude-connect"
          className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors ${
            isActive('/app/claude-connect')
              ? 'bg-[#16161d] text-white font-medium'
              : 'text-white hover:bg-[rgba(255,255,255,0.04)]'
          }`}
          title="Connect Claude (and other MCP clients) to your matters"
        >
          <Plug size={15} className="shrink-0" strokeWidth={1.75} />
          {!collapsed && <span>Connect to Claude</span>}
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
          onClose={() => setNewMatterContext(null)}
          onCreated={() => {
            if (newMatterContext.parentMatterId) {
              setExpandedMatters((prev) => new Set(prev).add(newMatterContext.parentMatterId!));
            }
          }}
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

      {/* New Serverspace Modal */}
      {showNewServerspace && (
        <>
          <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setShowNewServerspace(false)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-sm rounded-xl border border-[rgba(255,255,255,0.12)] p-6 bg-[#12121a]">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-[15px] font-semibold text-white">New Serverspace</h3>
              <button
                onClick={() => { setShowNewServerspace(false); setCreateError(null); }}
                className="p-1 rounded hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreateServerspace}>
              <input
                ref={newServerspaceRef}
                type="text"
                value={newServerspaceName}
                onChange={(e) => setNewServerspaceName(e.target.value)}
                placeholder="Serverspace name"
                disabled={creating}
                className="w-full px-4 py-2.5 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[14px] text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-[#e8b84a] focus:border-transparent"
              />
              {createError && (
                <p className="mt-3 text-[12px] text-red-300 leading-relaxed">{createError}</p>
              )}
              <button
                type="submit"
                disabled={!newServerspaceName.trim() || creating}
                className="w-full mt-4 py-2.5 rounded-lg bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[13px] font-bold transition-colors disabled:opacity-40 shadow-[0_0_20px_rgba(240,200,80,0.3)]"
              >
                {creating ? 'Creating…' : 'Create Serverspace'}
              </button>
            </form>
          </div>
        </>
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
}: MatterNodeProps) {
  const { matter, children } = node;
  const hasChildren = children.length > 0;
  const isExpanded = expandedMatters.has(matter.id);
  const myLabel = `${ancestorLabel} / ${matter.name}`;
  const path = `/app/matterspace/${matter.id}`;

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
        <Link
          to={path}
          className={`flex-1 truncate py-1.5 text-[12px] ${
            isActive(path) ? 'font-medium text-white' : 'hover:text-white'
          }`}
        >
          {matter.name}
        </Link>
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
            />
          ))}
        </div>
      )}
    </div>
  );
}
