// Hand-written declarations for llm-repair-content.mjs (the SPA's tsconfig has
// allowJs off; the worker and the API consume the .mjs directly).

export declare const REPAIR_ECHO_CHARS: number;

export declare function buildRepairContent(args: {
  original: string;
  reason: string;
  sent: unknown;
  shape: string;
  rules: string;
}): string;
