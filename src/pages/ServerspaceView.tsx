import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Users, X, ChevronRight, ChevronDown, Folder, Plus } from 'lucide-react';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import PinToggle from '@/components/ui/PinToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import { supabase } from '@/lib/supabase';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';
import type { ServerspaceMatter } from '@/hooks/useServerspaces';
import NewMatterModal, { type NewMatterContext } from '@/components/matter/NewMatterModal';

interface ServerspaceRow {
  id: string;
  name: string;
  description: string | null;
  cover_url: string | null;
}

export default function ServerspaceView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { cardRef, toggleFullscreen, pinned, togglePin } = useDraggableResizable('cs.serverspace.card');

  const [serverspace, setServerspace] = useState<ServerspaceRow | null>(null);
  const [matters, setMatters] = useState<ServerspaceMatter[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedMatters, setExpandedMatters] = useState<Set<string>>(new Set());
  const [newMatterContext, setNewMatterContext] = useState<NewMatterContext | null>(null);

  // Re-fetch this serverspace's matters after a create. This view reads its
  // matters directly (not via useServerspaces), so it refetches itself.
  const fetchMatters = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase
      .from('matterspaces')
      .select('id, name, short_code, parent_matterspace_id')
      .eq('serverspace_id', id);
    setMatters((data ?? []) as ServerspaceMatter[]);
  }, [id]);

  const openNewMatter = useCallback(
    (serverspaceId: string, parentMatterId: string | null, contextLabel: string) => {
      setNewMatterContext({ serverspaceId, parentMatterId, contextLabel });
    },
    [],
  );

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoadError(null);
    setServerspace(null);
    setMatters([]);
    (async () => {
      const { data: s, error } = await supabase
        .from('serverspaces')
        .select('id, name, description, cover_url')
        .eq('id', id)
        .maybeSingle();
      if (cancelled) return;
      if (error) { setLoadError(error.message); return; }
      if (!s) { setLoadError('Serverspace not found'); return; }
      setServerspace(s as ServerspaceRow);

      const { data: ms } = await supabase
        .from('matterspaces')
        .select('id, name, short_code, parent_matterspace_id')
        .eq('serverspace_id', s.id);
      if (cancelled) return;
      setMatters((ms ?? []) as ServerspaceMatter[]);

      const { count } = await supabase
        .from('serverspace_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('serverspace_id', s.id);
      if (cancelled) return;
      setMemberCount(count ?? 0);
    })();
    return () => { cancelled = true; };
  }, [id]);

  const tree = buildMatterTree(matters);

  const toggleMatter = (mId: string) => {
    setExpandedMatters((prev) => {
      const next = new Set(prev);
      if (next.has(mId)) next.delete(mId);
      else next.add(mId);
      return next;
    });
  };

  const handleCoverChange = async (url: string | null) => {
    if (!serverspace) return;
    const { error } = await supabase
      .from('serverspaces')
      .update({ cover_url: url })
      .eq('id', serverspace.id);
    if (error) {
      console.error('cover save failed', error);
      return;
    }
    setServerspace({ ...serverspace, cover_url: url });
  };

  return (
    <div>
      <CoverImage
        coverUrl={serverspace?.cover_url ?? null}
        onCoverChange={handleCoverChange}
        editable={true}
      />

      <div ref={cardRef} className="max-w-5xl mx-auto px-8 py-8 rounded-xl backdrop-blur-[30px] border border-[rgba(255,255,255,0.06)] my-8 cursor-grab select-none" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
        {/* Close + drag handle + fullscreen */}
        <div className="flex items-center justify-between mb-4 -mt-1">
          <button
            onClick={() => navigate('/app')}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
            title="Back to dashboard"
          >
            <X size={14} strokeWidth={2} />
          </button>
          <div className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors" title="Drag to move" />
          <div className="flex items-center gap-1">
            <PinToggle pinned={pinned} onToggle={togglePin} />
            <FullscreenToggle onToggle={toggleFullscreen} />
          </div>
        </div>

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-[#d4a054]/10 flex items-center justify-center">
            <Users size={20} className="text-[#d4a054]" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-[#f5f2ed] truncate">
              {loadError ? 'Serverspace' : serverspace?.name ?? 'Loading…'}
            </h1>
            <p className="text-sm text-white/60">
              {memberCount} {memberCount === 1 ? 'member' : 'members'} · {matters.length} {matters.length === 1 ? 'matter' : 'matters'}
            </p>
            {serverspace?.description && <p className="text-sm text-white/80 mt-1">{serverspace.description}</p>}
            {loadError && <p className="text-sm text-red-300 mt-1">{loadError}</p>}
          </div>
        </div>

        {/* Matter tree */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[12px] font-semibold text-[#8a8693] uppercase tracking-wider">Matters</h2>
            {serverspace && (
              <button
                onClick={() => openNewMatter(serverspace.id, null, serverspace.name)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] text-[12px] text-white/80 hover:bg-[#1c1c26] hover:text-white transition-colors"
              >
                <Plus size={12} strokeWidth={2} />
                New matter
              </button>
            )}
          </div>
          {!loadError && tree.length === 0 && matters.length === 0 && serverspace && (
            <p className="text-[13px] text-white/50 py-6 text-center">
              No matters yet. Click <span className="text-[#e8b84a]">New matter</span> to create one.
            </p>
          )}
          {tree.length > 0 && serverspace && (
            <div className="rounded-lg border border-[rgba(255,255,255,0.14)] bg-[rgba(10,10,16,0.5)] py-1 overflow-hidden">
              {tree.map((node) => (
                <ServerMatterNode
                  key={node.matter.id}
                  node={node}
                  depth={0}
                  serverspaceId={serverspace.id}
                  ancestorLabel={serverspace.name}
                  expandedMatters={expandedMatters}
                  toggleMatter={toggleMatter}
                  onOpen={(mId) => navigate(`/app/matterspace/${mId}`)}
                  onAddChild={openNewMatter}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {newMatterContext && (
        <NewMatterModal
          context={newMatterContext}
          onClose={() => setNewMatterContext(null)}
          onCreated={() => { fetchMatters(); }}
        />
      )}
    </div>
  );
}


interface ServerMatterNodeProps {
  node: MatterTreeNode;
  depth: number;
  serverspaceId: string;
  ancestorLabel: string;
  expandedMatters: Set<string>;
  toggleMatter: (id: string) => void;
  onOpen: (matterId: string) => void;
  onAddChild: (serverspaceId: string, parentMatterId: string | null, contextLabel: string) => void;
}

function ServerMatterNode({
  node,
  depth,
  serverspaceId,
  ancestorLabel,
  expandedMatters,
  toggleMatter,
  onOpen,
  onAddChild,
}: ServerMatterNodeProps) {
  const { matter, children } = node;
  const hasChildren = children.length > 0;
  const isExpanded = expandedMatters.has(matter.id);
  const indent = 12 + depth * 16;
  const myLabel = `${ancestorLabel} / ${matter.name}`;

  return (
    <div>
      <div className="flex items-center hover:bg-[rgba(255,255,255,0.04)] transition-colors group">
        <button
          onClick={() => onOpen(matter.id)}
          className="flex items-center gap-2.5 flex-1 min-w-0 pr-2 py-1.5 text-left"
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
            <span className="text-[10px] text-white/30 ml-auto shrink-0">
              {children.length} sub-matter{children.length === 1 ? '' : 's'}
            </span>
          )}
        </button>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAddChild(serverspaceId, matter.id, myLabel);
          }}
          className="p-1 mr-3 rounded text-white/30 opacity-0 group-hover:opacity-100 hover:text-[#e8b84a] hover:bg-[rgba(255,255,255,0.04)] transition-all shrink-0"
          aria-label="Add sub-matter"
          title="Add sub-matter"
        >
          <Plus size={12} strokeWidth={2} />
        </button>
      </div>
      {isExpanded && hasChildren && (
        <div>
          {children.map((child) => (
            <ServerMatterNode
              key={child.matter.id}
              node={child}
              depth={depth + 1}
              serverspaceId={serverspaceId}
              ancestorLabel={myLabel}
              expandedMatters={expandedMatters}
              toggleMatter={toggleMatter}
              onOpen={onOpen}
              onAddChild={onAddChild}
            />
          ))}
        </div>
      )}
    </div>
  );
}
