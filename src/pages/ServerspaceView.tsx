import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Users, UserPlus, Plus } from 'lucide-react';
import CoverImage from '@/components/layout/CoverImage';
import ContentCard from '@/components/content/ContentCard';
import type { ContentItem, ServerspaceMember } from '@/lib/types';

const tabs = ['Pages', 'Lists', 'Databases', 'Documents', 'Members'] as const;

const mockContent: Record<string, ContentItem[]> = {
  Pages: [
    { id: 'p1', title: 'Welcome & Onboarding', content_type: 'page', space_id: 's1', space_type: 'serverspace', is_locked: false, tags: [{ id: 't1', name: 'Onboarding', color: 'blue' }], position: 0, created_by: 'u1', created_at: '2026-04-01T10:00:00Z', updated_at: '2026-04-04T09:00:00Z' },
    { id: 'p2', title: 'Team Guidelines', content_type: 'page', space_id: 's1', space_type: 'serverspace', is_locked: true, locked_by: 'u1', tags: [{ id: 't2', name: 'Policy', color: 'red' }], position: 1, created_by: 'u1', created_at: '2026-03-28T10:00:00Z', updated_at: '2026-04-02T14:00:00Z' },
  ],
  Lists: [
    { id: 'l1', title: 'Q2 Campaign Tasks', content_type: 'list', space_id: 's1', space_type: 'serverspace', is_locked: false, tags: [{ id: 't3', name: 'Active', color: 'green' }], position: 0, created_by: 'u1', created_at: '2026-04-02T08:00:00Z', updated_at: '2026-04-04T11:00:00Z' },
  ],
  Databases: [
    { id: 'd1', title: 'Contact Directory', content_type: 'database', space_id: 's1', space_type: 'serverspace', is_locked: false, tags: [], position: 0, created_by: 'u1', created_at: '2026-03-15T10:00:00Z', updated_at: '2026-04-03T16:00:00Z' },
  ],
  Documents: [
    { id: 'doc1', title: 'Brand Guidelines.pdf', content_type: 'document', space_id: 's1', space_type: 'serverspace', is_locked: false, tags: [{ id: 't4', name: 'Brand', color: 'purple' }], position: 0, created_by: 'u1', created_at: '2026-03-10T10:00:00Z', updated_at: '2026-03-10T10:00:00Z' },
  ],
};

const mockMembers: ServerspaceMember[] = [
  { id: 'm1', serverspace_id: '1', user_id: 'u1', role: 'owner', display_name: 'You', joined_at: '2026-03-01T00:00:00Z' },
  { id: 'm2', serverspace_id: '1', user_id: 'u2', role: 'admin', display_name: 'Sarah Chen', joined_at: '2026-03-05T00:00:00Z' },
  { id: 'm3', serverspace_id: '1', user_id: 'u3', role: 'member', display_name: 'James Wilson', joined_at: '2026-03-10T00:00:00Z' },
  { id: 'm4', serverspace_id: '1', user_id: 'u4', role: 'member', display_name: 'Maria Garcia', joined_at: '2026-03-12T00:00:00Z' },
  { id: 'm5', serverspace_id: '1', user_id: 'u5', role: 'viewer', display_name: 'Alex Kim', joined_at: '2026-03-20T00:00:00Z' },
];

const serverspaceNames: Record<string, string> = {
  '1': 'Marketing Team',
  '2': 'Product Dev',
};

const roleColors: Record<string, string> = {
  owner: 'bg-amber-100 text-amber-700',
  admin: 'bg-indigo-100 text-indigo-700',
  member: 'bg-slate-100 text-slate-600',
  viewer: 'bg-slate-50 text-slate-500',
};

export default function ServerspaceView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<typeof tabs[number]>('Pages');

  const name = serverspaceNames[id ?? ''] ?? 'Serverspace';

  return (
    <div>
      <CoverImage editable />

      <div className="max-w-5xl mx-auto px-8 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center">
              <Users size={20} className="text-indigo-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">{name}</h1>
              <p className="text-sm text-slate-500">{mockMembers.length} members</p>
            </div>
          </div>
          <button className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium transition-colors">
            <UserPlus size={16} /> Invite
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-slate-200 mb-6">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Content */}
        {activeTab !== 'Members' ? (
          <div>
            <div className="flex justify-end mb-4">
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 transition-colors">
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
                <p className="text-center text-slate-400 py-12">No {activeTab.toLowerCase()} yet. Create your first one.</p>
              )}
            </div>
          </div>
        ) : (
          <div>
            <div className="flex justify-end mb-4">
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium transition-colors">
                <UserPlus size={14} /> Invite Members
              </button>
            </div>
            <div className="space-y-2">
              {mockMembers.map((member) => (
                <div
                  key={member.id}
                  className="flex items-center gap-4 p-4 rounded-xl border border-slate-200"
                >
                  <div className="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center text-sm font-medium text-slate-600">
                    {member.display_name?.[0] ?? '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900">{member.display_name}</p>
                    <p className="text-xs text-slate-500">Joined {new Date(member.joined_at).toLocaleDateString()}</p>
                  </div>
                  <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${roleColors[member.role]}`}>
                    {member.role}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
