import { FileText, List, Database, File, Lock } from 'lucide-react';
import type { ContentItem } from '@/lib/types';

interface ContentCardProps {
  item: ContentItem;
  onClick?: (item: ContentItem) => void;
}

const typeIcons = {
  page: FileText,
  list: List,
  database: Database,
  document: File,
} as const;

const tagColors: Record<string, string> = {
  blue: 'bg-blue-100 text-blue-700',
  green: 'bg-emerald-100 text-emerald-700',
  red: 'bg-red-100 text-red-700',
  yellow: 'bg-amber-100 text-amber-700',
  purple: 'bg-violet-100 text-violet-700',
  pink: 'bg-pink-100 text-pink-700',
  gray: 'bg-gray-100 text-gray-600',
};

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export default function ContentCard({ item, onClick }: ContentCardProps) {
  const Icon = typeIcons[item.content_type];

  return (
    <button
      onClick={() => onClick?.(item)}
      className="flex w-full items-center gap-4 rounded-xl border border-gray-200 bg-white p-4 text-left transition-all hover:shadow-md hover:border-gray-300"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500">
        <Icon size={20} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-medium text-gray-900">
            {item.title}
          </h3>
          {item.is_locked && (
            <Lock size={14} className="shrink-0 text-amber-500" />
          )}
        </div>
        <p className="text-xs text-gray-500">
          Modified {formatDate(item.updated_at)}
        </p>
      </div>

      {item.tags.length > 0 && (
        <div className="hidden gap-1.5 sm:flex">
          {item.tags.map((tag) => (
            <span
              key={tag.id}
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tagColors[tag.color] ?? tagColors.gray}`}
            >
              {tag.name}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
