import type { ProductionStatus, ProductionDirection, DocumentTagDef, ProcessingJob } from '@/lib/discovery';
import { formatBates } from '@/lib/discovery';
import type { Production } from '@/lib/discovery';
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';

// Small shared atoms for the Discovery surfaces — chips, badges, progress.

export function DirectionBadge({ direction }: { direction: ProductionDirection }) {
  const incoming = direction === 'incoming';
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${
        incoming
          ? 'text-[#7dd3fc] border-[#7dd3fc]/30 bg-[#7dd3fc]/10'
          : 'text-[#d4a054] border-[#d4a054]/30 bg-[#d4a054]/10'
      }`}
    >
      {incoming ? <ArrowDownToLine size={10} strokeWidth={2.5} /> : <ArrowUpFromLine size={10} strokeWidth={2.5} />}
      {direction}
    </span>
  );
}

const STATUS_COLOR: Record<ProductionStatus, string> = {
  intake: '#7e7a72',
  processing: '#fbbf24',
  review: '#7dd3fc',
  stamped: '#d4a054',
  packaged: '#a78bfa',
  delivered: '#4ade80',
  received: '#4ade80',
  error: '#f87171',
};

export function StatusBadge({ status }: { status: ProductionStatus }) {
  const c = STATUS_COLOR[status] ?? '#7e7a72';
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wider"
      style={{ color: c, backgroundColor: `${c}1a`, border: `1px solid ${c}40` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: c }} />
      {status}
    </span>
  );
}

export function TagChip({
  def,
  small,
  onRemove,
}: {
  def: DocumentTagDef;
  small?: boolean;
  onRemove?: () => void;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${
        small ? 'px-1.5 py-px text-[9px]' : 'px-2 py-0.5 text-[10px]'
      }`}
      style={{ color: def.color, borderColor: `${def.color}55`, backgroundColor: `${def.color}14` }}
      title={def.is_endorsement ? `Endorsed on produced pages: "${def.endorsement_text ?? def.name.toUpperCase()}"` : def.name}
    >
      <span className={`rounded-full ${small ? 'w-1 h-1' : 'w-1.5 h-1.5'}`} style={{ backgroundColor: def.color }} />
      {def.name}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 opacity-60 hover:opacity-100 leading-none"
          title={`Remove ${def.name}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

// Bates range like "LIT_0000001 – LIT_0000482" from a production's config.
export function batesRangeLabel(p: Production): string | null {
  if (!p.bates_prefix || p.bates_start == null) return null;
  const first = formatBates(p.bates_prefix, p.bates_pad, p.bates_start);
  if (p.bates_end == null || p.bates_end === p.bates_start) return first;
  return `${first} – ${formatBates(p.bates_prefix, p.bates_pad, p.bates_end)}`;
}

export function JobProgress({ job }: { job: ProcessingJob }) {
  const running = job.status === 'running';
  const color = job.status === 'error' ? '#f87171' : running ? '#d4a054' : '#7e7a72';
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="w-28 h-1.5 rounded-full bg-white/10 overflow-hidden shrink-0">
        <div
          className={`h-full rounded-full transition-all ${running ? 'animate-pulse' : ''}`}
          style={{ width: `${Math.max(4, Math.min(100, job.progress))}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-[10px] tabular-nums shrink-0" style={{ color }}>
        {job.status === 'queued' ? 'queued' : `${job.progress}%`}
      </span>
      <span className="text-[10px] text-white/45 truncate">
        {job.error ?? job.progress_note ?? job.job_type.replace(/_/g, ' ')}
      </span>
    </div>
  );
}
