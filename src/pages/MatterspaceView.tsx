import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Folder, Plus } from 'lucide-react';
import CoverImage from '@/components/layout/CoverImage';
import ContentCard from '@/components/content/ContentCard';
import type { ContentItem } from '@/lib/types';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';

const tabs = ['Pages', 'Lists', 'Databases', 'Documents'] as const;

const mockContent: Record<string, ContentItem[]> = {
  Pages: [
    { id: 'mp1', title: 'Case Overview', content_type: 'page', space_id: 'ms1', space_type: 'matterspace', is_locked: false, tags: [{ id: 't1', name: 'Active', color: 'green' }], position: 0, created_by: 'u1', created_at: '2026-04-02T10:00:00Z', updated_at: '2026-04-04T12:00:00Z' },
    { id: 'mp2', title: 'Meeting Notes — April 3', content_type: 'page', space_id: 'ms1', space_type: 'matterspace', is_locked: false, tags: [], position: 1, created_by: 'u1', created_at: '2026-04-03T14:00:00Z', updated_at: '2026-04-03T16:00:00Z' },
  ],
  Lists: [
    { id: 'ml1', title: 'Action Items', content_type: 'list', space_id: 'ms1', space_type: 'matterspace', is_locked: false, tags: [{ id: 't2', name: 'Urgent', color: 'red' }], position: 0, created_by: 'u1', created_at: '2026-04-01T09:00:00Z', updated_at: '2026-04-04T10:00:00Z' },
  ],
  Databases: [],
  Documents: [
    { id: 'md1', title: 'Contract_v2.docx', content_type: 'document', space_id: 'ms1', space_type: 'matterspace', is_locked: true, locked_by: 'u1', tags: [{ id: 't3', name: 'Legal', color: 'purple' }], position: 0, created_by: 'u1', created_at: '2026-03-28T10:00:00Z', updated_at: '2026-04-02T11:00:00Z' },
  ],
};

const matterspaceNames: Record<string, { name: string; description: string }> = {
  m1: { name: 'Q2 Campaign', description: 'Planning and execution for Q2 marketing campaign' },
  m2: { name: 'Brand Assets', description: 'Brand guidelines, logos, and design resources' },
  m3: { name: 'Sprint Planning', description: 'Sprint planning and retrospective documents' },
  m4: { name: 'Bug Triage', description: 'Bug reports and triage tracking' },
};

export default function MatterspaceView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<typeof tabs[number]>('Pages');
  const { cardRef, toggleFullscreen } = useDraggableResizable();

  const info = matterspaceNames[id ?? ''] ?? { name: 'Matterspace', description: '' };

  return (
    <div>
      <CoverImage editable />

      <div ref={cardRef} className="max-w-5xl mx-auto px-8 py-8 rounded-xl backdrop-blur-[30px] border border-[rgba(255,255,255,0.06)] my-8 cursor-grab select-none" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
        {/* Drag handle + fullscreen */}
        <div className="flex items-center justify-between mb-4 -mt-1">
          <div className="w-6" />
          <div className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors" title="Drag to move" />
          <FullscreenToggle onToggle={toggleFullscreen} />
        </div>
        {/* Header */}
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-lg bg-[#d4a054]/10 flex items-center justify-center">
            <Folder size={20} className="text-[#d4a054]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[#f5f2ed]">{info.name}</h1>
            {info.description && <p className="text-sm text-white/80">{info.description}</p>}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-[rgba(255,255,255,0.06)] mb-6 mt-6">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-[#d4a054] text-[#d4a054]'
                  : 'border-transparent text-white/80 hover:text-[#e8e4de]'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex justify-end mb-4">
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.06)] text-sm text-white/80 hover:bg-[#1c1c26] transition-colors">
            <Plus size={14} /> New {activeTab.slice(0, -1)}
          </button>
        </div>
        <div className="space-y-2">
          {(mockContent[activeTab] ?? []).map((item) => (
            <ContentCard
              key={item.id}
              item={item}
              onClick={(i) => navigate(`/app/${i.content_type}/${i.id}`)}
            />
          ))}
          {(mockContent[activeTab] ?? []).length === 0 && (
            <p className="text-center text-white/70 py-12">No {activeTab.toLowerCase()} yet. Create your first one.</p>
          )}
        </div>
      </div>
    </div>
  );
}
