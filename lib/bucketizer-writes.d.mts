// Hand-written declarations for bucketizer-writes.mjs (the SPA's tsconfig has
// allowJs off; the worker consumes the .mjs directly).

export interface ExistingClassification {
  id: string;
  node_id: string;
  status: 'proposed' | 'confirmed' | 'rejected';
}

export interface ProposedClassification {
  node_id: string;
  confidence: number;
  rationale: string | null;
  passage_ids: string[];
}

export interface WritePlan {
  /** Pairs with no row yet. */
  insert: ProposedClassification[];
  /** Undecided rows the re-read has something newer to say about. */
  refresh: { id: string; row: ProposedClassification }[];
  /** Rows left exactly as they are because you decided them. */
  keptDecided: string[];
  /**
   * Undecided rows the re-read no longer proposes. Left in place: deleting
   * machine work an attorney may be in the middle of reviewing is not
   * something a re-run gets to do quietly.
   */
  keptStale: string[];
}

export declare function planClassificationWrites(
  existing: ExistingClassification[],
  proposed: ProposedClassification[],
): WritePlan;

export declare function sentinelAfterRun(input: {
  existingRows: number;
  writtenRows: number;
  completedAt: string;
}): string | null;
