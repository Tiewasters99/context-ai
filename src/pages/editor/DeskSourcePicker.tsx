// Pull a manuscript from Contextspaces onto the Editor's desk: pick a
// matter, then a ready document; the document's indexed text (paged
// passages, via the cite-check corpus loader) is returned as plain text.

import { useEffect, useMemo, useState } from 'react';
import { Search, X, FileText, Folder, ChevronLeft } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { loadCorpusDocumentText } from '@/lib/cite-check/corpus';

type Matter = { id: string; name: string; parent_matterspace_id: string | null };
type Doc = { id: string; title: string | null; source_filename: string | null };

type Props = {
  onCancel: () => void;
  onLoaded: (text: string, title: string) => void;
};

export default function DeskSourcePicker({ onCancel, onLoaded }: Props) {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [matter, setMatter] = useState<Matter | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchingDoc, setFetchingDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from('matterspaces')
        .select('id, name, parent_matterspace_id')
        .order('name', { ascending: true });
      if (cancelled) return;
      if (error) setError(error.message);
      else setMatters((data ?? []) as Matter[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!matter) return;
    let cancelled = false;
    setLoading(true);
    setDocs([]);
    void (async () => {
      const { data, error } = await supabase
        .from('documents')
        .select('id, title, source_filename')
        .eq('matterspace_id', matter.id)
        .eq('processing_status', 'ready')
        .order('title', { ascending: true });
      if (cancelled) return;
      if (error) setError(error.message);
      else setDocs((data ?? []) as Doc[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [matter]);

  const nameById = useMemo(() => new Map(matters.map((m) => [m.id, m.name])), [matters]);
  const label = (m: Matter) =>
    m.parent_matterspace_id && nameById.get(m.parent_matterspace_id)
      ? `${nameById.get(m.parent_matterspace_id)} › ${m.name}`
      : m.name;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (matter) {
      const titled = docs.map((d) => ({ id: d.id, title: d.title || d.source_filename || 'Untitled document' }));
      return q ? titled.filter((d) => d.title.toLowerCase().includes(q)) : titled;
    }
    const labeled = matters.map((m) => ({ id: m.id, title: label(m), matter: m }));
    return q ? labeled.filter((m) => m.title.toLowerCase().includes(q)) : labeled;
  }, [matter, matters, docs, search]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pickDocument(id: string, title: string) {
    setFetchingDoc(id);
    setError(null);
    try {
      const loaded = await loadCorpusDocumentText(id);
      onLoaded(loaded.text, title);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFetchingDoc(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-[480px] max-w-full max-h-[70vh] flex flex-col rounded-xl border border-[rgba(255,255,255,0.1)] bg-[#1a1a22] shadow-2xl">
        <div className="flex items-center gap-2 px-4 h-11 border-b border-[rgba(255,255,255,0.08)]">
          {matter && (
            <button
              onClick={() => { setMatter(null); setSearch(''); setError(null); }}
              className="h-7 w-7 -ml-1 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/60 hover:text-white"
              title="Back to matters"
            >
              <ChevronLeft size={15} />
            </button>
          )}
          <span className="text-[13px] font-medium text-[var(--color-text-bright)] truncate flex-1">
            {matter ? matter.name : 'Pull a draft from your matters'}
          </span>
          <button
            onClick={onCancel}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/60 hover:text-white"
            title="Cancel"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-3 py-2 border-b border-[rgba(255,255,255,0.06)]">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/35" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={matter ? 'Search documents…' : 'Search matters…'}
              className="w-full h-8 pl-7 pr-2 rounded-md bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] text-[12px] text-[var(--color-text-bright)] placeholder:text-white/30 focus:outline-none focus:border-[var(--color-primary)]"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {error && <p className="text-[12px] text-red-300 py-4 px-4 text-center">{error}</p>}
          {loading && <p className="text-[12px] text-white/40 py-8 text-center">Loading…</p>}
          {!loading && rows.length === 0 && !error && (
            <p className="text-[12px] text-white/40 py-8 text-center">
              {matter ? 'No ready documents in this matter.' : 'No matters found.'}
            </p>
          )}
          {!loading && rows.length > 0 && (
            <ul className="py-1">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    onClick={() =>
                      'matter' in row
                        ? (setMatter((row as { matter: Matter }).matter), setSearch(''))
                        : void pickDocument(row.id, row.title)
                    }
                    disabled={fetchingDoc !== null}
                    className="flex items-center gap-3 w-full px-3 py-2 text-left transition hover:bg-white/4 disabled:opacity-50"
                  >
                    {matter ? (
                      <FileText size={14} className="text-[var(--color-primary)] shrink-0" strokeWidth={1.75} />
                    ) : (
                      <Folder size={14} className="text-[var(--color-primary)] shrink-0" strokeWidth={1.75} />
                    )}
                    <span className="text-[12.5px] text-[var(--color-text-bright)] truncate flex-1">{row.title}</span>
                    {fetchingDoc === row.id && <span className="text-[11px] text-white/45 shrink-0">Loading…</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
