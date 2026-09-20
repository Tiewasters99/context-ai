import { Quote } from 'lucide-react';
import { formatCents } from '@/lib/bucketizer';
import type { EvidenceEstimate } from '@/lib/bucketizer/evidence';

// The bill for the evidence pass, before the work.
//
// Same rule as the classify run (feedback: agent-economics-deterministic-first):
// documents, calls and dollars up front, and a click. Two things this dialog
// has to say that the classify one does not:
//
//   * WHAT IT WILL NOT READ. A confirmed classification that records no
//     candidate passages — every classification an attorney added by hand, and
//     every row the service-role CLI wrote, which still reads only the first
//     200 passages of a document — cannot be quoted from, and this pass does
//     not go looking. It is a number on the dialog, not a surprise in the
//     outline.
//   * WHAT IS ALREADY DONE. Resume lives on the classification row, so a pass
//     interrupted this morning picks up exactly where it stopped, from any
//     browser or machine, and pays for nothing twice.

export default function BucketizerEvidenceRunDialog({
  estimate,
  failed,
  onCancel,
  onConfirm,
  onRetryFailed,
}: {
  estimate: EvidenceEstimate;
  /** Pairings a previous pass could not use. */
  failed: number;
  onCancel: () => void;
  onConfirm: () => void;
  onRetryFailed: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl border border-white/10 bg-zinc-950 p-5 shadow-2xl">
        <h3 className="flex items-center gap-2 text-base font-medium text-zinc-100">
          <Quote className="w-4 h-4 text-[#d4a054]" />
          Find evidence in {estimate.pairs.toLocaleString()} document–issue pairing
          {estimate.pairs === 1 ? '' : 's'}?
        </h3>

        <dl className="mt-4 space-y-2 text-sm">
          <Row
            label="Pairings to read"
            value={estimate.pairs.toLocaleString()}
            hint={`${estimate.documents.toLocaleString()} documents across ${estimate.nodes.toLocaleString()} issues — confirmed classifications only`}
          />
          <Row
            label="Model calls"
            value={estimate.pairs.toLocaleString()}
            hint={`one per pairing, over the ${estimate.passages.toLocaleString()} passages the classifier already recorded`}
          />
          <Row
            label="Estimated cost"
            value={formatCents(estimate.cents)}
            hint={`at ${estimate.modelId} list rates — the estimate is deliberately high, and you are charged what the calls actually use`}
          />
        </dl>

        <p className="mt-4 text-xs leading-relaxed text-zinc-500">
          For each pairing the model picks the passages that support the issue and the exact words
          to quote. <strong className="text-zinc-400">Every quotation is then checked against the
          stored passage</strong>: if it is not there word for word it is discarded, never
          corrected. Quotations arrive as proposals for you to confirm or reject, and nothing
          unconfirmed goes into the body of the outline.
        </p>

        {estimate.pairsWithoutPassages > 0 && (
          <p className="mt-2 text-xs leading-relaxed text-[#d4a054]">
            {estimate.pairsWithoutPassages.toLocaleString()} confirmed pairing
            {estimate.pairsWithoutPassages === 1 ? '' : 's'} record no candidate passages — a
            classification added by hand, or one written by the older command-line classifier.
            {estimate.pairsWithoutPassages === 1 ? ' It' : ' They'} will be skipped and said so in
            the outline rather than quietly quoted from somewhere else. Re-classify those documents
            to give this pass something to read.
          </p>
        )}

        {estimate.pairsAlreadyRun > 0 && (
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">
            {estimate.pairsAlreadyRun.toLocaleString()} pairing
            {estimate.pairsAlreadyRun === 1 ? ' has' : 's have'} already been read and will not be
            charged again. You can stop at any time; closing the tab does not lose what is done.
          </p>
        )}

        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          If this matter is sealed, it is served by the sealed pen inside our own AWS account,
          which costs less than the figure above — you are metered at the price of the model that
          actually answers.
        </p>

        <div className="mt-5 flex items-center justify-end gap-2">
          {failed > 0 && (
            <button
              onClick={onRetryFailed}
              className="mr-auto rounded-lg border border-orange-500/30 px-3 py-1.5 text-xs text-orange-200 hover:bg-orange-500/10"
              title="Pairings whose answer could not be used are marked done so they are not paid for twice. This clears that mark."
            >
              Also retry {failed.toLocaleString()} that failed
            </button>
          )}
          <button
            onClick={onCancel}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={estimate.pairs === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
          >
            <Quote className="w-4 h-4" /> Run it
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/5 pb-2">
      <dt className="text-zinc-400">{label}</dt>
      <dd className="text-right">
        <span className="text-zinc-100">{value}</span>
        {hint && <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>}
      </dd>
    </div>
  );
}
