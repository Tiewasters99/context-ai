import { useCallback, useEffect, useRef, useState } from 'react';
import {
  estimateUpload,
  thresholdVerdict,
  whatFits,
  declarationFor,
  type IngestDeclaration,
  type UploadEstimate,
} from '../../../lib/ingest-estimate.mjs';
import UploadEstimateDialog from '@/components/vault/UploadEstimateDialog';
import {
  measureUploadFiles,
  readUploadWallet,
  remainingCents,
  effectiveAiTier,
  type UploadWallet,
} from '@/lib/ingest-estimate';

// ---------------------------------------------------------------------------
// The gate.
//
// An ordinary upload must be one gesture. A big one — a scanned production, a
// folder of four hundred exhibits, three hours of deposition video — must say
// what it will cost before it draws on the month. So: nothing at all below the
// threshold, and above it the Bucketizer's own dialog shape (names, counts,
// an estimated range, Confirm / Cancel), because a person should recognise the
// second cost dialog in this product from having read the first.
//
// Nothing is remembered between uploads. Every drop is judged on its own, and
// "don't ask me again" is deliberately absent: the whole value of the quote is
// that it is shown at the moment the money would be spent.
// ---------------------------------------------------------------------------

export interface GateResult {
  /** The files to upload — all of them, or the leading run the person chose. */
  files: File[];
  /**
   * Per file, aligned by index: the estimate that was confirmed, or undefined
   * for a file that never reached the threshold. An undefined entry leaves the
   * ingest request exactly as it was before this feature existed.
   */
  declarations: (IngestDeclaration | undefined)[];
}

interface Pending {
  files: File[];
  estimate: UploadEstimate;
  reasons: string[];
  wallet: UploadWallet;
  fits: ReturnType<typeof whatFits>;
  resolve: (r: GateResult | null) => void;
}

export function useUploadEstimateGate() {
  const [pending, setPending] = useState<Pending | null>(null);
  // A drop that is still being measured, or is sitting in an open dialog, when
  // the surface unmounts must not leave its caller's promise unresolved for
  // ever — the upload loop is awaiting it, and a promise that never settles is
  // a Vault that never finishes uploading and never says why.
  const live = useRef(true);
  const pendingRef = useRef<Pending | null>(null);
  useEffect(() => () => {
    live.current = false;
    pendingRef.current?.resolve(null);
    pendingRef.current = null;
  }, []);

  const gate = useCallback(async (files: File[], matterId: string): Promise<GateResult | null> => {
    if (!files.length) return { files, declarations: [] };

    const [items, tier] = await Promise.all([
      measureUploadFiles(files),
      effectiveAiTier(matterId),
    ]);
    const estimate = estimateUpload(items, { tier });
    const verdict = thresholdVerdict(estimate);
    if (!verdict.over) {
      // Below the threshold there is no dialog, no declaration, and the
      // request that follows is byte-for-byte the one this product has always
      // sent.
      return { files, declarations: files.map(() => undefined) };
    }
    // An above-threshold drop whose surface went away mid-measure reads as
    // CANCELLED, not as "send it anyway": there is no longer anywhere to show
    // the quote, and an upload nobody was quoted for is the thing this exists
    // to prevent.
    if (!live.current) return null;

    const wallet = await readUploadWallet();
    const fits = whatFits(estimate, remainingCents(wallet));
    if (!live.current) return null;

    return new Promise<GateResult | null>((resolve) => {
      const next = { files, estimate, reasons: verdict.reasons, wallet, fits, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  // `count` is how many of the drop to send: null is Cancel, and a number
  // shorter than the drop is the leading run that fits.
  const finish = useCallback((p: Pending, count: number | null) => {
    pendingRef.current = null;
    setPending(null);
    if (count === null) { p.resolve(null); return; }
    const n = Math.max(0, Math.min(count, p.files.length));
    p.resolve({
      files: p.files.slice(0, n),
      declarations: p.estimate.items.slice(0, n).map((it) => declarationFor(it)),
    });
  }, []);

  const dialog = pending ? (
    <UploadEstimateDialog
      estimate={pending.estimate}
      reasons={pending.reasons}
      wallet={pending.wallet}
      fits={pending.fits}
      onCancel={() => finish(pending, null)}
      onConfirm={() => finish(pending, pending.files.length)}
      onConfirmPartial={() => finish(pending, pending.fits.fitsCount)}
    />
  ) : null;

  return { gate, dialog };
}


/** The Vault's notice when the quote was declined. */
export const UPLOAD_CANCELLED_NOTICE =
  'Upload cancelled — nothing was uploaded and nothing was spent.';
