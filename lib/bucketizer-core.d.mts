// Hand-written declarations for bucketizer-core.mjs (the SPA's tsconfig has
// allowJs off; the CLI consumes the .mjs directly).

export declare const TREE_INPUT_CHAR_BUDGET: number;
export declare const CLASSIFY_INPUT_CHAR_BUDGET: number;
export declare const MAX_ASSIGNMENTS_PER_DOC: number;

export declare const TREE_TOOL_NAME: string;
export declare const TREE_TOOL_DESCRIPTION: string;
export declare const TREE_SCHEMA: Record<string, unknown>;
export declare const TREE_SYSTEM: string;

export declare const CLASSIFY_TOOL_NAME: string;
export declare const CLASSIFY_TOOL_DESCRIPTION: string;
export declare const CLASSIFY_SCHEMA: Record<string, unknown>;
export declare const CLASSIFY_SYSTEM: string;

export interface TreeResultSubissue { label: string; description: string }
export interface TreeResultElement { label: string; description: string; subissues?: TreeResultSubissue[] }
export interface TreeResultClaim { label: string; description: string; elements: TreeResultElement[] }
export interface TreeResult { claims: TreeResultClaim[]; themes: { label: string; description: string }[] }

export interface ClassifyResult {
  assignments: { ref: string; confidence: number; rationale: string; passageRefs?: string[] }[];
}

export interface OutlineNode {
  id: string;
  parent_id: string | null;
  kind: string;
  label: string;
  description: string | null;
  position: number;
}

export declare function buildTreeUserContent(pleadings: { title: string; text: string }[]): string;

export declare function serializeOutline(nodes: OutlineNode[]): {
  outline: string;
  refToId: Map<string, string>;
};

export declare function buildClassifyUserContent(
  doc: { title: string; docType?: string | null },
  passages: { id: string; text: string }[],
  outline: string,
): { userContent: string; refToPassageId: Map<string, string> };

export declare function decodeAssignments(
  result: ClassifyResult,
  refToId: Map<string, string>,
  refToPassageId: Map<string, string>,
): { node_id: string; confidence: number; rationale: string | null; passage_ids: string[] }[];
