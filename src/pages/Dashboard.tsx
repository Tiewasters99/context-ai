import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, List, Database, File, Users, Plus, ChevronRight, ChevronDown, Folder, X, DoorOpen } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
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

const mockServerspaces: MockServerspace[] = [
  {
    id: '1',
    name: 'Labib',
    members: 5,
    matterspaces: [
      {
        id: 'm1',
        name: 'Case Alpha',
        content: [
          { type: 'page', count: 3, items: [{ id: 'p1', title: 'Case Overview' }, { id: 'p2', title: 'Timeline' }, { id: 'p3', title: 'Strategy Notes' }] },
          { type: 'list', count: 2, items: [{ id: 'l1', title: 'Action Items' }, { id: 'l2', title: 'Discovery Checklist' }] },
          { type: 'database', count: 1, items: [{ id: 'd1', title: 'Contacts' }] },
          { type: 'document', count: 5, items: [{ id: 'doc1', title: 'Complaint.docx' }, { id: 'doc2', title: 'Settlement Draft.pdf' }] },
        ],
      },
      {
        id: 'm2',
        name: 'Case Beta',
        content: [
          { type: 'page', count: 2, items: [{ id: 'p4', title: 'Intake Notes' }, { id: 'p5', title: 'Research' }] },
          { type: 'list', count: 1, items: [{ id: 'l3', title: 'Deadlines' }] },
          { type: 'document', count: 3, items: [{ id: 'doc3', title: 'Retainer Agreement.pdf' }] },
        ],
      },
      {
        id: 'm3',
        name: 'Compliance Review',
        content: [
          { type: 'page', count: 1, items: [{ id: 'p6', title: 'Audit Findings' }] },
          { type: 'database', count: 1, items: [{ id: 'd2', title: 'Regulatory Tracker' }] },
        ],
      },
    ],
  },
  {
    id: '2',
    name: 'Context.ai',
    members: 12,
    matterspaces: [
      {
        id: 'm4',
        name: 'Marketing',
        content: [
          { type: 'page', count: 4, items: [{ id: 'p7', title: 'Campaign Brief' }, { id: 'p8', title: 'Creative Direction' }] },
          { type: 'list', count: 2, items: [{ id: 'l4', title: 'Task Board' }, { id: 'l5', title: 'Vendor List' }] },
        ],
      },
      {
        id: 'm5',
        name: 'Brand Assets',
        content: [
          { type: 'document', count: 12, items: [{ id: 'doc4', title: 'Logo Pack.zip' }, { id: 'doc5', title: 'Style Guide.pdf' }] },
        ],
      },
      {
        id: 'm6',
        name: 'Product Dev',
        content: [
          { type: 'page', count: 6, items: [{ id: 'p9', title: 'Sprint 14 Retro' }, { id: 'p10', title: 'Sprint 15 Goals' }] },
          { type: 'list', count: 3, items: [{ id: 'l6', title: 'Backlog' }, { id: 'l7', title: 'Bug Queue' }] },
          { type: 'database', count: 2, items: [{ id: 'd3', title: 'Feature Tracker' }, { id: 'd4', title: 'Release Log' }] },
        ],
      },
      {
        id: 'm7',
        name: 'Architecture',
        content: [
          { type: 'page', count: 3, items: [{ id: 'p11', title: 'System Design' }, { id: 'p12', title: 'API Spec' }] },
          { type: 'document', count: 2, items: [{ id: 'doc6', title: 'ERD.png' }] },
        ],
      },
      {
        id: 'm8',
        name: 'Board of Directors',
        content: [
          { type: 'page', count: 2, items: [{ id: 'p13', title: 'Meeting Minutes' }, { id: 'p14', title: 'Governance' }] },
          { type: 'document', count: 4, items: [{ id: 'doc7', title: 'Bylaws.pdf' }, { id: 'doc8', title: 'Board Deck Q1.pdf' }] },
        ],
      },
      {
        id: 'm9',
        name: 'Real Estate Portfolio',
        content: [
          { type: 'database', count: 1, items: [{ id: 'd5', title: 'Properties' }] },
          { type: 'document', count: 3, items: [{ id: 'doc9', title: 'Lease Agreement.pdf' }] },
        ],
      },
    ],
  },
];

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

  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [expandedMatters, setExpandedMatters] = useState<Set<string>>(new Set());
  const [expandedContent, setExpandedContent] = useState<Set<string>>(new Set());

  const { cardRef, toggleFullscreen } = useDraggableResizable();
  const [showCard, setShowCard] = useState(true);
  const [enteringVault, setEnteringVault] = useState(false);

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

        {/* Serverspaces Explorer */}
        <section className="mt-8">
          <h2 className="text-[13px] font-semibold text-[#8a8693] uppercase tracking-wider mb-3">Serverspaces</h2>
          <div className="rounded-lg border border-[rgba(255,255,255,0.06)] bg-[rgba(10,10,16,0.72)] backdrop-blur-[20px] overflow-hidden">
            {mockServerspaces.map((server, serverIdx) => {
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

      {/* The Door — entrance to the Vault */}
      <div
        className="absolute"
        style={{ left: '50%', top: '30%', transform: 'translateX(-50%)' }}
      >
        <button
          onClick={() => {
            setEnteringVault(true);
            setTimeout(() => navigate('/app/vault'), 1200);
          }}
          className="group relative flex flex-col items-center gap-4"
        >
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
        </button>
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
