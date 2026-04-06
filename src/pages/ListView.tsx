import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, ChevronRight, ChevronDown, Circle, CheckCircle2, Clock } from 'lucide-react';

type ItemStatus = 'todo' | 'in_progress' | 'done';

interface ListItemData {
  id: string;
  title: string;
  description: string;
  status: ItemStatus;
  tags: string[];
}

const statusConfig: Record<ItemStatus, { icon: typeof Circle; label: string; color: string }> = {
  todo: { icon: Circle, label: 'To Do', color: 'text-slate-400' },
  in_progress: { icon: Clock, label: 'In Progress', color: 'text-amber-500' },
  done: { icon: CheckCircle2, label: 'Done', color: 'text-emerald-500' },
};

const nextStatus: Record<ItemStatus, ItemStatus> = {
  todo: 'in_progress',
  in_progress: 'done',
  done: 'todo',
};

const initialItems: ListItemData[] = [
  { id: '1', title: 'Design landing page mockup', description: 'Create high-fidelity mockup for the new landing page', status: 'done', tags: ['Design'] },
  { id: '2', title: 'Set up CI/CD pipeline', description: 'Configure GitHub Actions for automated deployment', status: 'in_progress', tags: ['DevOps'] },
  { id: '3', title: 'Write API documentation', description: 'Document all REST endpoints with examples', status: 'in_progress', tags: ['Docs'] },
  { id: '4', title: 'User authentication flow', description: 'Implement OAuth + email sign-in', status: 'done', tags: ['Backend'] },
  { id: '5', title: 'Performance audit', description: 'Run Lighthouse audit and address critical issues', status: 'todo', tags: ['Performance'] },
  { id: '6', title: 'Mobile responsive fixes', description: 'Fix layout issues on screens under 768px', status: 'todo', tags: ['Frontend'] },
];

export default function ListView() {
  const { id } = useParams();
  const [items, setItems] = useState<ListItemData[]>(initialItems);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const listTitle = id === 'new' ? 'New List' : 'Sprint Backlog';

  const toggleExpand = (itemId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const cycleStatus = (itemId: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === itemId ? { ...item, status: nextStatus[item.status] } : item
      )
    );
  };

  const doneCount = items.filter((i) => i.status === 'done').length;
  const progress = Math.round((doneCount / items.length) * 100);

  return (
    <div className="max-w-4xl mx-auto px-8 py-8">
      <h1 className="text-2xl font-bold text-slate-900">{listTitle}</h1>

      {/* Progress bar */}
      <div className="mt-4 mb-6">
        <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
          <span>{doneCount} of {items.length} complete</span>
          <span>{progress}%</span>
        </div>
        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Items */}
      <div className="space-y-1">
        {items.map((item) => {
          const isExpanded = expandedIds.has(item.id);
          const config = statusConfig[item.status];
          const StatusIcon = config.icon;

          return (
            <div key={item.id} className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors">
                {/* Status toggle */}
                <button
                  onClick={() => cycleStatus(item.id)}
                  className={`shrink-0 ${config.color} hover:opacity-70 transition-opacity`}
                  title={config.label}
                >
                  <StatusIcon size={18} />
                </button>

                {/* Title */}
                <span className={`flex-1 text-sm ${item.status === 'done' ? 'line-through text-slate-400' : 'text-slate-900'}`}>
                  {item.title}
                </span>

                {/* Tags */}
                <div className="hidden sm:flex gap-1.5">
                  {item.tags.map((tag) => (
                    <span key={tag} className="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600">
                      {tag}
                    </span>
                  ))}
                </div>

                {/* Expand */}
                <button
                  onClick={() => toggleExpand(item.id)}
                  className="p-1 rounded hover:bg-slate-100 text-slate-400 transition-colors"
                >
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              </div>

              {isExpanded && (
                <div className="px-4 py-3 bg-slate-50 border-t border-slate-100 text-sm text-slate-600">
                  {item.description}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add item */}
      <button className="flex items-center gap-2 mt-4 px-4 py-2.5 rounded-xl border border-dashed border-slate-300 text-sm text-slate-500 hover:border-slate-400 hover:text-slate-600 transition-colors w-full">
        <Plus size={16} /> Add item
      </button>
    </div>
  );
}
