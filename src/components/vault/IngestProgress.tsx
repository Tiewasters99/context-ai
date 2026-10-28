import { readIngestProgress, INGEST_WHY, INGEST_WHY_SHORT } from '../../../lib/ingest-progress.mjs';
import type { IngestJobSnapshot } from '@/lib/vault-types';

// The bar under a document that is still being read (Eden, 10-26: the S-1
// sat at "extracting" for an hour with nothing to say how far it had got).
// It draws from what the worker already records — the stage on the document
// row and the page count in the job's progress note (lib/ingest-progress.mjs)
// — and says, in one line, why the wait exists at all: the pages are read,
// OCR'd and indexed so the AI can cite them. A PDF needs none of that to be
// opened, so the line offers "Open now" when the row can do it.
interface IngestProgressProps {
  /** documents.processing_status. */
  stage?: string;
  /** The ingest job's latest progress, polled with the status. */
  job?: IngestJobSnapshot;
  /** documents.page_count, once the pipeline has read the page tree. */
  pageCount?: number;
  /** The row opens the stored file now, before indexing finishes. */
  openNow?: boolean;
}

export default function IngestProgress({ stage, job, pageCount, openNow = false }: IngestProgressProps) {
  const r = readIngestProgress({
    stage,
    progress: job?.progress,
    note: job?.note,
    pageCount,
    attempts: job?.attempts,
  });
  return (
    <div className="mt-1 max-w-sm" data-card-inert>
      <div
        className="h-[3px] w-full rounded-full bg-white/10 overflow-hidden"
        role="progressbar"
        aria-label={r.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={r.indeterminate ? undefined : r.pct}
        title={r.detail ?? undefined}
      >
        <div
          className={`h-full rounded-full bg-[#e8b84a] transition-[width] duration-700 ease-out ${r.indeterminate ? 'animate-pulse' : ''}`}
          style={{ width: `${Math.max(r.pct, 2)}%` }}
        />
      </div>
      <p className="mt-0.5 text-[10px] text-white/50 truncate" title={INGEST_WHY}>
        <span className={r.retrying ? 'text-[#e8b84a]/90' : 'text-white/70'}>{r.label}</span>
        <span className="text-white/35"> · {INGEST_WHY_SHORT}</span>
        {openNow && <span className="text-[#e8b84a]/80"> · Open now</span>}
      </p>
    </div>
  );
}
