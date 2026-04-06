import { useNavigate } from 'react-router-dom';
import { FileText, List, Users, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import CoverImage from '@/components/layout/CoverImage';
import ContentCard from '@/components/content/ContentCard';
import type { ContentItem } from '@/lib/types';

const mockRecent: ContentItem[] = [
  {
    id: '1', title: 'Project Roadmap', content_type: 'page', space_id: 'cs1', space_type: 'clientspace',
    is_locked: false, tags: [{ id: 't1', name: 'Planning', color: 'blue' }], position: 0,
    created_by: 'u1', created_at: '2026-04-03T10:00:00Z', updated_at: '2026-04-04T09:30:00Z',
  },
  {
    id: '2', title: 'Sprint Backlog', content_type: 'list', space_id: 'cs1', space_type: 'clientspace',
    is_locked: false, tags: [{ id: 't2', name: 'Active', color: 'green' }], position: 1,
    created_by: 'u1', created_at: '2026-04-01T08:00:00Z', updated_at: '2026-04-04T08:00:00Z',
  },
  {
    id: '3', title: 'Client Directory', content_type: 'database', space_id: 'cs1', space_type: 'clientspace',
    is_locked: true, locked_by: 'u1', tags: [{ id: 't3', name: 'Important', color: 'red' }], position: 2,
    created_by: 'u1', created_at: '2026-03-20T12:00:00Z', updated_at: '2026-04-03T15:00:00Z',
  },
];

const mockServerspaces = [
  { id: '1', name: 'Marketing Team', members: 8, cover: null },
  { id: '2', name: 'Product Dev', members: 12, cover: null },
];

const quickActions = [
  { label: 'New Page', icon: FileText, path: '/app/page/new' },
  { label: 'New List', icon: List, path: '/app/list/new' },
  { label: 'Create Serverspace', icon: Plus, path: '#' },
];

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const displayName = user?.user_metadata?.display_name ?? 'there';

  return (
    <div>
      <CoverImage editable />

      <div className="max-w-5xl mx-auto px-8 py-8">
        <h1 className="text-2xl font-bold text-slate-900">
          Welcome back, {displayName}
        </h1>
        <p className="text-slate-500 mt-1">Here's what's happening in your workspace.</p>

        {/* Quick Actions */}
        <div className="grid grid-cols-3 gap-4 mt-8">
          {quickActions.map((a) => (
            <button
              key={a.label}
              onClick={() => navigate(a.path)}
              className="flex items-center gap-3 p-4 rounded-xl border border-slate-200 hover:border-indigo-300 hover:shadow-sm transition-all text-left group"
            >
              <div className="w-10 h-10 rounded-lg bg-indigo-50 group-hover:bg-indigo-100 flex items-center justify-center transition-colors">
                <a.icon size={18} className="text-indigo-500" />
              </div>
              <span className="text-sm font-medium text-slate-700">{a.label}</span>
            </button>
          ))}
        </div>

        {/* Recent Items */}
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">Recent Items</h2>
          <div className="space-y-2">
            {mockRecent.map((item) => (
              <ContentCard
                key={item.id}
                item={item}
                onClick={(i) => navigate(`/app/${i.content_type}/${i.id}`)}
              />
            ))}
          </div>
        </section>

        {/* Serverspaces */}
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">Your Serverspaces</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {mockServerspaces.map((s) => (
              <button
                key={s.id}
                onClick={() => navigate(`/app/serverspace/${s.id}`)}
                className="p-5 rounded-xl border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all text-left"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center">
                    <Users size={18} className="text-slate-500" />
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-slate-900">{s.name}</h3>
                    <p className="text-xs text-slate-500">{s.members} members</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
