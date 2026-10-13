// Types for the browser's use of lib/discovery/families.mjs (Bates & Produce counts).
interface FamilyItem { id: string; sha256?: string | null; source_metadata?: Record<string, unknown> | null }
export function parentIdOf(item: FamilyItem): string | null;
export function withholdFamilies<T extends FamilyItem>(items: T[], excludedIds: Set<string>): {
  excludedIds: Set<string>; withParent: Array<{ item: T; parentId: string }>;
};
export function attachmentDuplicates<T extends FamilyItem>(items: T[]): Array<{ item: T; of: T }>;
