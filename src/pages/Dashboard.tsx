import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, List, Database, File, Users, Plus, ChevronRight, ChevronDown, Folder, X, DoorOpen } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import type { ContentType } from '@/lib/types';

interface ContentSummary {
  type: ContentType;
  count: number;
  items: { id: string; title: string }[];
}

interface MockMatterspace {
  id: string;
  name: string;
  content: ContentSummary[];
}

interface MockServerspace {
  id: string;
  name: string;
  members: number;
  matterspaces: MockMatterspace[];
}

const contentTypeIcon = {
  page: FileText,
  list: List,
  database: Database,
  document: File,
} as const;

const contentTypeLabel = {
  page: 'Pages',
  list: 'Lists',
  database: 'Databases',
  document: 'Documents',
} as const;

const quickActions = [
  { label: 'New Page', icon: FileText, path: '/app/page/new' },
  { label: 'New List', icon: List, path: '/app/list/new' },
  { label: 'Create Serverspace', icon: Plus, path: '#' },
];

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const displayName = user?.user_metadata?.display_name ?? 'there';

  const [serverspaces, setServerspaces] = useState<MockServerspace[]>([]);
  const [loadingServerspaces, setLoadingServerspaces] = useState(true);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [expandedMatters, setExpandedMatters] = useState<Set<string>>(new Set());
  const [expandedContent, setExpandedContent] = useState<Set<string>>(new Set());

  // Fetch the authenticated user's real serverspaces + matterspaces via RLS.
  // content is deliberately empty for each matter until we wire content_items
  // into the sidebar — expanding a matter shows 'no pages yet' rather than
  // mock items that would 404 when clicked.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingServerspaces(true);
      const { data: rawServers, error } = await supabase
        .from('serverspaces')
        .select('id, name, matterspaces (id, name)')
        .order('created_at', { ascending: true });
      if (cancelled) return;
      if (error || !rawServers) {
        setServerspaces([]);
        setLoadingServerspaces(false);
        return;
      }
      // Best-effort member count per serverspace (ignore errors; display 0 if RLS hides it)
      const enriched = await Promise.all(
        rawServers.map(async (s) => {
          const { count } = await supabase
            .from('serverspace_members')
            .select('user_id', { count: 'exact', head: true })
            .eq('serverspace_id', s.id);
          return {
            id: s.id,
            name: s.name,
            members: count ?? 0,
            matterspaces: (s.matterspaces ?? []).map((m: { id: string; name: string }) => ({
              id: m.id,
              name: m.name,
              content: [],
            })),
          } as MockServerspace;
        }),
      );
      if (!cancelled) {
        setServerspaces(enriched);
        setLoadingServerspaces(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

              return (
                <div key={server.id} className={serverIdx > 0 ? 'border-t border-[rgba(255,255,255,0.06)]' : ''}>
                  {/* Serverspace row */}
                  <div className="flex items-center hover:bg-[rgba(255,255,255,0.04)] transition-colors">
                    <button
                      onClick={() => toggle(expandedServers, setExpandedServers, server.id)}
                      className="flex items-center gap-2.5 flex-1 px-4 py-3 text-left"
                    >
                      <span className="text-[#5a5665] w-4 shrink-0">
                        {isServerExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </span>
                      <Users size={15} className="text-[#d4a054]" strokeWidth={1.75} />
                      <span className="text-[13px] font-medium text-[#f5f2ed]">{server.name}</span>
                      <span className="text-[11px] text-white ml-auto font-normal">
                        {server.members} members · {server.matterspaces.length} matters
                      </span>
                    </button>
                    <button
                      onClick={() => navigate(`/app/serverspace/${server.id}`)}
                      className="px-2.5 py-1 mr-3 text-[11px] font-medium text-[#d4a054] hover:bg-[rgba(212,160,84,0.1)] rounded transition-colors"
                    >
                      Open
                    </button>
                  </div>

                  {/* Matterspaces */}
                  {isServerExpanded && server.matterspaces.length > 0 && (
                    <div className="border-t border-[rgba(255,255,255,0.06)]">
                      {server.matterspaces.map((matter) => {
                        const isMatterExpanded = expandedMatters.has(matter.id);

                        return (
                          <div key={matter.id}>
                            <div className="flex items-center hover:bg-[rgba(255,255,255,0.04)] transition-colors">
                              <button
                                onClick={() => toggle(expandedMatters, setExpandedMatters, matter.id)}
                                className="flex items-center gap-2.5 flex-1 pl-11 pr-4 py-2 text-left"
                              >
                                <span className="text-[#5a5665] w-4 shrink-0">
                                  {matter.content.length > 0 ? (
                                    isMatterExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />
                                  ) : <span className="w-3.5" />}
                                </span>
                                <Folder size={14} className="text-[#d4a054]" strokeWidth={1.75} />
                                <span className="text-[13px] text-[#e8e4de]">{matter.name}</span>
                              </button>
                              <button
                                onClick={() => navigate(`/app/matterspace/${matter.id}`)}
                                className="px-2.5 py-1 mr-3 text-[11px] font-medium text-[#d4a054] hover:bg-[rgba(212,160,84,0.1)] rounded transition-colors"
                              >
                                Open
                              </button>
                            </div>

                            {/* Content type summaries */}
                            {isMatterExpanded && (
                              <div>
                                {matter.content.map((group) => {
                                  const contentKey = `${matter.id}-${group.type}`;
                                  const isContentExpanded = expandedContent.has(contentKey);
                                  const Icon = contentTypeIcon[group.type];

                                  return (
                                    <div key={contentKey}>
                                      <button
                                        onClick={() => toggle(expandedContent, setExpandedContent, contentKey)}
                                        className="flex items-center gap-2.5 w-full pl-[76px] pr-4 py-1.5 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors"
                                      >
                                        <span className="text-[#5a5665] w-3 shrink-0">
                                          {isContentExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                        </span>
                                        <Icon size={13} className="text-[#5a5665]" strokeWidth={1.75} />
                                        <span className="text-[12px] text-[#8a8693]">
                                          {contentTypeLabel[group.type]} ({group.count})
                                        </span>
                                      </button>

                                      {isContentExpanded && (
                                        <div className="py-0.5">
                                          {group.items.map((item) => (
                                            <button
                                              key={item.id}
                                              onClick={() => navigate(`/app/${group.type}/${item.id}`)}
                                              className="flex items-center gap-2.5 w-full pl-[104px] pr-4 py-1 text-left hover:bg-[rgba(212,160,84,0.1)] transition-colors group"
                                            >
                                              <span className="w-1 h-1 rounded-full bg-[#5a5665] group-hover:bg-[#d4a054] shrink-0" />
                                              <span className="text-[12px] text-[#8a8693] group-hover:text-[#d4a054] truncate">
                                                {item.title}
                                              </span>
                                            </button>
                                          ))}
                                          {group.count > group.items.length && (
                                            <div className="pl-[104px] pr-4 py-1">
                                              <span className="text-[11px] text-[#5a5665]">
                                                +{group.count - group.items.length} more
                                              </span>
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {isServerExpanded && server.matterspaces.length === 0 && (
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
        <div className="grid grid-cols-3 gap-3 mt-10">
          {quickActions.map((a) => (
            <button
              key={a.label}
              onClick={() => navigate(a.path)}
              className="flex items-center gap-3 px-4 py-3.5 rounded-lg border border-[rgba(255,255,255,0.06)] hover:border-[rgba(255,255,255,0.1)] transition-all text-left group bg-[rgba(10,10,16,0.72)] backdrop-blur-[20px]"
            >
              <div className="w-8 h-8 rounded-md bg-[rgba(212,160,84,0.1)] group-hover:bg-[rgba(212,160,84,0.15)] flex items-center justify-center transition-colors">
                <a.icon size={15} className="text-[#d4a054]" strokeWidth={1.75} />
              </div>
              <span className="text-[13px] font-medium text-[#e8e4de]">{a.label}</span>
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
