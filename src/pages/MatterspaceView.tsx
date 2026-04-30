import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Folder, FileText, List, Table, DoorOpen, Plus, X, Lock } from 'lucide-react';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import { supabase } from '@/lib/supabase';
import {
  useContentItems,
  createContentItem,
  useContentInvalidate,
  type ContentType,
} from '@/hooks/useContentItems';

const tabs = ['Pages', 'Lists', 'Tables', 'Vault'] as const;
type Tab = typeof tabs[number];

interface MatterRow {
  id: string;
  name: string;
  description: string | null;
  short_code: string | null;
  parent_matterspace_id: string | null;
  serverspace_id: string;
  cover_url: string | null;
}

interface ServerspaceRow {
  id: string;
  name: string;
}

export default function MatterspaceView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('Vault');
  const { cardRef, toggleFullscreen } = useDraggableResizable();

  const [matter, setMatter] = useState<MatterRow | null>(null);
  const [serverspace, setServerspace] = useState<ServerspaceRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoadError(null);
    setMatter(null);
    setServerspace(null);
    (async () => {
      const { data: m, error } = await supabase
        .from('matterspaces')
        .select('id, name, description, short_code, parent_matterspace_id, serverspace_id, cover_url')
        .eq('id', id)
        .maybeSingle();
      if (cancelled) return;
      if (error) { setLoadError(error.message); return; }
      if (!m) { setLoadError('Matter not found'); return; }
      setMatter(m as MatterRow);
      const { data: s } = await supabase
        .from('serverspaces')
        .select('id, name')
        .eq('id', m.serverspace_id)
        .maybeSingle();
      if (cancelled) return;
      if (s) setServerspace(s as ServerspaceRow);
    })();
    return () => { cancelled = true; };
  }, [id]);

  const enterVault = () => {
    if (!matter) return;
    const matterArg = matter.short_code ?? matter.id;
    navigate(`/app/vault?matter=${encodeURIComponent(matterArg)}`);
  };

  const handleCoverChange = async (url: string | null) => {
    if (!matter) return;
    const { error } = await supabase
      .from('matterspaces')
      .update({ cover_url: url })
      .eq('id', matter.id);
    if (error) {
      console.error('cover save failed', error);
      return;
    }
    setMatter({ ...matter, cover_url: url });
  };

  return (
    <div>
      <CoverImage
        coverUrl={matter?.cover_url ?? null}
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

        {/* Breadcrumb */}
        {serverspace && (
          <div className="text-[11px] text-white/40 mb-2">
            <Link to={`/app/serverspace/${serverspace.id}`} className="hover:text-[#e8b84a] transition-colors">
              {serverspace.name}
            </Link>
            <span className="mx-1.5">/</span>
            <span className="text-white/60">{matter?.name ?? '…'}</span>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-lg bg-[#d4a054]/10 flex items-center justify-center">
            <Folder size={20} className="text-[#d4a054]" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-[#f5f2ed] truncate">
              {loadError ? 'Matterspace' : matter?.name ?? 'Loading…'}
            </h1>
            {matter?.description && <p className="text-sm text-white/80">{matter.description}</p>}
            {loadError && <p className="text-sm text-red-300">{loadError}</p>}
          </div>
          {matter && (
            <button
              onClick={enterVault}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#e8b84a]/10 hover:bg-[#e8b84a]/20 border border-[#e8b84a]/30 text-[#e8b84a] text-[13px] font-medium transition-colors shrink-0"
              title="Open this matter's Vault"
            >
              <DoorOpen size={15} strokeWidth={1.75} />
              Enter Vault
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-[rgba(255,255,255,0.06)] mb-6 mt-6">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => {
                if (tab === 'Vault') enterVault();
                else setActiveTab(tab);
              }}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-[#d4a054] text-[#d4a054]'
                  : 'border-transparent text-white/80 hover:text-[#f5f1e8]'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Content */}
        {activeTab !== 'Vault' && matter && (
          <ContentSurface tab={activeTab} matterId={matter.id} />
        )}
      </div>
    </div>
  );
}


const TAB_TO_CONTENT_TYPE: Record<Exclude<Tab, 'Vault'>, ContentType> = {
  Pages: 'page',
  Lists: 'list',
  Tables: 'database',
};

const TAB_META: Record<Exclude<Tab, 'Vault'>, { Icon: typeof FileText; label: string; verb: string; route: string }> = {
  Pages:  { Icon: FileText, label: 'pages',  verb: 'page',  route: 'page' },
  Lists:  { Icon: List,     label: 'lists',  verb: 'list',  route: 'list' },
  Tables: { Icon: Table,    label: 'tables', verb: 'table', route: 'table' },
};

function ContentSurface({ tab, matterId }: { tab: Exclude<Tab, 'Vault'>; matterId: string }) {
  const navigate = useNavigate();
  const contentType = TAB_TO_CONTENT_TYPE[tab];
  const { Icon, label, verb, route } = TAB_META[tab];
  const space = { spaceId: matterId, spaceType: 'matterspace' as const };
  const { data: items = [], isLoading, error } = useContentItems(space, contentType);
  const invalidate = useContentInvalidate();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const row = await createContentItem({ space, contentType });
      invalidate.invalidateList(space, contentType);
      navigate(`/app/${route}/${row.id}`);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create');
      setCreating(false);
    }
  };

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={handleCreate}
          disabled={creating}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] text-[12px] text-white/80 hover:bg-[#1c1c26] hover:text-white transition-colors disabled:opacity-40"
        >
          <Plus size={12} strokeWidth={2} />
          {creating ? 'Creating…' : `New ${verb}`}
        </button>
      </div>
      {createError && (
        <p className="text-[12px] text-red-300 mb-3">{createError}</p>
      )}
      {isLoading && (
        <p className="text-center text-[12px] text-white/40 py-8">Loading…</p>
      )}
      {error && (
        <p className="text-center text-[12px] text-red-300 py-8">
          {error instanceof Error ? error.message : 'Failed to load'}
        </p>
      )}
      {!isLoading && !error && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Icon size={28} className="text-white/20 mb-3" strokeWidth={1.5} />
          <p className="text-[13px] text-white/50">
            No {label} yet. Click <span className="text-[#e8b84a]">New {verb}</span> to create one.
          </p>
        </div>
      )}
      {!isLoading && items.length > 0 && (
        <div className="rounded-lg border border-[rgba(255,255,255,0.06)] overflow-hidden divide-y divide-[rgba(255,255,255,0.04)]">
          {items.map((item) => (
            <Link
              key={item.id}
              to={`/app/${route}/${item.id}`}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-[rgba(255,255,255,0.04)] transition-colors group"
            >
              <Icon size={14} className="text-[#d4a054] shrink-0" strokeWidth={1.75} />
              <span className="text-[13px] text-[#f5f1e8] truncate flex-1">{item.title}</span>
              {item.is_locked && <Lock size={11} className="text-white/40 shrink-0" />}
              <span className="text-[10px] text-white/30 shrink-0">
                {new Date(item.updated_at).toLocaleDateString()}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
