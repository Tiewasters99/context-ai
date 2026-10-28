// Types for lib/trademark/rows.mjs — read every row, not the first page.
export declare const PAGE_ROWS: number;
export function selectAll<T = any>(
  build: () => any,
  opts?: { pageSize?: number },
): Promise<{ data: T[] | null; error: any }>;
