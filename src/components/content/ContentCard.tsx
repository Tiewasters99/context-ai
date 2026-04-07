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
  blue: 'bg-blue-500/15 text-blue-400',
  green: 'bg-emerald-500/15 text-emerald-400',
  red: 'bg-red-500/15 text-red-400',
  yellow: 'bg-amber-500/15 text-amber-400',
  purple: 'bg-violet-500/15 text-violet-400',
  pink: 'bg-pink-500/15 text-pink-400',
  gray: 'bg-white/5 text-[#8a8693]',
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
      className="flex w-full items-center gap-4 rounded-xl border border-[rgba(255,255,255,0.06)] bg-[rgba(10,10,16,0.72)] backdrop-blur-[20px] p-4 text-left transition-all hover:shadow-md hover:border-[rgba(255,255,255,0.1)]"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#1c1c26] text-[#8a8693]">
        <Icon size={20} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-medium text-[#f5f2ed]">
            {item.title}
          </h3>
          {item.is_locked && (
            <Lock size={14} className="shrink-0 text-[#d4a054]" />
          )}
        </div>
        <p className="text-xs text-[#5a5665]">
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
