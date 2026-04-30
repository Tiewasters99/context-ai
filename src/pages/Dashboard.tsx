import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Plus, ChevronRight, ChevronDown, Folder, X, DoorOpen, LayoutTemplate } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import { useServerspaces } from '@/hooks/useServerspaces';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';

const quickActions = [
  { label: 'Create Serverspace', icon: Plus, path: '#' },
];

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const displayName = user?.user_metadata?.display_name ?? 'there';

  // Shared query — same cache as the sidebar. Mutations from either view
  // invalidate and both refetch.
  const { data: serverspaces = [], isLoading: loadingServerspaces } = useServerspaces();
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [expandedMatters, setExpandedMatters] = useState<Set<string>>(new Set());

  const { cardRef, toggleFullscreen } = useDraggableResizable();
  const [showCard, setShowCard] = useState(true);
  const [enteringVault, setEnteringVault] = useState(false);
  // Door position persists across reloads so the vault icon stays lined up
  // over the archway in the cover image once the user drags it into place.
  const DOOR_POS_KEY = 'cs.dashboard.doorPos';
  const [doorPos, setDoorPos] = useState<{ x: number; y: number }>(() => {
    try {
      const raw = localStorage.getItem(DOOR_POS_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return { x: 0, y: 0 };
  });
  const doorDrag = useRef({ active: false, moved: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  const onDoorMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    doorDrag.current = { active: true, moved: false, startX: e.clientX, startY: e.clientY, origX: doorPos.x, origY: doorPos.y };
  }, [doorPos]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = doorDrag.current;
      if (!d.active) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
      setDoorPos({ x: d.origX + dx, y: d.origY + dy });
    };
    const onUp = () => {
      if (doorDrag.current.active && doorDrag.current.moved) {
        // Capture the latest position via the setter's current value;
        // closure-captured doorPos here would always be stale.
        setDoorPos((pos) => {
          try { localStorage.setItem(DOOR_POS_KEY, JSON.stringify(pos)); } catch {}
          return pos;
        });
      }
      doorDrag.current.active = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  const onDoorClick = useCallback(() => {
    if (doorDrag.current.moved) return;
    setEnteringVault(true);
    setTimeout(() => navigate('/app/vault'), 1200);
  }, [navigate]);

  const toggle = (_set: Set<string>, setFn: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) => {
    setFn((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="min-h-screen relative">
      <CoverImage editable />

      {!showCard && (
        <button
          onClick={() => setShowCard(true)}
          className="absolute top-6 left-6 z-20 flex items-center gap-2 px-3 py-1.5 rounded-md border border-[rgba(255,255,255,0.1)] bg-[rgba(8,8,14,0.7)] backdrop-blur-[20px] text-[12px] text-white/70 hover:text-[#e8b84a] hover:border-[rgba(232,184,74,0.3)] transition-colors"
          title="Show welcome panel"
        >
          <LayoutTemplate size={13} strokeWidth={1.75} />
          <span>Show welcome</span>
        </button>
      )}

      {showCard && <div
        ref={cardRef}
        className="max-w-2xl mx-auto px-6 py-8 mt-[55vh] mb-8 rounded-xl backdrop-blur-[30px] border border-[rgba(255,255,255,0.06)] cursor-grab select-none"
        style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
      >
        {/* Drag handle + fullscreen + close */}
        <div className="flex items-center justify-between mb-4 -mt-1">
          <button
            onClick={() => setShowCard(false)}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
            title="Close"
          >
            <X size={14} strokeWidth={2} />
          </button>
          <div className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors" title="Drag to move" />
          <FullscreenToggle onToggle={toggleFullscreen} />
        </div>
        <h1 className="text-[22px] font-semibold text-[#f5f2ed]">
          Welcome back, {displayName}
        </h1>
        <p className="text-[15px] text-[#e8b84a] mt-1.5 tracking-wide font-medium">Here's what's happening in your Contextspace.</p>
        <p className="text-[11px] text-white/30 mt-1">Drag cards to reposition them.</p>

        {/* Serverspaces Explorer */}
        <section className="mt-8">
          <h2 className="text-[13px] font-semibold text-[#8a8693] uppercase tracking-wider mb-3">Serverspaces</h2>
          <div className="rounded-lg border border-[rgba(255,255,255,0.06)] bg-[rgba(10,10,16,0.72)] backdrop-blur-[20px] overflow-hidden">
            {loadingServerspaces && (
              <div className="px-4 py-3 text-[12px] text-[#8a8693]">Loading serverspaces…</div>
            )}
            {!loadingServerspaces && serverspaces.length === 0 && (
              <div className="px-4 py-3 text-[12px] text-[#8a8693]">
                No serverspaces yet.{' '}
                <span className="text-[#d4a054]">Create one to get started.</span>
              </div>
            )}
            {serverspaces.map((server, serverIdx) => {
              const isServerExpanded = expandedServers.has(server.id);
              const tree = buildMatterTree(server.matterspaces);

              return (
                <div key={server.id} className={serverIdx > 0 ? 'border-t border-[rgba(255,255,255,0.06)]' : ''}>
                  {/* Serverspace row */}
                  <div className="flex items-center hover:bg-[rgba(255,255,255,0.04)] transition-colors">
                    <button
                      onClick={() => toggle(expandedServers, setExpandedServers, server.id)}
                      className="flex items-center gap-2.5 flex-1 px-4 py-3 text-left"
                    >
                      <span className="text-[#e8b84a]/80 w-4 shrink-0">
                        {isServerExpanded ? <ChevronDown size={15} strokeWidth={2.5} /> : <ChevronRight size={15} strokeWidth={2.5} />}
                      </span>
                      <Users size={15} className="text-[#d4a054]" strokeWidth={1.75} />
                      <span className="text-[13px] font-medium text-[#f5f2ed]">{server.name}</span>
                      <span className="text-[11px] text-white ml-auto font-normal">
                        {server.member_count} members · {server.matterspaces.length} matters
                      </span>
                    </button>
                    <button
                      onClick={() => navigate(`/app/serverspace/${server.id}`)}
                      className="px-2.5 py-1 mr-3 text-[11px] font-medium text-[#d4a054] hover:bg-[rgba(212,160,84,0.1)] rounded transition-colors"
                    >
                      Open
                    </button>
                  </div>

                  {/* Matter tree */}
                  {isServerExpanded && tree.length > 0 && (
                    <div className="border-t border-[rgba(255,255,255,0.06)] py-1">
                      {tree.map((node) => (
                        <DashboardMatterNode
                          key={node.matter.id}
                          node={node}
                          depth={0}
                          expandedMatters={expandedMatters}
                          toggleMatter={(id) => toggle(expandedMatters, setExpandedMatters, id)}
                          onOpen={(matterId) => navigate(`/app/matterspace/${matterId}`)}
                        />
                      ))}
                    </div>
                  )}

                  {isServerExpanded && tree.length === 0 && (
                    <div className="pl-11 pr-4 py-2.5 border-t border-[rgba(255,255,255,0.06)]">
                      <p className="text-[12px] text-[#5a5665]">No matterspaces yet</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Quick Actions */}
        <div className="grid grid-cols-1 gap-3 mt-10">
          {quickActions.map((a) => (
            <button
              key={a.label}
              onClick={() => navigate(a.path)}
              className="flex items-center gap-3 px-4 py-3.5 rounded-lg border border-[rgba(255,255,255,0.06)] hover:border-[rgba(255,255,255,0.1)] transition-all text-left group bg-[rgba(10,10,16,0.72)] backdrop-blur-[20px]"
            >
              <div className="w-8 h-8 rounded-md bg-[rgba(212,160,84,0.1)] group-hover:bg-[rgba(212,160,84,0.15)] flex items-center justify-center transition-colors">
                <a.icon size={15} className="text-[#d4a054]" strokeWidth={1.75} />
              </div>
              <span className="text-[13px] font-medium text-[#f5f1e8]">{a.label}</span>
            </button>
          ))}
        </div>
      </div>}

      {/* The Door — entrance to the Vault (draggable) */}
      <div
        onMouseDown={onDoorMouseDown}
        onClick={onDoorClick}
        className="absolute group cursor-grab active:cursor-grabbing select-none"
        style={{ left: `calc(50% + ${doorPos.x}px)`, top: `calc(30% + ${doorPos.y}px)`, transform: 'translateX(-50%)' }}
      >
        <div className="flex flex-col items-center gap-4">
          {/* Glowing arch */}
          <div className="relative w-24 h-36 rounded-t-full border-2 border-[#e8b84a]/30 group-hover:border-[#e8b84a]/70 transition-all duration-700 overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-t from-[#e8b84a]/5 to-[#e8b84a]/20 group-hover:from-[#e8b84a]/10 group-hover:to-[#e8b84a]/40 transition-all duration-700" />
            <div className="absolute inset-[3px] rounded-t-full bg-gradient-to-t from-black via-black/80 to-[#e8b84a]/10 group-hover:to-[#e8b84a]/30 transition-all duration-700" />
            {/* Light at the end */}
            <div className="absolute top-4 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-white/40 group-hover:bg-white group-hover:shadow-[0_0_20px_rgba(255,255,255,0.6)] group-hover:scale-150 transition-all duration-700" />
            <DoorOpen size={20} className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[#e8b84a]/30 group-hover:text-[#e8b84a] transition-all duration-500" />
          </div>
          <span className="text-[12px] text-white/20 group-hover:text-[#e8b84a] tracking-[0.25em] uppercase font-medium transition-all duration-500">
            Enter the Vault
          </span>
        </div>
      </div>

      {/* Vault entrance animation — full screen fade to black */}
      {enteringVault && (
        <div className="fixed inset-0 z-50 bg-black animate-[fadeIn_1.2s_ease-in-out_forwards] flex items-center justify-center">
          <p className="text-[14px] text-white/0 animate-[fadeInText_1.2s_ease-in-out_0.4s_forwards] tracking-[0.4em] uppercase font-medium">
            The Vault
          </p>
        </div>
      )}
    </div>
  );
}


interface DashboardMatterNodeProps {
  node: MatterTreeNode;
  depth: number;
  expandedMatters: Set<string>;
  toggleMatter: (id: string) => void;
  onOpen: (matterId: string) => void;
}

function DashboardMatterNode({
  node,
  depth,
  expandedMatters,
  toggleMatter,
  onOpen,
}: DashboardMatterNodeProps) {
  const { matter, children } = node;
  const hasChildren = children.length > 0;
  const isExpanded = expandedMatters.has(matter.id);
  // Indent each level by ~16px past the serverspace baseline (44px).
  const indent = 44 + depth * 16;

  return (
    <div>
      <div className="flex items-center hover:bg-[rgba(255,255,255,0.04)] transition-colors group">
        <button
          onClick={() => onOpen(matter.id)}
          className="flex items-center gap-2.5 flex-1 pr-4 py-1.5 text-left"
          style={{ paddingLeft: `${indent}px` }}
        >
          {hasChildren ? (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleMatter(matter.id);
              }}
              className="text-[#e8b84a]/80 hover:text-[#e8b84a] w-4 shrink-0 cursor-pointer transition-colors"
            >
              {isExpanded ? <ChevronDown size={14} strokeWidth={2.5} /> : <ChevronRight size={14} strokeWidth={2.5} />}
            </span>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <Folder size={14} className="text-[#d4a054]" strokeWidth={1.75} />
          <span className="text-[13px] text-[#f5f1e8] truncate">{matter.name}</span>
          {hasChildren && (
            <span className="text-[10px] text-white/30 ml-auto">
              {children.length} sub-matter{children.length === 1 ? '' : 's'}
            </span>
          )}
        </button>
      </div>
      {isExpanded && hasChildren && (
        <div>
          {children.map((child) => (
            <DashboardMatterNode
              key={child.matter.id}
              node={child}
              depth={depth + 1}
              expandedMatters={expandedMatters}
              toggleMatter={toggleMatter}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}
