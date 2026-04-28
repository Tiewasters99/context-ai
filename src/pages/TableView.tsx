import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Trash2, X } from 'lucide-react';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import {
  useContentItem,
  updateContentItem,
  useContentInvalidate,
} from '@/hooks/useContentItems';

interface TableColumn {
  id: string;
  name: string;
}

interface TableRow {
  id: string;
  cells: Record<string, string>;
}

interface TableContent {
  columns: TableColumn[];
  rows: TableRow[];
}

function readTableContent(content: Record<string, unknown> | undefined): TableContent {
  const rawCols = content?.columns;
  const rawRows = content?.rows;
  const columns = Array.isArray(rawCols)
    ? rawCols
        .map((c): TableColumn | null => {
          if (!c || typeof c !== 'object') return null;
          const o = c as Record<string, unknown>;
          if (typeof o.id !== 'string' || typeof o.name !== 'string') return null;
          return { id: o.id, name: o.name };
        })
        .filter((x): x is TableColumn => x !== null)
    : [];
  const rows = Array.isArray(rawRows)
    ? rawRows
        .map((r): TableRow | null => {
          if (!r || typeof r !== 'object') return null;
          const o = r as Record<string, unknown>;
          if (typeof o.id !== 'string') return null;
          const cells: Record<string, string> = {};
          if (o.cells && typeof o.cells === 'object') {
            for (const [k, v] of Object.entries(o.cells)) {
              if (typeof v === 'string') cells[k] = v;
              else if (v != null) cells[k] = String(v);
            }
          }
          return { id: o.id, cells };
        })
        .filter((x): x is TableRow => x !== null)
    : [];
  // First-table seed: a sensible default schema if the user has just
  // created an empty table. They can edit/delete columns immediately.
  if (columns.length === 0 && rows.length === 0) {
    return {
      columns: [
        { id: crypto.randomUUID(), name: 'Name' },
        { id: crypto.randomUUID(), name: 'Notes' },
      ],
      rows: [],
    };
  }
  return { columns, rows };
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
    const next = [...columns, { id: crypto.randomUUID(), name: colName.trim() }];
    setColumns(next);
    persist(next, rows);
  };

  const renameColumn = (colId: string, name: string) => {
    const next = columns.map((c) => c.id === colId ? { ...c, name } : c);
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
  };

  const setCell = (rowId: string, colId: string, value: string) => {
    setRows(rows.map((r) => r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: value } } : r));
  };

  const persistCell = (rowId: string, colId: string, value: string) => {
    const next = rows.map((r) => r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: value } } : r);
    setRows(next);
    persist(columns, next);
  };

  return (
    <div>
      <CoverImage editable />

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
              <table className="w-full text-[13px] text-[#e8e4de] border-collapse">
                <thead>
                  <tr className="bg-[rgba(255,255,255,0.03)]">
                    {columns.map((col) => (
                      <th key={col.id} className="text-left font-medium border-b border-[rgba(255,255,255,0.06)]">
                        <div className="flex items-center gap-1 px-3 py-2 group">
                          <input
                            type="text"
                            value={col.name}
                            onChange={(e) => setColumns(columns.map((c) => c.id === col.id ? { ...c, name: e.target.value } : c))}
                            onBlur={(e) => renameColumn(col.id, e.target.value.trim() || 'Column')}
                            className="bg-transparent outline-none text-[#f5f2ed] font-medium flex-1 min-w-0"
                          />
                          <button
                            onClick={() => deleteColumn(col.id)}
                            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-white/40 hover:text-red-300 hover:bg-red-300/10 transition-all shrink-0"
                            title="Delete column"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </th>
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
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={columns.length + 1} className="px-3 py-8 text-center text-[12px] text-white/40">
                        No rows yet. Click <span className="text-[#e8b84a]">Add row</span> below to start.
                      </td>
                    </tr>
                  ) : rows.map((row) => (
                    <tr key={row.id} className="border-b border-[rgba(255,255,255,0.04)] hover:bg-[rgba(255,255,255,0.02)] group">
                      {columns.map((col) => (
                        <td key={col.id} className="border-r border-[rgba(255,255,255,0.04)] last:border-r-0 align-top">
                          <input
                            type="text"
                            value={row.cells[col.id] ?? ''}
                            onChange={(e) => setCell(row.id, col.id, e.target.value)}
                            onBlur={(e) => persistCell(row.id, col.id, e.target.value)}
                            className="w-full px-3 py-2 bg-transparent outline-none text-[#e8e4de] focus:bg-[rgba(232,184,74,0.04)]"
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
