import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Users, X, ChevronRight, ChevronDown, Folder } from 'lucide-react';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import { supabase } from '@/lib/supabase';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';
import type { ServerspaceMatter } from '@/hooks/useServerspaces';

interface ServerspaceRow {
  id: string;
  name: string;
  description: string | null;
  cover_url: string | null;
}

export default function ServerspaceView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { cardRef, toggleFullscreen } = useDraggableResizable();

  const [serverspace, setServerspace] = useState<ServerspaceRow | null>(null);
  const [matters, setMatters] = useState<ServerspaceMatter[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedMatters, setExpandedMatters] = useState<Set<string>>(new Set());

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
          <FullscreenToggle onToggle={toggleFullscreen} />
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
          <h2 className="text-[12px] font-semibold text-[#8a8693] uppercase tracking-wider mb-3">Matters</h2>
          {!loadError && tree.length === 0 && matters.length === 0 && serverspace && (
            <p className="text-[13px] text-white/50 py-6 text-center">
              No matters yet. Use the sidebar's <span className="text-[#e8b84a]">+</span> button on this serverspace to create one.
            </p>
          )}
          {tree.length > 0 && (
            <div className="rounded-lg border border-[rgba(255,255,255,0.06)] bg-[rgba(10,10,16,0.5)] py-1 overflow-hidden">
              {tree.map((node) => (
                <ServerMatterNode
                  key={node.matter.id}
                  node={node}
                  depth={0}
                  expandedMatters={expandedMatters}
                  toggleMatter={toggleMatter}
                  onOpen={(mId) => navigate(`/app/matterspace/${mId}`)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}


interface ServerMatterNodeProps {
  node: MatterTreeNode;
  depth: number;
  expandedMatters: Set<string>;
  toggleMatter: (id: string) => void;
  onOpen: (matterId: string) => void;
}

function ServerMatterNode({
  node,
  depth,
  expandedMatters,
  toggleMatter,
  onOpen,
}: ServerMatterNodeProps) {
  const { matter, children } = node;
  const hasChildren = children.length > 0;
  const isExpanded = expandedMatters.has(matter.id);
  const indent = 12 + depth * 16;

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
            <ServerMatterNode
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
