import { useEffect } from 'react';
import { FileText, Film, ScanLine, Upload } from 'lucide-react';
import {
  whatFits,
  formatCents,
  formatCentsRange,
  type UploadEstimate,
  type UploadItemEstimate,
} from '../../../lib/ingest-estimate.mjs';
import type { UploadWallet } from '@/lib/ingest-estimate';

const GROUPS: { kind: UploadItemEstimate['kind']; label: string; icon: typeof FileText }[] = [
  { kind: 'pdf', label: 'Documents', icon: FileText },
  { kind: 'image', label: 'Scans and photographs', icon: ScanLine },
  { kind: 'media', label: 'Recordings', icon: Film },
  { kind: 'text', label: 'Text, spreadsheets and email', icon: FileText },
  { kind: 'stored', label: 'Stored to view, never read', icon: FileText },
];

/**
 * The bill, before the work — the same shape RunEstimateDialog gives a bulk
 * classify (src/components/matter/BucketizerSurface.tsx).
 *
 * Every figure here is arithmetic over lib/usage-prices.mjs, the table the
 * meter charges from. No rate is invented, the range is honest about the one
 * thing nobody can know before a file is read — whether a PDF's pages are text
 * or pictures of text — and the basis of each assumption is on the screen.
 */
export default function UploadEstimateDialog({
  estimate, reasons, wallet, fits, onCancel, onConfirm, onConfirmPartial,
}: {
  estimate: UploadEstimate;
  reasons: string[];
  wallet: UploadWallet;
  fits: ReturnType<typeof whatFits>;
  onCancel: () => void;
  onConfirm: () => void;
  onConfirmPartial: () => void;
}) {
  // Escape cancels. Nothing has been uploaded, so leaving must be effortless.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const groups = GROUPS
    .map((g) => ({ ...g, items: estimate.items.filter((it) => it.kind === g.kind) }))
    .filter((g) => g.items.length > 0);

  const allowanceLine = walletLine(wallet);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl border border-white/10 bg-zinc-950 p-5 shadow-2xl">
        <h3 className="text-base font-medium text-zinc-100">
          Upload {estimate.files.toLocaleString()} file{estimate.files === 1 ? '' : 's'}?
        </h3>
        <p className="mt-1 text-xs text-zinc-500">
          Shown because {reasons.join(', and ')}. Smaller uploads go straight through.
        </p>

        {/* THE NAMES. A dialog that said "Upload 412 files?" and then read a
            deposition nobody meant to send is what this list exists to
            prevent. */}
        <div className="mt-3 max-h-52 overflow-y-auto rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
          {groups.map((g) => (
            <div key={g.kind} className="mb-2 last:mb-0">
              <p className="text-[11px] uppercase tracking-wider text-zinc-500">
                {g.label} · {g.items.length.toLocaleString()}
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {/* Keyed by position: three exhibits called "Exhibit A" is the
                    normal case in a matter, not an edge case. */}
                {g.items.map((it, i) => (
                  <li key={`${g.kind}:${i}`} className="flex items-start gap-1.5 text-xs text-zinc-300">
                    <g.icon className="mt-0.5 w-3 h-3 shrink-0 text-zinc-600" />
                    <span className="min-w-0 break-words">{it.name}</span>
                    <span className="ml-auto shrink-0 pl-2 text-[11px] text-zinc-500">{measureOf(it)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <dl className="mt-4 space-y-2 text-sm">
          <Row label="Files" value={estimate.files.toLocaleString()} />
          {estimate.pdfPages > 0 && (
            <Row
              label="Pages"
              value={estimate.pdfPages.toLocaleString()}
              hint={estimate.unknownPages > 0
                ? `${estimate.unknownPages.toLocaleString()} of these could not be counted here and ${estimate.unknownPages === 1 ? 'its page count is' : 'their page counts are'} estimated from file size`
                : 'read from the files themselves, without opening them'}
            />
          )}
          {estimate.mediaMinutes > 0 && (
            <Row
              label="Recording"
              value={`${Math.round(estimate.mediaMinutes).toLocaleString()} min`}
              hint={estimate.unknownMinutes > 0
                ? `${estimate.unknownMinutes.toLocaleString()} could not be timed here and ${estimate.unknownMinutes === 1 ? 'its length is' : 'their lengths are'} estimated from file size`
                : 'from each recording’s own metadata'}
            />
          )}
          <Row
            label="Estimated cost"
            value={formatCentsRange(estimate.lowCents, estimate.highCents)}
            hint={rangeBasis(estimate)}
          />
          {allowanceLine && <Row label="Draws from" value={allowanceLine.value} hint={allowanceLine.hint} />}
        </dl>

        <p className="mt-4 text-xs leading-relaxed text-zinc-500">
          {estimate.pdfPages > 0 && (
            <>Nothing outside a PDF says whether its pages are text or pictures of text, so the
              range covers both: the lower figure indexes the text, the upper assumes every page
              is a scan and is read by {estimate.sealed ? 'the sealed OCR route' : 'an OCR provider'}.{' '}</>
          )}
          {estimate.sealed && (
            <>This matter is sealed, so its pages are read by AWS Textract inside our own AWS
              account and priced at that route’s rate — not the unsealed one.{' '}</>
          )}
          Rates are the ones this workspace meters at (lib/usage-prices.mjs); the estimate is
          deliberately high, and you are metered for what the pipeline actually does.
        </p>

        {fits.exceeds && (
          <div className="mt-3 rounded-lg border border-[#d4a054]/30 bg-[#d4a054]/[0.07] px-3 py-2 text-xs leading-relaxed text-[#d4a054]">
            <p className="font-medium">
              The upper estimate is more than is left this month
              {fits.remainingCents !== undefined ? ` (${formatCents(fits.remainingCents)} of allowance and credits)` : ''}.
            </p>
            <p className="mt-0.5">
              {fits.fitsCount === 0
                ? 'None of these would fit inside it. Nothing has been uploaded.'
                : `The first ${fits.fitsCount.toLocaleString()} of these ${estimate.files.toLocaleString()} fit (${formatCents(fits.fitsCents)}). Nothing has been uploaded yet.`}
            </p>
            <p className="mt-0.5 opacity-90">
              The upper figure is the worst case. You can send everything anyway — the meter is
              what actually stops a request, and it stops it before any money is spent.
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5"
          >
            Cancel
          </button>
          {fits.exceeds && fits.fitsCount > 0 && fits.fitsCount < estimate.files && (
            <button
              onClick={onConfirmPartial}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5"
            >
              Upload the first {fits.fitsCount.toLocaleString()}
            </button>
          )}
          <button
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-500/20"
          >
            <Upload className="w-4 h-4" /> {fits.exceeds ? 'Upload anyway' : 'Upload'}
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

/** The per-file figure in the list: pages, minutes, or nothing to say. */
function measureOf(it: UploadItemEstimate): string {
  if (it.kind === 'media') {
    const m = Math.round(it.minutes);
    return `${m.toLocaleString()} min${it.minutesKnown ? '' : ' (est.)'}`;
  }
  if (it.kind === 'pdf') {
    return `${it.pages.toLocaleString()} pp${it.pagesKnown ? '' : ' (est.)'}`;
  }
  return '';
}

function rangeBasis(estimate: UploadEstimate): string {
  const parts: string[] = [];
  if (estimate.pdfPages > 0) {
    parts.push(estimate.ocrRoute
      ? `scans at the ${estimate.sealed ? 'sealed' : 'unsealed'} matter’s OCR rate`
      : 'this matter sends no page to an OCR provider');
  }
  if (estimate.mediaMinutes > 0) parts.push('recordings at the metered per-minute rate');
  parts.push('text at the embedding rate');
  return parts.join(' · ');
}

/**
 * What the upload draws on, said only where it is actually known. A missing
 * billing table (067 not pasted, or a read that failed) produces SILENCE about
 * credits, never a "$0.00" that reads as a fact.
 */
function walletLine(wallet: UploadWallet): { value: string; hint: string } | null {
  if (wallet.unlimited) {
    return {
      value: 'no monthly cap',
      hint: 'this plan is not capped — the estimate is shown for information, and nothing here is blocked',
    };
  }
  if (!wallet.allowanceKnown || wallet.allowanceCents === null || wallet.usedCents === null) {
    return wallet.creditCents !== null
      ? { value: `${formatCents(wallet.creditCents)} in credits`, hint: 'this month’s allowance could not be read' }
      : null;
  }
  const value = `${formatCents(wallet.usedCents)} used of ${formatCents(wallet.allowanceCents)}`;
  const hint = wallet.creditCents !== null
    ? `this month’s allowance, then ${formatCents(wallet.creditCents)} in credits`
    : 'this month’s allowance';
  return { value, hint };
}

