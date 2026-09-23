import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Trash2, X, ArrowUp, ArrowDown, Type, Hash, Calendar, CheckSquare, Download, Search, Loader2 } from 'lucide-react';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import CanvasPinToggle from '@/components/canvas/CanvasPinToggle';
import PinToggle from '@/components/ui/PinToggle';
import CoverModeToggle from '@/components/ui/CoverModeToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import type { EmbeddableViewProps } from '@/lib/canvas';
import { useCoverExpanded } from '@/hooks/useCoverExpanded';
import {
  useContentItem,
  updateContentItem,
  useContentInvalidate,
} from '@/hooks/useContentItems';
import { useAuth } from '@/contexts/AuthContext';
import { useAutosave } from '@/hooks/useUnsavedGuard';
import { saveStatusLine } from '@/lib/draft-store';

import {
  coerce,
  exportTable,
  gridToTable,
  isMultiCellPaste,
  parseClipboardGrid,
  type ColumnType,
  type TableColumn,
  type TableContent,
  type TableRow,
} from '@/lib/table-sheets';
import { downloadBlob, safeFilename } from '@/lib/export-page';

// A long sheet (an imported lead list) renders a page of rows at a time: a
// few thousand rows of live inputs would make every keystroke crawl.
const ROWS_PER_PAGE = 200;

const COLUMN_TYPES: { value: ColumnType; label: string; Icon: typeof Type }[] = [
  { value: 'text',     label: 'Text',     Icon: Type },
  { value: 'number',   label: 'Number',   Icon: Hash },
  { value: 'date',     label: 'Date',     Icon: Calendar },
  { value: 'checkbox', label: 'Checkbox', Icon: CheckSquare },
];

function readTableContent(content: Record<string, unknown> | undefined): TableContent {
  const rawCols = content?.columns;
  const rawRows = content?.rows;
  const columns = Array.isArray(rawCols)
    ? rawCols
        .map((c): TableColumn | null => {
          if (!c || typeof c !== 'object') return null;
          const o = c as Record<string, unknown>;
          if (typeof o.id !== 'string' || typeof o.name !== 'string') return null;
          // Backward compat: existing tables before this commit have no
          // type field — default to text.
          const type: ColumnType = isColumnType(o.type) ? o.type : 'text';
          return { id: o.id, name: o.name, type };
        })
        .filter((x): x is TableColumn => x !== null)
    : [];
  const rows = Array.isArray(rawRows)
    ? rawRows
        .map((r): TableRow | null => {
          if (!r || typeof r !== 'object') return null;
          const o = r as Record<string, unknown>;
          if (typeof o.id !== 'string') return null;
          const cells: Record<string, string | number | boolean | null> = {};
          if (o.cells && typeof o.cells === 'object') {
            for (const [k, v] of Object.entries(o.cells)) {
              if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                cells[k] = v;
              } else {
                cells[k] = String(v);
              }
            }
          }
          return { id: o.id, cells };
        })
        .filter((x): x is TableRow => x !== null)
    : [];
  if (columns.length === 0 && rows.length === 0) {
    return {
      columns: [
        { id: crypto.randomUUID(), name: 'Name', type: 'text' },
        { id: crypto.randomUUID(), name: 'Notes', type: 'text' },
      ],
      rows: [],
    };
  }
  return { columns, rows };
}

function isColumnType(v: unknown): v is ColumnType {
  return v === 'text' || v === 'number' || v === 'date' || v === 'checkbox';
}

/** What is saved for a table: its name and its grid, written together. */
interface TableDraft {
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
}

interface SortState {
  columnId: string;
  direction: 'asc' | 'desc';
}

export default function TableView({ id: propId, embedded = false, onClose }: EmbeddableViewProps = {}) {
  const params = useParams();
  const id = propId ?? params.id;
  const navigate = useNavigate();
  // Per-table geometry — see the matching note in ListView.
  const { cardRef, toggleFullscreen, pinned, togglePin, isMobile } = useDraggableResizable(
    embedded || !id ? undefined : `cs.tableview.card.${id}`,
    { boundToViewport: true },
  );
  const [coverExpanded, setCoverExpanded] = useCoverExpanded(id);
  const { data: item, isLoading, error } = useContentItem(id);
  const invalidate = useContentInvalidate();

  const [title, setTitle] = useState('');
  const [columns, setColumns] = useState<TableColumn[]>([]);
  const [rows, setRows] = useState<TableRow[]>([]);
  const [sort, setSort] = useState<SortState | null>(null);
  const [filter, setFilter] = useState('');
  const [shownRows, setShownRows] = useState(ROWS_PER_PAGE);
  const [exporting, setExporting] = useState<'xlsx' | 'csv' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);

  useEffect(() => { hydrated.current = false; }, [id]);

  // ONE writer for this table, serialized: a debounced write from typing in a
  // cell and an immediate one from adding a row can no longer overlap, and a
  // failure keeps the table dirty and retries.
  const { user } = useAuth();
  const tableDraftRef = useRef<TableDraft>({ title: '', columns: [], rows: [] });
  const saver = useAutosave<TableDraft>({
    userId: user?.id,
    itemId: id,
    // See the note on `mirror` in useUnsavedGuard: a cell holds a line, not a
    // manuscript, and every structural edit here already lands at once.
    mirror: false,
    save: async (value) => {
      if (!id) return;
      await updateContentItem(id, {
        title: value.title || 'Untitled Table',
        content: { columns: value.columns, rows: value.rows },
      });
      invalidate.invalidateItem(id);
    },
  });
  const { change: changeDraft, adopt: adoptDraft, flush: flushDraft } = saver;

  useEffect(() => {
    if (!item || hydrated.current) return;
    setTitle(item.title);
    const parsed = readTableContent(item.content);
    setColumns(parsed.columns);
    setRows(parsed.rows);
    if (titleRef.current) titleRef.current.textContent = item.title;
    // This IS the server's copy: the saver's baseline, not a change.
    tableDraftRef.current = { title: item.title, columns: parsed.columns, rows: parsed.rows };
    adoptDraft(tableDraftRef.current);
    hydrated.current = true;
  }, [item, adoptDraft]);

  /** A deliberate edit — write it now. */
  const commitNow = (patch: Partial<TableDraft>): Promise<boolean> => {
    tableDraftRef.current = { ...tableDraftRef.current, ...patch };
    changeDraft(tableDraftRef.current);
    return flushDraft();
  };
  /** Typing — write it when the typing stops. */
  const commitSoon = (patch: Partial<TableDraft>) => {
    tableDraftRef.current = { ...tableDraftRef.current, ...patch };
    changeDraft(tableDraftRef.current);
  };

  const persist = (nextCols: TableColumn[], nextRows: TableRow[]) =>
    commitNow({ columns: nextCols, rows: nextRows });

  const persistTitle = (next: string) => commitNow({ title: next });

  const handleTitleBlur = () => {
    const next = (titleRef.current?.textContent ?? '').trim();
    if (next === title) return;
    setTitle(next);
    void persistTitle(next);
  };

  const handleTitleInput = () => {
    commitSoon({ title: (titleRef.current?.textContent ?? '').trim() });
  };

  const addRow = () => {
    const next = [...rows, { id: crypto.randomUUID(), cells: {} }];
    setRows(next);
    persist(columns, next);
  };

  const deleteRow = (rowId: string) => {
    const next = rows.filter((r) => r.id !== rowId);
    setRows(next);
    persist(columns, next);
  };

  const addColumn = () => {
    const colName = prompt('Column name?');
    if (!colName?.trim()) return;
    const next = [...columns, { id: crypto.randomUUID(), name: colName.trim(), type: 'text' as ColumnType }];
    setColumns(next);
    persist(next, rows);
  };

  const updateColumn = (colId: string, patch: Partial<TableColumn>) => {
    const next = columns.map((c) => c.id === colId ? { ...c, ...patch } : c);
    setColumns(next);
    persist(next, rows);
  };

  const deleteColumn = (colId: string) => {
    if (!confirm('Delete this column? All cells in it will be lost.')) return;
    const nextCols = columns.filter((c) => c.id !== colId);
    const nextRows = rows.map((r) => {
      const { [colId]: _, ...rest } = r.cells;
      return { ...r, cells: rest };
    });
    setColumns(nextCols);
    setRows(nextRows);
    persist(nextCols, nextRows);
    if (sort?.columnId === colId) setSort(null);
  };

  // Typing in a cell. It updates the table in front of the person AND starts
  // the clock on a save, so a refresh mid-cell no longer costs the cell.
  // Blur still commits immediately, as it always did.
  const setCellLocal = (rowId: string, colId: string, value: string | number | boolean | null) => {
    const next = rows.map((r) => r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: value } } : r);
    setRows(next);
    commitSoon({ columns, rows: next });
  };

  const persistCell = (rowId: string, colId: string, value: string | number | boolean | null) => {
    const next = rows.map((r) => r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: value } } : r);
    setRows(next);
    persist(columns, next);
  };

  const toggleSort = (colId: string) => {
    setSort((prev) => {
      if (prev?.columnId !== colId) return { columnId: colId, direction: 'asc' };
      if (prev.direction === 'asc') return { columnId: colId, direction: 'desc' };
      return null;
    });
  };

  // A block of cells pasted from Excel, Google Sheets or Numbers lands with
  // its top-left corner in the cell it was pasted into, in the order the
  // table is shown (so a sorted or filtered table fills the rows you see).
  // Rows and columns are added when the block runs past the edge; every
  // value is converted to the type of the column it lands in.
  const pasteBlock = (rowId: string, colId: string, text: string) => {
    const grid = parseClipboardGrid(text);
    if (grid.length === 0) return;
    const startRow = displayRows.findIndex((r) => r.id === rowId);
    const startCol = columns.findIndex((c) => c.id === colId);
    if (startRow < 0 || startCol < 0) return;

    const width = Math.max(...grid.map((r) => r.length));
    const nextCols = [...columns];
    for (let c = nextCols.length; c < startCol + width; c++) {
      nextCols.push({ id: crypto.randomUUID(), name: `Column ${c + 1}`, type: 'text' });
    }
    const byId = new Map(rows.map((r) => [r.id, { ...r, cells: { ...r.cells } }]));
    const appended: TableRow[] = [];
    grid.forEach((values, r) => {
      const existing = displayRows[startRow + r];
      let target = existing ? byId.get(existing.id) : undefined;
      if (!target) {
        target = { id: crypto.randomUUID(), cells: {} };
        appended.push(target);
      }
      values.forEach((value, c) => {
        const col = nextCols[startCol + c];
        target.cells[col.id] = coerce(value, col.type);
      });
    });
    const nextRows = [...rows.map((r) => byId.get(r.id)!), ...appended];
    setColumns(nextCols);
    setRows(nextRows);
    void persist(nextCols, nextRows);
  };

  const pasteAsRows = (text: string) => {
    const grid = parseClipboardGrid(text);
    if (grid.length === 0) return;
    if (rows.length === 0) {
      const table = gridToTable(grid);
      if (!table) return;
      setColumns(table.content.columns);
      setRows(table.content.rows);
      setSort(null);
      void persist(table.content.columns, table.content.rows);
      return;
    }
    const appended: TableRow[] = grid.map((values) => {
      const cells: TableRow['cells'] = {};
      columns.forEach((col, c) => {
        const v = coerce(values[c], col.type);
        if (v !== null) cells[col.id] = v;
      });
      return { id: crypto.randomUUID(), cells };
    });
    const next = [...rows, ...appended];
    setRows(next);
    void persist(columns, next);
  };

  const handleExport = async (format: 'xlsx' | 'csv') => {
    if (exporting) return;
    setExporting(format);
    setExportError(null);
    try {
      const blob = await exportTable({ columns, rows }, title || 'Untitled Table', format);
      downloadBlob(blob, safeFilename(title || 'Untitled Table', `.${format}`));
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(null);
    }
  };

  useEffect(() => { setShownRows(ROWS_PER_PAGE); }, [filter, id]);

  // Sort and filter are display-only; the underlying rows array stays in
  // insertion order and is what is saved.
  const displayRows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const visible = needle
      ? rows.filter((r) => columns.some((c) => {
          const v = r.cells[c.id];
          return v !== null && v !== undefined && String(v).toLowerCase().includes(needle);
        }))
      : rows;
    if (!sort) return visible;
    const col = columns.find((c) => c.id === sort.columnId);
    if (!col) return visible;
    const sign = sort.direction === 'asc' ? 1 : -1;
    const cmp = (a: TableRow, b: TableRow) => {
      const av = a.cells[col.id];
      const bv = b.cells[col.id];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (col.type === 'number') {
        return sign * ((Number(av) || 0) - (Number(bv) || 0));
      }
      if (col.type === 'checkbox') {
        return sign * ((av ? 1 : 0) - (bv ? 1 : 0));
      }
      // text + date: lexicographic on string form (date is YYYY-MM-DD so it sorts correctly).
      return sign * String(av).localeCompare(String(bv));
    };
    return [...visible].sort(cmp);
  }, [rows, columns, sort, filter]);

  const pageRows = displayRows.length > shownRows ? displayRows.slice(0, shownRows) : displayRows;

  const handleCoverChange = async (url: string | null) => {
    if (!id) return;
    await updateContentItem(id, { cover_url: url });
    invalidate.invalidateItem(id);
  };

  const body = (
    <>
        {error && (
          <p className="text-[13px] text-red-300 py-12 text-center">
            {error instanceof Error ? error.message : 'Failed to load table'}
          </p>
        )}
        {!error && isLoading && (
          <p className="text-[13px] text-white/40 py-12 text-center">Loading…</p>
        )}
        {!error && !isLoading && !item && (
          <p className="text-[13px] text-white/40 py-12 text-center">Table not found.</p>
        )}

        {item && (
          <>
            <div
              ref={titleRef}
              contentEditable
              suppressContentEditableWarning
              onInput={handleTitleInput}
              onBlur={handleTitleBlur}
              className="text-2xl font-bold text-[#f5f2ed] outline-none mb-1 empty:before:content-['Untitled_Table'] empty:before:text-white/30"
            />
            <p className="text-[11px] text-white/30 mb-4">
              {saveStatusLine(saver.status)
                ?? `${rows.length.toLocaleString()} ${rows.length === 1 ? 'row' : 'rows'} · ${columns.length} ${columns.length === 1 ? 'column' : 'columns'}`}
            </p>

            {/* Find a row, and take the table away as a spreadsheet. Pasting
                a block of cells from Excel or Google Sheets into any cell
                fills the grid from that cell. */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <label className="flex items-center gap-2 flex-1 min-w-[180px] max-w-sm px-2.5 py-1.5 rounded-lg border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.03)] focus-within:border-[#e8b84a]/40">
                <Search size={12} className="text-white/40 shrink-0" />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter rows"
                  className="bg-transparent outline-none text-[12px] text-[#f5f1e8] placeholder:text-white/30 flex-1 min-w-0"
                />
                {filter && (
                  <button onClick={() => setFilter('')} className="text-white/40 hover:text-white" title="Clear filter">
                    <X size={11} />
                  </button>
                )}
              </label>
              {filter && (
                <span className="text-[11px] text-white/45">
                  {displayRows.length.toLocaleString()} of {rows.length.toLocaleString()} rows
                </span>
              )}
              <div className="flex items-center gap-1.5 ml-auto">
                {(['xlsx', 'csv'] as const).map((format) => (
                  <button
                    key={format}
                    onClick={() => void handleExport(format)}
                    disabled={!!exporting}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[rgba(255,255,255,0.12)] text-[12px] text-white/70 hover:text-white hover:bg-[rgba(255,255,255,0.05)] transition-colors disabled:opacity-40"
                    title={format === 'xlsx'
                      ? 'Download as an Excel workbook (opens in Excel, Google Sheets, Numbers)'
                      : 'Download as CSV'}
                  >
                    {exporting === format ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    {format === 'xlsx' ? 'Excel' : 'CSV'}
                  </button>
                ))}
              </div>
            </div>
            {exportError && <p className="text-[12px] text-red-300 mb-3">{exportError}</p>}

            <div
              className="overflow-x-auto rounded-lg border border-[rgba(255,255,255,0.22)] outline-none"
              tabIndex={-1}
              // The grid is for cells, not for moving the card: without this
              // a click on it starts a card drag, which keeps it from taking
              // focus, and a paste with no cell focused would go nowhere.
              data-card-inert
              onPaste={(e) => {
                // A paste inside a cell is the cell's (see Cell). This is a
                // paste with no cell focused: into an empty table it becomes
                // the table, headers and all; otherwise it adds rows.
                const t = e.target as HTMLElement;
                if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable) return;
                const text = e.clipboardData.getData('text/plain');
                if (!text || !isMultiCellPaste(text)) return;
                e.preventDefault();
                pasteAsRows(text);
              }}
            >
              <table className="w-full text-[13px] text-[#f5f1e8] border-collapse">
                <thead>
                  <tr className="bg-[rgba(255,255,255,0.06)]">
                    {columns.map((col) => (
                      <ColumnHeader
                        key={col.id}
                        col={col}
                        sort={sort?.columnId === col.id ? sort.direction : null}
                        onToggleSort={() => toggleSort(col.id)}
                        onRename={(name) => updateColumn(col.id, { name })}
                        onChangeType={(type) => updateColumn(col.id, { type })}
                        onDelete={() => deleteColumn(col.id)}
                      />
                    ))}
                    <th className="border-b border-[rgba(255,255,255,0.22)] w-12">
                      <button
                        onClick={addColumn}
                        className="px-2 py-2 text-white/40 hover:text-[#e8b84a] transition-colors"
                        title="Add column"
                      >
                        <Plus size={13} />
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.length === 0 ? (
                    <tr>
                      <td colSpan={columns.length + 1} className="px-3 py-8 text-center text-[12px] text-white/40">
                        {filter
                          ? 'No rows match the filter.'
                          : <>No rows yet. Click <span className="text-[#e8b84a]">Add row</span> below to start — or click here and paste cells copied from Excel or Google Sheets (their first row becomes the headers).</>}
                      </td>
                    </tr>
                  ) : pageRows.map((row) => (
                    <tr key={row.id} className="border-b border-[rgba(255,255,255,0.18)] hover:bg-[rgba(255,255,255,0.04)] group">
                      {columns.map((col) => (
                        <td key={col.id} className="border-r border-[rgba(255,255,255,0.18)] last:border-r-0 align-top">
                          <Cell
                            type={col.type}
                            value={row.cells[col.id] ?? null}
                            onChangeLocal={(v) => setCellLocal(row.id, col.id, v)}
                            onPersist={(v) => persistCell(row.id, col.id, v)}
                            onPasteBlock={(text) => pasteBlock(row.id, col.id, text)}
                          />
                        </td>
                      ))}
                      <td className="text-center">
                        <button
                          onClick={() => deleteRow(row.id)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded text-white/40 hover:text-red-300 hover:bg-red-300/10 transition-all"
                          title="Delete row"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {displayRows.length > pageRows.length && (
              <button
                onClick={() => setShownRows((n) => n + ROWS_PER_PAGE)}
                className="mt-3 w-full px-3 py-2 rounded-lg text-[12px] text-white/60 hover:text-white hover:bg-[rgba(255,255,255,0.04)] transition-colors"
              >
                Showing {pageRows.length.toLocaleString()} of {displayRows.length.toLocaleString()} rows — show {Math.min(ROWS_PER_PAGE, displayRows.length - pageRows.length).toLocaleString()} more
              </button>
            )}

            <button
              onClick={addRow}
              className="flex items-center gap-2 mt-3 px-3 py-2 rounded-lg border border-dashed border-[rgba(255,255,255,0.1)] text-[13px] text-white/60 hover:border-[rgba(255,255,255,0.2)] hover:text-white transition-colors w-full justify-center"
            >
              <Plus size={13} /> Add row
            </button>
          </>
        )}
    </>
  );

  if (embedded) {
    return <div className="px-4 py-3">{body}</div>;
  }

  return (
    <div>
      <CoverImage
        coverUrl={item?.cover_url ?? null}
        onCoverChange={handleCoverChange}
        editable={true}
        expanded={coverExpanded}
        onExpandChange={setCoverExpanded}
        persistKey={id ? `cs.cover.${id}` : undefined}
        inherit
        matterId={item?.space_type === 'matterspace' ? item.space_id : null}
      />

      <div ref={cardRef} className="max-w-6xl mx-auto px-8 pt-0 pb-8 rounded-xl backdrop-blur-[30px] border border-[rgba(255,255,255,0.06)] my-8 cursor-grab select-none" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
        {/* Close + drag handle + pin to canvas + fullscreen */}
        <div className="md:sticky md:top-0 z-20 flex items-center justify-between -mx-8 px-8 pt-6 pb-3 mb-4 rounded-t-xl border-b border-[rgba(255,255,255,0.08)] bg-[rgba(10,10,18,0.95)] backdrop-blur-[30px]">
          <button
            onClick={() => (onClose ? onClose() : navigate(-1))}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
            title="Back"
          >
            <X size={14} strokeWidth={2} />
          </button>
          <div className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors" title="Drag to move" />
          <div className="flex items-center gap-1">
            <CoverModeToggle hasCover={!!item?.cover_url} expanded={coverExpanded} onToggle={() => setCoverExpanded(!coverExpanded)} />
            {/* Fix in place. See the note in PageView. */}
            {!embedded && !isMobile && <PinToggle pinned={pinned} onToggle={togglePin} />}
            <CanvasPinToggle kind="table" id={id} title={title || item?.title || 'Untitled Table'} />
            <FullscreenToggle onToggle={toggleFullscreen} />
          </div>
        </div>

        {body}
      </div>
    </div>
  );
}


interface ColumnHeaderProps {
  col: TableColumn;
  sort: 'asc' | 'desc' | null;
  onToggleSort: () => void;
  onRename: (name: string) => void;
  onChangeType: (type: ColumnType) => void;
  onDelete: () => void;
}

function ColumnHeader({ col, sort, onToggleSort, onRename, onChangeType, onDelete }: ColumnHeaderProps) {
  const [name, setName] = useState(col.name);
  useEffect(() => { setName(col.name); }, [col.name]);
  const TypeIcon = COLUMN_TYPES.find((t) => t.value === col.type)?.Icon ?? Type;

  return (
    <th className="text-left font-medium border-b border-[rgba(255,255,255,0.22)]">
      <div className="flex items-center gap-1 px-2 py-2 group">
        <select
          value={col.type}
          onChange={(e) => onChangeType(e.target.value as ColumnType)}
          className="bg-transparent outline-none text-white/40 hover:text-white/70 text-[11px] cursor-pointer appearance-none pr-0.5 shrink-0"
          title="Column type"
        >
          {COLUMN_TYPES.map((t) => (
            <option key={t.value} value={t.value} className="bg-[#12121a] text-white">
              {t.label}
            </option>
          ))}
        </select>
        <TypeIcon size={11} className="text-white/30 shrink-0" />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => { if (name !== col.name) onRename(name.trim() || 'Column'); }}
          className="bg-transparent outline-none text-[#f5f2ed] font-medium flex-1 min-w-0"
        />
        <button
          onClick={onToggleSort}
          className={`p-0.5 rounded transition-colors shrink-0 ${
            sort
              ? 'text-[#e8b84a] bg-[#e8b84a]/10'
              : 'text-white/30 hover:text-white/60 opacity-0 group-hover:opacity-100'
          }`}
          title={sort === 'asc' ? 'Sorted ascending' : sort === 'desc' ? 'Sorted descending' : 'Sort'}
        >
          {sort === 'desc' ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
        </button>
        <button
          onClick={onDelete}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-white/40 hover:text-red-300 hover:bg-red-300/10 transition-all shrink-0"
          title="Delete column"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </th>
  );
}


interface CellProps {
  type: ColumnType;
  value: string | number | boolean | null;
  onChangeLocal: (v: string | number | boolean | null) => void;
  onPersist: (v: string | number | boolean | null) => void;
  /** A block of cells (tab/newline separated) pasted into this cell. */
  onPasteBlock: (text: string) => void;
}

function Cell({ type, value, onChangeLocal, onPersist, onPasteBlock }: CellProps) {
  // One value pastes into the cell as usual; a block copied from a
  // spreadsheet fills the grid from here instead of landing as one string.
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text || !isMultiCellPaste(text)) return;
    e.preventDefault();
    onPasteBlock(text);
  };

  if (type === 'checkbox') {
    return (
      <div className="px-3 py-2 flex items-center">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onPersist(e.target.checked)}
          className="w-4 h-4 rounded accent-[#e8b84a] cursor-pointer"
        />
      </div>
    );
  }

  if (type === 'number') {
    const display = value === null || value === undefined || value === '' ? '' : String(value);
    return (
      <input
        type="number"
        value={display}
        onChange={(e) => onChangeLocal(e.target.value)}
        onPaste={onPaste}
        onBlur={(e) => {
          const v = e.target.value;
          onPersist(v === '' ? null : Number(v));
        }}
        className="w-full px-3 py-2 bg-transparent outline-none text-[#f5f1e8] focus:bg-[rgba(232,184,74,0.04)] tabular-nums"
      />
    );
  }

  if (type === 'date') {
    const display = typeof value === 'string' ? value : '';
    return (
      <input
        type="date"
        value={display}
        onChange={(e) => onChangeLocal(e.target.value)}
        onPaste={onPaste}
        onBlur={(e) => onPersist(e.target.value || null)}
        className="w-full px-3 py-2 bg-transparent outline-none text-[#f5f1e8] focus:bg-[rgba(232,184,74,0.04)]"
      />
    );
  }

  // text
  const display = value == null ? '' : String(value);
  return (
    <input
      type="text"
      value={display}
      onChange={(e) => onChangeLocal(e.target.value)}
      onPaste={onPaste}
      onBlur={(e) => onPersist(e.target.value)}
      className="w-full px-3 py-2 bg-transparent outline-none text-[#f5f1e8] focus:bg-[rgba(232,184,74,0.04)]"
    />
  );
}
