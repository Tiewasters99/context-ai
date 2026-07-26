import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import {
  listPrivilegeLogEntries, updatePrivilegeLogEntry,
  PRIVILEGE_BASIS_LABELS,
  type PrivilegeLogEntry, type PrivilegeBasis, type ProductionItem,
} from '@/lib/discovery';
import FloatingPanel from './FloatingPanel';

const BASES = Object.keys(PRIVILEGE_BASIS_LABELS) as PrivilegeBasis[];

// Privilege Log — drafted automatically when a document is tagged
// Privileged in an outgoing production; finished here by the reviewer.
// Every field saves on blur (selects save immediately).
export default function PrivilegeLogPanel({
  productionId,
  items,
  refreshKey,
  onClose,
  onJump,
}: {
  productionId: string;
  items: ProductionItem[];
  refreshKey: number;
  onClose: () => void;
  onJump: (itemId: string) => void;
}) {
  const [entries, setEntries] = useState<PrivilegeLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await listPrivilegeLogEntries(productionId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load privilege log');
    } finally {
      setLoading(false);
    }
  }, [productionId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const save = async (id: string, patch: Parameters<typeof updatePrivilegeLogEntry>[1]) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    try {
      await updatePrivilegeLogEntry(id, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      void load();
    }
  };

  const filenameOf = (itemId: string) =>
    items.find((i) => i.id === itemId)?.original_filename ?? 'document';

  const inputCls =
    'w-full rounded bg-[rgba(18,18,28,0.6)] border border-transparent hover:border-[rgba(255,255,255,0.1)] focus:border-[#d4a054]/60 px-1.5 py-1 text-[11.5px] text-[#f0ebe3] placeholder:text-white/25 focus:outline-none transition-colors';

  return (
    <FloatingPanel
      title="Privilege Log"
      icon={<ShieldAlert size={14} />}
      accent="#f87171"
      storageKey="cs.discovery.privlog"
      defaultStyle={{ left: 360, top: 110, width: 520 }}
      onClose={onClose}
      headerExtra={
        <span className="text-[10px] text-white/40 tabular-nums shrink-0">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
        </span>
      }
    >
      <div className="px-3 py-3 cursor-default">
        {loading && <p className="text-[11px] text-white/40 py-4 text-center">Loading…</p>}
        {error && <p className="text-[11px] text-red-300 mb-2">{error}</p>}
        {!loading && entries.length === 0 && (
          <p className="text-[11.5px] text-white/45 py-5 text-center leading-relaxed">
            Nothing withheld yet. Tagging a document <span className="text-[#f87171]">Privileged</span>{' '}
            (press <kbd className="px-1 py-px rounded border border-white/20 text-[10px]">P</kbd>)
            drafts an entry here.
          </p>
        )}
        <div className="space-y-2.5">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-3 py-2.5"
            >
              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={() => onJump(entry.production_item_id)}
                  className="text-[11.5px] font-medium text-[#f5f1e8] hover:text-[#e8b84a] truncate transition-colors"
                  title="Show this document"
                >
                  {filenameOf(entry.production_item_id)}
                </button>
                <input
                  type="date"
                  value={entry.doc_date ?? ''}
                  onChange={(e) => void save(entry.id, { doc_date: e.target.value || null })}
                  className="ml-auto shrink-0 rounded bg-[rgba(18,18,28,0.6)] border border-transparent hover:border-[rgba(255,255,255,0.1)] focus:border-[#d4a054]/60 px-1.5 py-0.5 text-[10.5px] text-white/70 focus:outline-none"
                  title="Document date"
                />
              </div>
              <div className="grid grid-cols-3 gap-1.5 mb-1.5">
                <Field label="Author">
                  <input
                    defaultValue={entry.author ?? ''}
                    onBlur={(e) => { if (e.target.value !== (entry.author ?? '')) void save(entry.id, { author: e.target.value || null }); }}
                    placeholder="—"
                    className={inputCls}
                  />
                </Field>
                <Field label="Addressee">
                  <input
                    defaultValue={entry.addressee ?? ''}
                    onBlur={(e) => { if (e.target.value !== (entry.addressee ?? '')) void save(entry.id, { addressee: e.target.value || null }); }}
                    placeholder="—"
                    className={inputCls}
                  />
                </Field>
                <Field label="CC">
                  <input
                    defaultValue={entry.cc ?? ''}
                    onBlur={(e) => { if (e.target.value !== (entry.cc ?? '')) void save(entry.id, { cc: e.target.value || null }); }}
                    placeholder="—"
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label="Subject matter">
                <input
                  defaultValue={entry.subject_matter ?? ''}
                  onBlur={(e) => { if (e.target.value !== (entry.subject_matter ?? '')) void save(entry.id, { subject_matter: e.target.value || null }); }}
                  placeholder="—"
                  className={inputCls}
                />
              </Field>
              <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                <Field label="Basis for withholding">
                  <select
                    value={entry.basis}
                    onChange={(e) => void save(entry.id, { basis: e.target.value as PrivilegeBasis })}
                    className="w-full rounded bg-[rgba(18,18,28,0.85)] border border-[rgba(255,255,255,0.1)] px-1.5 py-1 text-[11.5px] text-[#f0ebe3] focus:outline-none focus:border-[#d4a054]/60"
                  >
                    {BASES.map((b) => (
                      <option key={b} value={b}>{PRIVILEGE_BASIS_LABELS[b]}</option>
                    ))}
                  </select>
                </Field>
                {entry.basis === 'custom' && (
                  <Field label="Custom basis">
                    <input
                      defaultValue={entry.basis_custom ?? ''}
                      onBlur={(e) => { if (e.target.value !== (entry.basis_custom ?? '')) void save(entry.id, { basis_custom: e.target.value || null }); }}
                      placeholder="State the basis"
                      className={inputCls}
                    />
                  </Field>
                )}
              </div>
              <div className="mt-1.5">
                <Field label="Description">
                  <textarea
                    defaultValue={entry.description ?? ''}
                    onBlur={(e) => { if (e.target.value !== (entry.description ?? '')) void save(entry.id, { description: e.target.value || null }); }}
                    rows={2}
                    placeholder="Describe the document without revealing the privileged content"
                    className={`${inputCls} resize-none`}
                  />
                </Field>
              </div>
            </div>
          ))}
        </div>
      </div>
    </FloatingPanel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[9px] font-semibold text-white/35 uppercase tracking-wider mb-0.5">{label}</span>
      {children}
    </label>
  );
}
