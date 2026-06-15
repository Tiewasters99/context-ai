import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ChevronRight, FolderInput, Inbox } from 'lucide-react';
import {
  listAllProductions, listMyMatters,
  type AllProductionsEntry, type MatterOption,
} from '@/lib/discovery';
import { DirectionBadge, StatusBadge, batesRangeLabel } from './bits';

// Standalone Discovery home: every production across every case the user can
// see, in one ledger — the product-level overview the per-matter tab can't
// give. "Cases" are matters; opening or starting one drops into the existing
// per-matter Discovery surface (reused) within the standalone shell.
export default function DiscoveryDashboard() {
  const navigate = useNavigate();
  const [productions, setProductions] = useState<AllProductionsEntry[]>([]);
  const [matters, setMatters] = useState<MatterOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const pickRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAllProductions(), listMyMatters()])
      .then(([prods, ms]) => {
        if (cancelled) return;
        setProductions(prods);
        setMatters(ms);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load Discovery'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  // Close the case picker on outside click.
  useEffect(() => {
    if (!picking) return;
    const onDown = (e: MouseEvent) => {
      if (pickRef.current && !pickRef.current.contains(e.target as Node)) setPicking(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [picking]);

  // Group productions by case (matter), preserving newest-first order.
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; serverspace: string | null; rows: AllProductionsEntry[] }>();
    for (const p of productions) {
      const g = map.get(p.matterspace_id) ?? { name: p.matter_name, serverspace: p.serverspace_name, rows: [] };
      g.rows.push(p);
      map.set(p.matterspace_id, g);
    }
    return [...map.entries()];
  }, [productions]);

  const fmtDate = (d: string | null) =>
    d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

  const startInCase = (matterId: string) => {
    setPicking(false);
    navigate(`/discovery/case?matter=${encodeURIComponent(matterId)}`);
  };

  return (
    <div className="max-w-5xl mx-auto px-8 py-10">
      {/* Masthead */}
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1 className="font-display text-[26px] tracking-tight text-white">Productions</h1>
          <p className="text-[12px] text-white/40 mt-1">
            Every incoming and outgoing production across your cases.
          </p>
        </div>
        <div className="relative" ref={pickRef}>
          <button
            onClick={() => setPicking((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#d4a054] hover:bg-[#e0b066] text-[#1a1408] text-[12px] font-semibold transition-colors"
          >
            <Plus size={14} strokeWidth={2.5} />
            New production
          </button>
          {picking && (
            <div className="absolute right-0 top-full mt-1.5 w-72 max-h-80 overflow-y-auto rounded-lg border border-[rgba(255,255,255,0.1)] shadow-2xl z-10 py-1"
                 style={{ backgroundColor: 'rgba(14,14,20,0.97)', backdropFilter: 'blur(20px)' }}>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-white/35">
                Start in which case?
              </div>
              {matters.length === 0 && (
                <div className="px-3 py-2 text-[12px] text-white/40">No cases available.</div>
              )}
              {matters.map((m) => (
                <button
                  key={m.id}
                  onClick={() => startInCase(m.id)}
                  className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-[rgba(255,255,255,0.05)] transition-colors"
                >
                  <FolderInput size={13} className="text-white/40 shrink-0" />
                  <span className="text-[13px] text-white/90 truncate flex-1">{m.name}</span>
                  {m.serverspace_name && (
                    <span className="text-[10px] text-white/30 shrink-0">{m.serverspace_name}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {loading && <div className="text-[13px] text-white/40 py-12 text-center">Loading productions…</div>}
      {error && <div className="text-[13px] text-[#f87171] py-6">{error}</div>}

      {!loading && !error && productions.length === 0 && (
        <div className="flex flex-col items-center justify-center text-center py-20 rounded-xl border border-dashed border-[rgba(255,255,255,0.1)]">
          <Inbox size={28} className="text-white/25 mb-3" />
          <div className="text-[14px] text-white/70 mb-1">No productions yet</div>
          <div className="text-[12px] text-white/40 mb-5 max-w-sm">
            Start a production to intake documents from opposing counsel, or to package and Bates-stamp your own for outgoing production.
          </div>
          <button
            onClick={() => setPicking(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#d4a054] hover:bg-[#e0b066] text-[#1a1408] text-[12px] font-semibold transition-colors"
          >
            <Plus size={14} strokeWidth={2.5} /> New production
          </button>
        </div>
      )}

      {/* Ledger, grouped by case */}
      <div className="space-y-6">
        {groups.map(([matterId, g]) => (
          <div key={matterId}>
            <div className="flex items-baseline gap-2 mb-2 px-1">
              <span className="text-[13px] font-semibold text-white/85">{g.name}</span>
              {g.serverspace && <span className="text-[10px] text-white/30 uppercase tracking-wider">{g.serverspace}</span>}
              <button
                onClick={() => startInCase(matterId)}
                className="ml-auto text-[11px] text-[#d4a054]/80 hover:text-[#e0b066] transition-colors"
              >
                Open case →
              </button>
            </div>
            <div className="rounded-xl overflow-hidden border border-[rgba(255,255,255,0.06)]"
                 style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
              {g.rows.map((p, i) => {
                const bates = batesRangeLabel(p);
                const party = p.direction === 'incoming' ? p.producing_party : p.receiving_party;
                return (
                  <button
                    key={p.id}
                    onClick={() => navigate(`/discovery/production/${p.id}`)}
                    className={`flex items-center gap-3 w-full px-4 py-3 text-left hover:bg-[rgba(255,255,255,0.03)] transition-colors ${
                      i > 0 ? 'border-t border-[rgba(255,255,255,0.05)]' : ''
                    }`}
                  >
                    <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[13px] text-white/90 truncate">{p.name}</span>
                        <DirectionBadge direction={p.direction} />
                        <StatusBadge status={p.status} />
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-white/40">
                        {party && <span className="truncate">{party}</span>}
                        <span>{p.item_count} {p.item_count === 1 ? 'item' : 'items'}</span>
                        {bates && <span className="text-[#d4a054]/70 tabular-nums">{bates}</span>}
                        <span>{fmtDate(p.production_date)}</span>
                      </div>
                    </div>
                    <ChevronRight size={15} className="text-white/25 shrink-0" />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
