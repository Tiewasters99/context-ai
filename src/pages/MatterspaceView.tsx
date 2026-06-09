import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Folder, FileText, List, Table, DoorOpen, Plus, X, Lock, ChevronRight } from 'lucide-react';
import NewMatterModal, { type NewMatterContext } from '@/components/matter/NewMatterModal';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import PinToggle from '@/components/ui/PinToggle';
import ActivityFeed from '@/components/activity/ActivityFeed';
import MatterCalendar from '@/components/matter/MatterCalendar';
import CiteCheckSurface from '@/components/matter/CiteCheckSurface';
import MatterThread from '@/components/matter/MatterThread';
import MeetingsSurface from '@/components/matter/MeetingsSurface';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import { supabase } from '@/lib/supabase';
import {
  useContentItems,
  createContentItem,
  useContentInvalidate,
  type ContentType,
} from '@/hooks/useContentItems';

const tabs = ['Updates', 'Calendar', 'Pages', 'Lists', 'Tables', 'Cite-Check', 'Thread', 'Meetings', 'Vault'] as const;
type Tab = typeof tabs[number];
type ContentTab = Exclude<Tab, 'Vault' | 'Cite-Check' | 'Thread' | 'Meetings' | 'Updates' | 'Calendar'>;

const TAB_STORAGE_KEY = (matterId: string) => `cs.matterspace.tab:${matterId}`;

// Vault is an action (it navigates away), not a content state — never
// persisted or restored as a "last viewed" tab. The default landing tab
// is Updates: "what's happening" is the natural thing to see first. An
// optional ?tab= query param (used by activity-feed deep links) overrides
// both the saved tab and the default.
function loadInitialTab(matterId: string | undefined, override?: string | null): Tab {
  if (override && override !== 'Vault' && (tabs as readonly string[]).includes(override)) {
    return override as Tab;
  }
  if (!matterId) return 'Updates';
  try {
    const saved = localStorage.getItem(TAB_STORAGE_KEY(matterId));
    if (saved && saved !== 'Vault' && (tabs as readonly string[]).includes(saved)) {
      return saved as Tab;
    }
  } catch {}
  return 'Updates';
}

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
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>(() =>
    loadInitialTab(id, searchParams.get('tab')),
  );

  useEffect(() => {
    setActiveTab(loadInitialTab(id, searchParams.get('tab')));
  }, [id, searchParams]);

  useEffect(() => {
    if (!id || activeTab === 'Vault') return;
    try {
      localStorage.setItem(TAB_STORAGE_KEY(id), activeTab);
    } catch {}
  }, [activeTab, id]);
  const { cardRef, toggleFullscreen, pinned, togglePin } = useDraggableResizable('cs.matterspace.card');

  const [matter, setMatter] = useState<MatterRow | null>(null);
  const [serverspace, setServerspace] = useState<ServerspaceRow | null>(null);
  const [subMatters, setSubMatters] = useState<{ id: string; name: string }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newMatterContext, setNewMatterContext] = useState<NewMatterContext | null>(null);

  // Re-fetch just the child matters — used after creating a sub-matter so the
  // card updates without a full reload. (This view reads its own children
  // directly rather than via useServerspaces, so it must refetch itself.)
  const fetchSubMatters = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase
      .from('matterspaces')
      .select('id, name')
      .eq('parent_matterspace_id', id)
      .order('name');
    setSubMatters(data ?? []);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoadError(null);
    setMatter(null);
    setServerspace(null);
    setSubMatters([]);
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
      const [{ data: s }, { data: kids }] = await Promise.all([
        supabase.from('serverspaces').select('id, name').eq('id', m.serverspace_id).maybeSingle(),
        supabase.from('matterspaces').select('id, name').eq('parent_matterspace_id', m.id).order('name'),
      ]);
      if (cancelled) return;
      if (s) setServerspace(s as ServerspaceRow);
      setSubMatters(kids ?? []);
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
          <div className="flex items-center gap-1">
            <PinToggle pinned={pinned} onToggle={togglePin} />
            <FullscreenToggle onToggle={toggleFullscreen} />
          </div>
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

        {/* Sub-matters — always shown (with a create affordance) so the matter
            card mirrors the Vault/Sidebar: you can nest sub- and sub-sub-matters
            from anywhere. Each child opens its own card, so this one button
            gives creation at every depth. */}
        {matter && (
          <section className="mt-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[13px] font-semibold text-[#8a8693] uppercase tracking-wider">Sub-matters</h2>
              <button
                onClick={() =>
                  setNewMatterContext({
                    serverspaceId: matter.serverspace_id,
                    parentMatterId: matter.id,
                    contextLabel: serverspace ? `${serverspace.name} / ${matter.name}` : matter.name,
                  })
                }
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] text-[12px] text-white/80 hover:bg-[#1c1c26] hover:text-white transition-colors"
              >
                <Plus size={12} strokeWidth={2} />
                New sub-matter
              </button>
            </div>
            {subMatters.length > 0 ? (
              <div className="rounded-lg border border-[rgba(255,255,255,0.18)] bg-[rgba(22,22,34,0.85)] backdrop-blur-[20px] overflow-hidden divide-y divide-[rgba(255,255,255,0.06)]">
                {subMatters.map((sub) => (
                  <button
                    key={sub.id}
                    onClick={() => navigate(`/app/matterspace/${sub.id}`)}
                    className="flex items-center gap-2.5 w-full px-4 py-2.5 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors group"
                  >
                    <Folder size={14} className="text-[#d4a054]" strokeWidth={1.75} />
                    <span className="text-[13px] text-[#f5f1e8] truncate flex-1">{sub.name}</span>
                    <ChevronRight size={13} className="text-white/30 group-hover:text-[#e8b84a] transition-colors" strokeWidth={2} />
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-white/40">No sub-matters yet.</p>
            )}
          </section>
        )}

        {/* Tabs — wrap onto extra rows as the card narrows so no tab ever
            spills outside the card (the card resizes down to 300px wide). */}
        <div className="flex flex-wrap gap-x-1 gap-y-0.5 border-b border-[rgba(255,255,255,0.06)] mb-6 mt-6">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => {
                if (tab === 'Vault') enterVault();
                else setActiveTab(tab);
              }}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
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
        {activeTab === 'Updates' && matter && (
          <ActivityFeed matterId={matter.id} />
        )}
        {activeTab === 'Calendar' && matter && (
          <MatterCalendar matterId={matter.id} />
        )}
        {activeTab === 'Cite-Check' && matter && (
          <CiteCheckSurface matterId={matter.id} matterName={matter.name} />
        )}
        {activeTab === 'Thread' && matter && (
          <MatterThread matterId={matter.id} />
        )}
        {activeTab === 'Meetings' && matter && (
          <MeetingsSurface matterId={matter.id} />
        )}
        {activeTab !== 'Vault' && activeTab !== 'Cite-Check' && activeTab !== 'Thread' && activeTab !== 'Meetings' && activeTab !== 'Updates' && activeTab !== 'Calendar' && matter && (
          <ContentSurface tab={activeTab} matterId={matter.id} />
        )}
      </div>

      {newMatterContext && (
        <NewMatterModal
          context={newMatterContext}
          onClose={() => setNewMatterContext(null)}
          onCreated={() => { fetchSubMatters(); }}
        />
      )}
    </div>
  );
}


const TAB_TO_CONTENT_TYPE: Record<ContentTab, ContentType> = {
  Pages: 'page',
  Lists: 'list',
  Tables: 'database',
};

const TAB_META: Record<ContentTab, { Icon: typeof FileText; label: string; verb: string; route: string }> = {
  Pages:  { Icon: FileText, label: 'pages',  verb: 'page',  route: 'page' },
  Lists:  { Icon: List,     label: 'lists',  verb: 'list',  route: 'list' },
  Tables: { Icon: Table,    label: 'tables', verb: 'table', route: 'table' },
};

function ContentSurface({ tab, matterId }: { tab: ContentTab; matterId: string }) {
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
        <div className="rounded-lg border border-[rgba(255,255,255,0.14)] overflow-hidden divide-y divide-[rgba(255,255,255,0.08)]">
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
