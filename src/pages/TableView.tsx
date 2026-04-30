import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Trash2, X, ArrowUp, ArrowDown, Type, Hash, Calendar, CheckSquare } from 'lucide-react';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import {
  useContentItem,
  updateContentItem,
  useContentInvalidate,
} from '@/hooks/useContentItems';

type ColumnType = 'text' | 'number' | 'date' | 'checkbox';

interface TableColumn {
  id: string;
  name: string;
  type: ColumnType;
}

interface TableRow {
  id: string;
  cells: Record<string, string | number | boolean | null>;
}

interface TableContent {
  columns: TableColumn[];
  rows: TableRow[];
}

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

interface SortState {
  columnId: string;
  direction: 'asc' | 'desc';
}

export default function TableView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { cardRef, toggleFullscreen } = useDraggableResizable();
  const { data: item, isLoading, error } = useContentItem(id);
  const invalidate = useContentInvalidate();

  const [title, setTitle] = useState('');
  const [columns, setColumns] = useState<TableColumn[]>([]);
  const [rows, setRows] = useState<TableRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [sort, setSort] = useState<SortState | null>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);

  useEffect(() => { hydrated.current = false; }, [id]);

  useEffect(() => {
    if (!item || hydrated.current) return;
    setTitle(item.title);
    const parsed = readTableContent(item.content);
    setColumns(parsed.columns);
    setRows(parsed.rows);
    if (titleRef.current) titleRef.current.textContent = item.title;
    hydrated.current = true;
  }, [item]);

  const persist = async (nextCols: TableColumn[], nextRows: TableRow[]) => {
    if (!id) return;
    setSaving(true);
    try {
      await updateContentItem(id, { content: { columns: nextCols, rows: nextRows } });
      invalidate.invalidateItem(id);
    } catch (e) {
      console.error('save failed', e);
    } finally {
      setSaving(false);
    }
  };

  const persistTitle = async (next: string) => {
    if (!id) return;
    setSaving(true);
    try {
      await updateContentItem(id, { title: next || 'Untitled Table' });
      invalidate.invalidateItem(id);
    } catch (e) {
      console.error('title save failed', e);
    } finally {
      setSaving(false);
    }
  };

  const handleTitleBlur = () => {
    const next = (titleRef.current?.textContent ?? '').trim();
    if (next === title) return;
    setTitle(next);
    persistTitle(next);
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

  const setCellLocal = (rowId: string, colId: string, value: string | number | boolean | null) => {
    setRows(rows.map((r) => r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: value } } : r));
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

  // Sort is display-only; the underlying rows array stays in insertion order.
  const displayRows = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.columnId);
    if (!col) return rows;
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
    return [...rows].sort(cmp);
  }, [rows, columns, sort]);

  const handleCoverChange = async (url: string | null) => {
    if (!id) return;
    await updateContentItem(id, { cover_url: url });
    invalidate.invalidateItem(id);
  };

  return (
    <div>
      <CoverImage
        coverUrl={item?.cover_url ?? null}
        onCoverChange={handleCoverChange}
        editable={true}
      />

      <div ref={cardRef} className="max-w-6xl mx-auto px-8 py-8 rounded-xl backdrop-blur-[30px] border border-[rgba(255,255,255,0.06)] my-8 cursor-grab select-none" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
        {/* Close + drag handle + fullscreen */}
        <div className="flex items-center justify-between mb-4 -mt-1">
          <button
            onClick={() => navigate(-1)}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
            title="Back"
          >
            <X size={14} strokeWidth={2} />
          </button>
          <div className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors" title="Drag to move" />
          <FullscreenToggle onToggle={toggleFullscreen} />
        </div>

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
              onBlur={handleTitleBlur}
              className="text-2xl font-bold text-[#f5f2ed] outline-none mb-1 empty:before:content-['Untitled_Table'] empty:before:text-white/30"
            />
            <p className="text-[11px] text-white/30 mb-6">
              {saving ? 'Saving…' : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'} · ${columns.length} ${columns.length === 1 ? 'column' : 'columns'}`}
            </p>

            <div className="overflow-x-auto rounded-lg border border-[rgba(255,255,255,0.06)]">
              <table className="w-full text-[13px] text-[#f5f1e8] border-collapse">
                <thead>
                  <tr className="bg-[rgba(255,255,255,0.03)]">
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
                    <th className="border-b border-[rgba(255,255,255,0.06)] w-12">
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
                        No rows yet. Click <span className="text-[#e8b84a]">Add row</span> below to start.
                      </td>
                    </tr>
                  ) : displayRows.map((row) => (
                    <tr key={row.id} className="border-b border-[rgba(255,255,255,0.04)] hover:bg-[rgba(255,255,255,0.02)] group">
                      {columns.map((col) => (
                        <td key={col.id} className="border-r border-[rgba(255,255,255,0.04)] last:border-r-0 align-top">
                          <Cell
                            type={col.type}
                            value={row.cells[col.id] ?? null}
                            onChangeLocal={(v) => setCellLocal(row.id, col.id, v)}
                            onPersist={(v) => persistCell(row.id, col.id, v)}
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

            <button
              onClick={addRow}
              className="flex items-center gap-2 mt-3 px-3 py-2 rounded-lg border border-dashed border-[rgba(255,255,255,0.1)] text-[13px] text-white/60 hover:border-[rgba(255,255,255,0.2)] hover:text-white transition-colors w-full justify-center"
            >
              <Plus size={13} /> Add row
            </button>
          </>
        )}
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
    <th className="text-left font-medium border-b border-[rgba(255,255,255,0.06)]">
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
}

function Cell({ type, value, onChangeLocal, onPersist }: CellProps) {
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
      onBlur={(e) => onPersist(e.target.value)}
      className="w-full px-3 py-2 bg-transparent outline-none text-[#f5f1e8] focus:bg-[rgba(232,184,74,0.04)]"
    />
  );
}
