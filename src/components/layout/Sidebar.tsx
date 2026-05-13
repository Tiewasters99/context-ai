import { useState, useRef, useEffect } from 'react';
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
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { useServerspaces, useServerspacesRefresh } from '@/hooks/useServerspaces';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';
import NewMatterModal, { type NewMatterContext } from '@/components/matter/NewMatterModal';
import DeleteMatterModal, { type DeleteMatterTarget, collectDescendantIds } from '@/components/matter/DeleteMatterModal';
import ShareModal from '@/components/serverspace/ShareModal';

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
  const [shareTarget, setShareTarget] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (showNewServerspace) newServerspaceRef.current?.focus();
  }, [showNewServerspace]);

  const { data: serverspaces = [] } = useServerspaces();
  const refreshServerspaces = useServerspacesRefresh();
  const [clientspaceId, setClientspaceId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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

        {/* Serverspace List */}
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
                      onClick={(e) => { e.stopPropagation(); setShareTarget({ id: space.id, name: space.name }); }}
                      className="p-1.5 mr-1.5 rounded text-white/30 opacity-0 group-hover:opacity-100 hover:text-[#e8b84a] hover:bg-[rgba(255,255,255,0.04)] transition-all shrink-0"
                      aria-label="Share serverspace"
                      title="Share serverspace"
                    >
                      <UserPlus size={13} strokeWidth={2} />
                    </button>
                  )}
                </div>

                {/* Matterspaces — recursive tree */}
                {isExpanded && !collapsed && (
                  <div className="ml-5 pl-3.5 border-l border-[rgba(255,255,255,0.06)] mt-0.5 space-y-px">
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
                        isActive={isActive}
                      />
                    ))}
                    <button
                      onClick={() => openNewMatter(space.id, null, space.name)}
                      className="flex items-center gap-1.5 w-full px-2.5 py-1.5 rounded-md text-[12px] text-white/50 hover:bg-[rgba(255,255,255,0.04)] hover:text-[#e8b84a] transition-colors text-left"
                    >
                      <Plus size={11} strokeWidth={2} />
                      <span>New matter</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
          serverspaceId={shareTarget.id}
          serverspaceName={shareTarget.name}
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
  isActive: (path: string) => boolean;
}

function MatterNode({
  node,
  ancestorLabel,
  serverspaceId,
  expandedMatters,
  toggleMatter,
  onAddChild,
  onDelete,
  isActive,
}: MatterNodeProps) {
  const { matter, children } = node;
  const hasChildren = children.length > 0;
  const isExpanded = expandedMatters.has(matter.id);
  const myLabel = `${ancestorLabel} / ${matter.name}`;
  const path = `/app/matterspace/${matter.id}`;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-md transition-colors ${
          isActive(path)
            ? 'bg-[#16161d] text-white'
            : 'text-white/70 hover:bg-[rgba(255,255,255,0.04)]'
        }`}
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
              isActive={isActive}
            />
          ))}
        </div>
      )}
    </div>
  );
}
