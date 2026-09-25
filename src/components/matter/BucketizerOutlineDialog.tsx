import { useCallback, useState } from 'react';
import { AlertTriangle, Download, FileText, Loader2, Scale } from 'lucide-react';
import CardDialog from '@/components/ui/CardDialog';
import { downloadOutline, generateOutline, type OutlineResult } from '@/lib/bucketizer/outline';

// The Outline action.
//
// Two states and nothing clever: what the outline will say before it is built,
// and what it said once it is. The first screen is the honest one — it names
// the gaps and the citation limits BEFORE the attorney spends anything,
// because the most useful thing this feature can tell a litigator three weeks
// before a summary-judgment deadline is which elements have nothing under
// them.
//
// Generating is free: it is deterministic assembly over evidence already
// confirmed, with no model call anywhere in it. The only cost in this lane was
// paid in the evidence pass.

export default function BucketizerOutlineDialog({
  matterId,
  unconfirmedEvidence,
  onClose,
}: {
  matterId: string;
  /** Quotations proposed and not yet confirmed anywhere in the tree. */
  unconfirmedEvidence: number;
  onClose: () => void;
}) {
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<OutlineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);

  const run = useCallback(async () => {
    setError(null);
    setRunning('Starting…');
    try {
      setResult(await generateOutline({ matterId, reviewed, onProgress: setRunning }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The outline could not be built.');
    } finally {
      setRunning(null);
    }
  }, [matterId, reviewed]);

  return (
    <CardDialog
      storageKey="cs.dialog.bucketizerOutline"
      z={50}
      maxWidth={576}
      onClose={onClose}
      icon={<Scale className="w-4 h-4 text-[#d4a054]" />}
      title="Trial outline"
      // The first field here is the "counsel has reviewed" box; the cursor
      // must not wait on it, one space bar away from ticking it.
      autoFocus={false}
    >
      {!result && (
        <>
          <p className="mt-3 text-sm leading-relaxed text-zinc-400">
            Builds the outline from the tree and the quotations you have confirmed: what still
            needs evidence first, then every claim and element with its testimony set out
            verbatim under its citation. Both a Markdown and a Word copy are filed into the
            matter, and the Markdown copy is indexed so the outline is searchable beside the
            record it cites.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-zinc-500">
            Nothing is sent to a model here — the outline is assembled by code from evidence
            that is already confirmed, so running it costs nothing. Every run is a new dated
            version; none replaces one already filed.
          </p>

          {unconfirmedEvidence > 0 && (
            <p className="mt-3 rounded-lg border border-[#d4a054]/40 bg-[#d4a054]/10 px-3 py-2 text-xs text-[#d4a054]">
              {unconfirmedEvidence.toLocaleString()} quotation
              {unconfirmedEvidence === 1 ? ' is' : 's are'} proposed and not yet confirmed.
              {unconfirmedEvidence === 1 ? ' It' : ' They'} will appear under the relevant issue,
              marked as proposed, and never in the body as established.
            </p>
          )}

          <label className="mt-4 flex items-start gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={unconfirmedEvidence > 0}
              onChange={(e) => setReviewed(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Counsel has reviewed the evidence in this outline — leave the
              {' '}<strong>DRAFT — NOT REVIEWED BY COUNSEL</strong> legend off this version.
              {unconfirmedEvidence > 0 && (
                <span className="block text-[#d4a054]">
                  Not available while quotations are still unconfirmed.
                </span>
              )}
            </span>
          </label>
          <p className="mt-1 pl-6 text-[11px] leading-relaxed text-zinc-600">
            The legend is written into the file, and a filed file does not change afterwards.
            There is no stored "reviewed" flag, so this is asked each time rather than
            remembered from a version you looked at three weeks ago.
          </p>
        </>
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-sm text-zinc-300">
            <strong>{result.model.version}</strong> — {result.model.counts.evidenceConfirmed}{' '}
            confirmed quotation{result.model.counts.evidenceConfirmed === 1 ? '' : 's'} across{' '}
            {result.model.counts.claims} claim{result.model.counts.claims === 1 ? '' : 's'}, and{' '}
            {result.model.gaps.length} issue{result.model.gaps.length === 1 ? '' : 's'} still
            needing evidence.
          </p>
          <ul className="text-xs text-zinc-500 space-y-0.5">
            <li>
              {result.mdDocumentId
                ? <>Filed: <a className="text-zinc-300 hover:text-[#d4a054] underline underline-offset-2" href={`/app/document/${result.mdDocumentId}`} target="_blank" rel="noopener">{result.mdFilename}</a> — indexing now, then searchable.</>
                : <>Not filed: {result.mdFilename}</>}
            </li>
            <li>
              {result.docxDocumentId
                ? <>Filed: <a className="text-zinc-300 hover:text-[#d4a054] underline underline-offset-2" href={`/app/document/${result.docxDocumentId}`} target="_blank" rel="noopener">{result.docxFilename}</a></>
                : <>Not filed: {result.docxFilename}</>}
            </li>
          </ul>
          {result.notes.map((n, i) => (
            <p key={i} className="flex items-start gap-1.5 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-xs text-orange-200">
              <AlertTriangle className="mt-0.5 w-3.5 h-3.5 shrink-0" /> {n}
            </p>
          ))}
          {result.model.citationNotes.length > 0 && (
            <details className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
              <summary className="cursor-pointer text-xs text-zinc-400">
                What these citations can and cannot claim ({result.model.citationNotes.length})
              </summary>
              <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-zinc-500">
                {result.model.citationNotes.map((n, i) => <li key={i}>· {n}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        {running && (
          <span className="mr-auto inline-flex items-center gap-2 text-xs text-zinc-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> {running}
          </span>
        )}
        <button
          onClick={onClose}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5"
        >
          {result ? 'Close' : 'Cancel'}
        </button>
        {result ? (
          <button
            onClick={() => downloadOutline(result)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#d4a054]/40 bg-[#d4a054]/10 px-3 py-1.5 text-sm text-[#d4a054] hover:bg-[#d4a054]/20"
          >
            <Download className="w-4 h-4" /> Download both
          </button>
        ) : (
          <button
            onClick={() => void run()}
            disabled={Boolean(running)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
          >
            <FileText className="w-4 h-4" /> Build and file it
          </button>
        )}
      </div>
    </CardDialog>
  );
}
