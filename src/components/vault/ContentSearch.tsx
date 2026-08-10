import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Loader2, X, FileText, AlertCircle } from 'lucide-react';
import { sandboxApi } from '@/lib/sandbox-api';

// Real content search over the corpus — the same hybrid engine (semantic +
// keyword, page:line citations) the MCP tools use, via /api/sandbox. With a
// matterId it scopes to that matter tree; without one it searches every
// matter the user can see.

interface SearchHit {
  passage_id: string;
  document_id: string;
  document_title: string;
  citation: string;
  text?: string;
  text_preview?: string;
  matter?: { id: string; short_code: string | null; name: string };
}

interface SearchResponse {
  result_count: number;
  results: SearchHit[];
  note?: string;
}

export default function ContentSearch({ matterId }: { matterId?: string }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!q.trim() || searching) return;
    setSearching(true);
    setError(null);
    setHits(null);
    setNote(null);
    try {
      const out = await sandboxApi<SearchResponse>('search', {
        q: q.trim(),
        ...(matterId ? { matter: matterId } : {}),
        limit: 10,
      });
      setHits(out.results ?? []);
      setNote(out.note ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const clear = () => { setQ(''); setHits(null); setError(null); setNote(null); };

  return (
    <div className="mt-6">
      <div className="relative">
        {searching
          ? <Loader2 size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#e8b84a] animate-spin" />
          : <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />}
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') run(); if (e.key === 'Escape') clear(); }}
          placeholder={matterId
            ? 'Search inside this matter’s documents… (Enter)'
            : 'Search inside all documents, across every matter… (Enter)'}
          className="w-full pl-9 pr-9 py-2.5 rounded-lg border border-[rgba(232,184,74,0.25)] bg-[rgba(232,184,74,0.04)] text-[13px] text-white placeholder-white/35 focus:outline-none focus:ring-1 focus:ring-[#e8b84a]"
        />
        {(q || hits) && (
          <button onClick={clear} className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-white/40 hover:text-white">
            <X size={13} />
          </button>
        )}
      </div>

      {error && (
        <p className="flex items-start gap-2 text-[12px] text-red-400 mt-2">
          <AlertCircle size={13} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}
      {note && <p className="text-[11px] text-amber-400/80 mt-2">{note}</p>}

      {hits && (
        <div className="mt-3 space-y-1.5">
          {hits.length === 0 ? (
            <p className="text-[12px] text-white/50 px-1">
              No passages matched. Try different words — search covers document contents, not just names.
            </p>
          ) : (
            hits.map((h) => (
              <button
                key={h.passage_id}
                onClick={() => navigate(`/app/document/${h.document_id}`)}
                className="w-full text-left px-3 py-2.5 rounded-lg border border-[rgba(255,255,255,0.07)] hover:border-[rgba(232,184,74,0.35)] hover:bg-[rgba(232,184,74,0.04)] transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <FileText size={12} className="text-[#e8b84a] shrink-0" />
                  <span className="text-[12px] text-[#e8b84a]/90 font-medium truncate">{h.citation}</span>
                  {h.matter && (
                    <span className="text-[10px] text-white/40 bg-[rgba(255,255,255,0.06)] rounded-full px-2 py-0.5 ml-auto shrink-0">
                      {h.matter.name}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-white/60 leading-relaxed line-clamp-3">
                  {(h.text_preview ?? h.text ?? '').slice(0, 280)}
                </p>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
