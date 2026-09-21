// Hand-written declarations for lib/ingest-estimate.mjs — the browser bundle
// imports that module directly (src/lib/ingest-estimate.ts and the Vault's
// upload dialog) so the figure a person confirms and the figure the handler
// re-checks come from one piece of arithmetic. Same pattern as
// ingest-formats.d.mts and usage-prices.d.mts; the SPA's tsconfig has allowJs
// off.

export type UploadItemKind = 'pdf' | 'image' | 'media' | 'text' | 'stored';

export interface UploadItemInput {
  name: string;
  bytes: number;
  /** PDF pages, when they were read from the file itself. */
  pages?: number;
  /** Duration in minutes, when it was read from the file itself. */
  minutes?: number;
  /** Overrides the extension taken from `name`. */
  ext?: string;
}

export interface UploadItemEstimate {
  name: string;
  ext: string;
  kind: UploadItemKind;
  bytes: number;
  pages: number;
  pagesKnown: boolean;
  minutes: number;
  minutesKnown: boolean;
  lowCents: number;
  highCents: number;
  /** What had to be assumed, in words, for this file. */
  basis: string[];
}

export interface UploadEstimate {
  items: UploadItemEstimate[];
  files: number;
  lowCents: number;
  highCents: number;
  pdfPages: number;
  mediaMinutes: number;
  largestPdfPages: number;
  longestMediaMinutes: number;
  unknownPages: number;
  unknownMinutes: number;
  tier: string;
  sealed: boolean;
  ocrRoute: string | null;
}

export interface UploadThresholds {
  cents: number;
  files: number;
  mediaMinutes: number;
  pdfPages: number;
}

export interface IngestDeclaration {
  confirmed: boolean;
  pages: number;
  minutes: number;
  ack_cents: number;
}

export declare const UPLOAD_ESTIMATE_THRESHOLDS: Readonly<UploadThresholds>;

export declare const ASSUMED_CHARS_PER_PAGE: number;
export declare const ASSUMED_TRANSCRIPT_CHARS_PER_MINUTE: number;
export declare const ASSUMED_BYTES_PER_PAGE: number;
export declare const FLOOR_BYTES_PER_PAGE: number;
export declare const ASSUMED_AUDIO_BYTES_PER_MINUTE_SPARSE: number;
export declare const ASSUMED_AUDIO_BYTES_PER_MINUTE_DENSE: number;
export declare const ASSUMED_VIDEO_BYTES_PER_MINUTE_SPARSE: number;
export declare const ASSUMED_VIDEO_BYTES_PER_MINUTE_DENSE: number;
export declare const CONTAINER_TEXT_FACTOR: number;

export declare function ocrRouteForTier(
  tier: string | null | undefined,
  env?: Record<string, string | undefined>,
): string | null;

export declare function isSealedTier(tier: string | null | undefined): boolean;

export declare function estimateUploadItem(
  item: UploadItemInput,
  options?: { tier?: string | null; env?: Record<string, string | undefined> },
): UploadItemEstimate;

export declare function estimateUpload(
  items: UploadItemInput[],
  options?: { tier?: string | null; env?: Record<string, string | undefined> },
): UploadEstimate;

export declare function thresholdVerdict(
  estimate: UploadEstimate,
  thresholds?: Partial<UploadThresholds>,
): { over: boolean; reasons: string[] };

export declare function whatFits(
  estimate: UploadEstimate,
  remainingCents: number | null | undefined,
): { exceeds: boolean; fitsCount: number; fitsCents: number; remainingCents?: number };

/** Does this ONE document owe the person a quote before it is read? */
export declare function documentNeedsConfirmation(
  item: UploadItemEstimate,
  thresholds?: Partial<UploadThresholds>,
): boolean;

export declare function declarationFor(
  item: UploadItemEstimate,
  options?: { confirmed?: boolean },
): IngestDeclaration;

/**
 * Which declaration a POST should carry.
 *   null      — measured, and no quote was owed. Send nothing.
 *   an object — a quote was shown and confirmed. Send it.
 *   undefined — never measured (an app-generated document). Form one from the
 *               name and size, and only if it is big enough to matter.
 */
export declare function chooseDeclaration(
  supplied: IngestDeclaration | null | undefined,
  file: { name: string; bytes: number },
): IngestDeclaration | null;

export declare function ingestRequestBody(
  documentId: string,
  declaration?: IngestDeclaration | null,
): string;

export declare function formatCents(cents: number): string;
export declare function formatCentsRange(lowCents: number, highCents: number): string;
