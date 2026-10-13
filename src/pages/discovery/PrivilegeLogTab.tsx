import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Search, ShieldAlert } from 'lucide-react';
import {
  listTagDefs, listReviewTags, listDocumentPrivilegeEntries, updateDocumentPrivilegeEntry,
  documentTitles, privilegeLogCsv, isPrivilegeEntriesMissing, isReviewTagsMissing,
  PRIVILEGE_BASIS_LABELS,
  type DocumentPrivilegeEntry, type DocumentPrivilegePatch, type PrivilegeBasis,
} from '@/lib/discovery';

const BASES = Object.keys(PRIVILEGE_BASIS_LABELS) as PrivilegeBasis[];

// Discovery R3 (spec DISCOVERY-REVIEW-SETS-2026-10-12 §3.4): the matter's
// privilege log. One entry per document tagged Privileged on the Review tab
// (migration 116). Outgoing productions copy these entries; a production's
// copy follows the entry here until that production is stamped. Every field
// saves on blur (selects save immediately), as in the Review Room's panel.
export default function PrivilegeLogTab({ matterId, matterName }: { matterId: string; matterName: string }) {
  const [entries, setEntries] = useState<DocumentPrivilegeEntry[]>([]);
  // Documents tagged Privileged in this matter now. An entry whose tag was
  // removed is kept in the database (the work is not lost) but not listed.
  const [privilegedDocIds, setPrivilegedDocIds] = useState<Set<string>>(new Set());
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsSql, setNeedsSql] = useState<string | null>(null);
  const [text, setText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [defs, tags, list] = await Promise.all([
        listTagDefs(matterId), listReviewTags(matterId), listDocumentPrivilegeEntries(matterId),
      ]);
      const privDefs = new Set(defs.filter((d) => d.behavior === 'privileged').map((d) => d.id));
      const ids = new Set(tags.filter((t) => privDefs.has(t.tag_def_id)).map((t) => t.document_id));
      setPrivilegedDocIds(ids);
      setEntries(list);
      setTitles(await documentTitles(list.filter((e) => ids.has(e.document_id)).map((e) => e.document_id)));
      setNeedsSql(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isPrivilegeEntriesMissing(msg)) setNeedsSql('116');
      else if (isReviewTagsMissing(msg)) setNeedsSql('113');
      else setError(msg);
    } finally {
      setLoading(false);
    }
  }, [matterId]);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => entries
    .filter((e) => privilegedDocIds.has(e.document_id))
    .map((entry) => ({ entry, document: titles.get(entry.document_id) ?? 'Document' }))
    .sort((a, b) => (a.entry.doc_date ?? '9999').localeCompare(b.entry.doc_date ?? '9999') || a.document.localeCompare(b.document)),
  [entries, privilegedDocIds, titles]);

  const shown = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(({ entry: e, document }) =>
      [document, e.author, e.addressee, e.cc, e.subject_matter, e.description]
        .some((v) => (v ?? '').toLowerCase().includes(q)));
  }, [rows, text]);

  const missing = privilegedDocIds.size - rows.length;

  const save = async (id: string, patch: DocumentPrivilegePatch) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    try {
      await updateDocumentPrivilegeEntry(id, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      void load();
    }
  };

  const exportCsv = () => {
    const blob = new Blob([privilegeLogCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Privilege log - ${matterName.replace(/[\\/:*?"<>|]/g, '_')} - ${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const inputCls =
    'w-full rounded bg-[rgba(18,18,28,0.6)] border border-transparent hover:border-[rgba(255,255,255,0.1)] focus:border-[#d4a054]/60 px-1.5 py-1 text-[11.5px] text-[#f0ebe3] placeholder:text-white/25 focus:outline-none transition-colors';

  if (needsSql) {
    return (
      <div className="mb-3 rounded-md border border-[#e8b84a]/30 bg-[#e8b84a]/10 px-3 py-2 text-[12px] text-[#e8b84a]">
        The matter&rsquo;s privilege log needs one database update (migration {needsSql}) that has not been run yet.
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <ShieldAlert size={14} className="text-[#f87171]" />
        <span className="text-[12px] text-white/70">
          {loading ? 'Loading…' : `${rows.length} ${rows.length === 1 ? 'document' : 'documents'} tagged Privileged`}
        </span>
        <div className="relative ml-auto">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/35" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Filter the log"
            className="w-48 rounded-md bg-[rgba(18,18,28,0.78)] border border-[rgba(255,255,255,0.1)] pl-7 pr-2.5 py-1.5 text-[12px] text-[#f0ebe3] placeholder:text-white/30 focus:outline-none focus:border-[#d4a054]/60"
          />
        </div>
        <button
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-white/15 text-white/75 hover:text-white hover:border-white/30 text-[12px] transition-colors disabled:opacity-40"
          title="Download the log as a spreadsheet (CSV)"
        >
          <Download size={12} /> Export CSV
        </button>
      </div>

      <p className="text-[11px] text-white/40 mb-3 leading-relaxed">
        A production made from these documents copies its entries from here. Until that production is stamped, a change
        here reaches it and a change in its own Privilege Log comes back here. After stamping, the production keeps its own copy.
      </p>

      {error && <p className="text-[11px] text-red-300 mb-2">{error}</p>}
      {!loading && missing > 0 && (
        <p className="text-[11px] text-[#e8b84a]/80 mb-2">
          {missing} {missing === 1 ? 'document is' : 'documents are'} tagged Privileged with no entry yet. Remove the tag and
          tag again on the Review tab to draft {missing === 1 ? 'it' : 'them'}.
        </p>
      )}
      {!loading && rows.length === 0 && (
        <p className="text-[12px] text-white/45 py-8 text-center leading-relaxed">
          Nothing on the log yet. Tagging a document <span className="text-[#f87171]">Privileged</span> on the Review tab
          drafts its entry here.
        </p>
      )}

      <div className="grid gap-2.5 lg:grid-cols-2">
        {shown.map(({ entry, document: name }) => (
          <div
            key={entry.id}
            className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-3 py-2.5"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11.5px] font-medium text-[#f5f1e8] truncate" title={name}>{name}</span>
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
