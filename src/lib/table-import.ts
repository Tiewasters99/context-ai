// A spreadsheet file → Tables in a matter. Shared by the matter's Tables tab
// (Import spreadsheet) and the Vault (Open as table), so a workbook becomes
// the same tables whichever door it came through.
//
// Each non-empty sheet becomes its own table in the given matter — the
// file's matter, never another one (per-matter isolation). The file itself
// is not touched: in the Vault the original stays filed as it was, and the
// table is a working copy that can be downloaded again as .xlsx or .csv.

import { createContentItem, type SpaceRef } from '@/hooks/useContentItems';
import { baseName, importSummary, readSpreadsheet } from '@/lib/table-sheets';

export interface TableImportResult {
  /** content_items ids of the new tables, in sheet order. */
  ids: string[];
  /** One sentence for the person: what came in and what was cut. */
  summary: string;
  /** Some sheet was bigger than a table holds and was cut. */
  truncated: boolean;
}

export async function importSpreadsheetAsTables(
  file: Blob,
  fileName: string,
  space: SpaceRef,
): Promise<TableImportResult> {
  const sheets = await readSpreadsheet(file, fileName);
  const ids: string[] = [];
  const book = baseName(fileName);
  for (const sheet of sheets) {
    const title = sheets.length === 1 || sheet.name === book ? sheet.name : `${book} — ${sheet.name}`;
    const row = await createContentItem({
      space,
      contentType: 'database',
      title,
      content: { columns: sheet.content.columns, rows: sheet.content.rows },
    });
    ids.push(row.id);
  }
  return { ids, summary: importSummary(sheets), truncated: sheets.some((s) => s.truncated) };
}
