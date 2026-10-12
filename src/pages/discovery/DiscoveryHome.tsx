import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Stamp, X, FolderInput, RefreshCw, ChevronRight,
  ArrowDownToLine, ArrowUpFromLine, Trash2,
} from 'lucide-react';
import PinToggle from '@/components/ui/PinToggle';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import { resolveMatter, type MatterRef } from '@/lib/vault-persist';
import {
  listProductions, createProduction, ensurePresetTagDefs,
  listJobsForMatter, canDeleteProduction, deleteProduction,
  type ProductionListEntry, type ProductionDirection, type ProcessingJob, type Production,
} from '@/lib/discovery';
import { DirectionBadge, StatusBadge, JobProgress, batesRangeLabel } from './bits';
import ProductionFailure from './ProductionFailure';
import FloatingPanel from './FloatingPanel';
import { AddDocumentsStep } from './AddDocuments';
import ReviewTab from './ReviewTab';

// Discovery home for a matter: the production ledger. Reached at
// /app/discovery?matter=<short_code|uuid> — same matter-context convention
// as the Vault.
export default function DiscoveryHome() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const matterKey = searchParams.get('matter');
  // Productions (the ledger) or Review (every document in the matter, R1).
  const tab = searchParams.get('tab') === 'review' ? 'review' : 'productions';
  const setTab = (t: 'productions' | 'review') => {
    const next = new URLSearchParams(searchParams);
    if (t === 'review') next.set('tab', 'review'); else next.delete('tab');
    setSearchParams(next, { replace: true });
  };

  const { cardRef, toggleFullscreen, pinned, togglePin } = useDraggableResizable('cs.discovery.card');

  const [matter, setMatter] = useState<MatterRef | null>(null);
  const [matterError, setMatterError] = useState<string | null>(null);
  const [productions, setProductions] = useState<ProductionListEntry[]>([]);
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Which direction the New Production panel opens with; null = closed.
  const [showNew, setShowNew] = useState<ProductionDirection | null>(null);

  // Resolve ?matter= (short_code or uuid) and seed the preset tag defs
  // on first open of Discovery for this matter.
  useEffect(() => {
    if (!matterKey) {
      setMatterError('Open Discovery from a matter — the URL needs ?matter=<short_code or id>.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setMatterError(null);
    resolveMatter(matterKey).then((m) => {
      if (cancelled) return;
      if (!m) {
        setMatterError(`No matter found for "${matterKey}"`);
        setLoading(false);
        return;
      }
      setMatter(m);
      ensurePresetTagDefs(m.id).catch((e) => console.error('seed preset tags:', e));
    }).catch((err) => {
      if (cancelled) return;
      setMatterError(`Couldn't load "${matterKey}" — ${err instanceof Error ? err.message : 'network error'}. Reload to retry.`);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [matterKey]);

  const refresh = useCallback(async () => {
    if (!matter) return;
    try {
      const [prods, js] = await Promise.all([
        listProductions(matter.id),
        listJobsForMatter(matter.id),
      ]);
      setProductions(prods);
      setJobs(js);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load productions');
    } finally {
      setLoading(false);
    }
  }, [matter]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Row delete: the bin asks once, inline (no browser dialog), then deletes.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);
  const removeProduction = async (id: string) => {
    setDeleting(id);
    setDeleteError(null);
    try {
      await deleteProduction(id);
      setConfirmDelete(null);
      await refresh();
    } catch (e) {
      setDeleteError({ id, message: e instanceof Error ? e.message : 'Delete failed' });
    } finally {
      setDeleting(null);
    }
  };

  // Poll processing jobs every few seconds while any is queued/running, so
  // intake progress (and the status flips the worker makes) appear live.
  const hasActiveJobs = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!matter || !hasActiveJobs) return;
    const t = setInterval(() => { void refresh(); }, 4000);
    return () => clearInterval(t);
  }, [matter, hasActiveJobs, refresh]);

  const jobsByProduction = useMemo(() => {
    const map = new Map<string, ProcessingJob[]>();
    for (const j of jobs) {
      if (!j.production_id) continue;
      const arr = map.get(j.production_id) ?? [];
      arr.push(j);
      map.set(j.production_id, arr);
    }
    return map;
  }, [jobs]);

  const fmtDate = (d: string | null) =>
    d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

  return (
    <div>
      <div
        ref={cardRef}
        className="max-w-5xl mx-auto px-8 py-8 rounded-xl backdrop-blur-[30px] border border-[rgba(255,255,255,0.06)] my-8 cursor-grab select-none"
        style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
      >
        {/* Close + drag handle + window controls — same ribbon as the matter card */}
        <div className="flex items-center justify-between mb-4 -mt-1">
          <button
            onClick={() => (matter ? navigate(`/app/matterspace/${matter.id}`) : navigate('/app'))}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
            title="Back to matter"
          >
            <X size={14} strokeWidth={2} />
          </button>
          <div className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors" title="Drag to move" />
          <div className="flex items-center gap-1">
            <PinToggle pinned={pinned} onToggle={togglePin} />
            <FullscreenToggle onToggle={toggleFullscreen} />
          </div>
        </div>

        {/* Breadcrumb */}
        {matter && (
          <div className="text-[11px] text-white/40 mb-2">
            <Link to={`/app/serverspace/${matter.serverspace_id}`} className="hover:text-[#e8b84a] transition-colors">
              {matter.serverspace_name}
            </Link>
            <span className="mx-1.5">/</span>
            <Link to={`/app/matterspace/${matter.id}`} className="hover:text-[#e8b84a] transition-colors">
              {matter.name}
            </Link>
            <span className="mx-1.5">/</span>
            <span className="text-white/60">Discovery</span>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-[#d4a054]/10 flex items-center justify-center">
            <Stamp size={20} className="text-[#d4a054]" />
          </div>
          <div className="flex-1 min-w-0">
            <h1
              className="text-[26px] font-semibold text-[#f5f2ed] leading-tight"
              style={{ fontFamily: 'Playfair Display Variable, serif' }}
            >
              Discovery
            </h1>
            <p className="text-[12px] text-white/55">
              Productions in and out of {matter ? <span className="text-white/80">{matter.name}</span> : 'this matter'} —
              documents in, review, Bates, privilege log, delivery.
            </p>
          </div>
          <button
            onClick={() => void refresh()}
            className="p-2 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/50 hover:text-white transition-colors shrink-0"
            title="Refresh"
          >
            <RefreshCw size={14} strokeWidth={2} />
          </button>
          {matter && (
            <button
              onClick={() => setShowNew('incoming')}
              title="Register an incoming production or start an outgoing one — pick the direction inside"
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#e8b84a]/10 hover:bg-[#e8b84a]/20 border border-[#e8b84a]/30 text-[#e8b84a] text-[13px] font-medium transition-colors shrink-0"
            >
              <ArrowDownToLine size={14} strokeWidth={1.75} />
              <ArrowUpFromLine size={14} strokeWidth={1.75} className="-ml-1.5" />
              Incoming / Outgoing production
            </button>
          )}
        </div>

        {matterError && <p className="text-sm text-red-300">{matterError}</p>}

        {matter && (
          <div className="flex items-center gap-1 mb-4 border-b border-white/[0.08]">
            {(['productions', 'review'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 -mb-px text-[13px] border-b-2 transition-colors ${
                  tab === t
                    ? 'border-[#e8b84a] text-[#e8b84a]'
                    : 'border-transparent text-white/50 hover:text-white/80'
                }`}
              >
                {t === 'productions' ? 'Productions' : 'Review'}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-white/35 pb-1">
              {tab === 'review' ? 'Every document in the matter. Tags here stay with the document.' : ''}
            </span>
          </div>
        )}

        {matter && tab === 'review' && <ReviewTab matterId={matter.id} onProduced={() => { setTab('productions'); void refresh(); }} />}

        {tab === 'productions' && (<>
        {loadError && <p className="text-sm text-red-300 mb-3">{loadError}</p>}
        {loading && !matterError && (
          <p className="text-center text-[12px] text-white/40 py-10">Loading productions…</p>
        )}

        {!loading && !matterError && productions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-14 text-center">
            <FolderInput size={30} className="text-white/20 mb-3" strokeWidth={1.5} />
            <p className="text-[13px] text-white/50 max-w-sm">
              No productions yet. Click <span className="text-[#e8b84a]">Incoming / Outgoing production</span>{' '}
              to register a volume received from opposing counsel, or to start producing your
              client&rsquo;s documents — pick the direction inside the card.
            </p>
          </div>
        )}

        {!loading && productions.length > 0 && (
          <div className="rounded-lg border border-[rgba(255,255,255,0.14)] overflow-hidden divide-y divide-[rgba(255,255,255,0.07)]">
            {productions.map((p) => {
              const pJobs = (jobsByProduction.get(p.id) ?? []).filter(
                (j) => j.status === 'queued' || j.status === 'running'
                  || (j.status === 'error' && !j.finished_at),
              );
              const bates = batesRangeLabel(p);
              const deletable = canDeleteProduction(
                p.status,
                (jobsByProduction.get(p.id) ?? []).some((j) => j.status === 'queued' || j.status === 'running'),
              );
              const party = p.direction === 'incoming' ? p.producing_party : p.receiving_party;
              return (
                <div
                  key={p.id}
                  onClick={() => navigate(`/app/discovery/production/${p.id}`)}
                  className="px-4 py-3 hover:bg-[rgba(255,255,255,0.04)] transition-colors cursor-pointer group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <DirectionBadge direction={p.direction} />
                    <span className="text-[13.5px] text-[#f5f1e8] font-medium truncate flex-1 min-w-0">
                      {p.name}
                    </span>
                    <StatusBadge status={p.status} />
                    {deletable && confirmDelete !== p.id && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteError(null); setConfirmDelete(p.id); }}
                        className="h-6 w-6 inline-flex items-center justify-center rounded text-white/30 hover:text-[#e07a6a] hover:bg-white/5 transition-colors shrink-0"
                        title="Delete this production (only before it is stamped)"
                        aria-label={`Delete ${p.name}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                    <ChevronRight size={13} className="text-white/30 group-hover:text-[#e8b84a] transition-colors shrink-0" strokeWidth={2} />
                  </div>
                  <div className="flex items-center gap-4 mt-1.5 pl-1 text-[11px] text-white/45 flex-wrap">
                    <span>{fmtDate(p.production_date)}</span>
                    {party && (
                      <span className="truncate max-w-[220px]">
                        {p.direction === 'incoming' ? 'from' : 'to'}{' '}
                        <span className="text-white/65">{party}</span>
                      </span>
                    )}
                    <span className="tabular-nums">
                      {p.item_count} {p.item_count === 1 ? 'document' : 'documents'}
                    </span>
                    {bates && (
                      <span className="font-mono text-[10.5px] text-[#d4a054]/85 tracking-tight">{bates}</span>
                    )}
                    {p.request_refs && <span className="truncate max-w-[200px] italic">{p.request_refs}</span>}
                  </div>
                  {confirmDelete === p.id && (
                    <div
                      className="mt-2 pl-1 flex items-center gap-2 flex-wrap text-[11.5px]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="text-white/75">
                        Delete this production and its {p.item_count} {p.item_count === 1 ? 'document' : 'documents'}?
                        {p.item_count > 0 && <span className="text-white/45"> Copies already filed in the Vault stay there.</span>}
                      </span>
                      <button
                        onClick={() => void removeProduction(p.id)}
                        disabled={deleting === p.id}
                        className="h-6 px-2 rounded bg-[#e07a6a]/15 text-[#e07a6a] hover:bg-[#e07a6a]/25 disabled:opacity-50"
                      >
                        {deleting === p.id ? 'Deleting…' : 'Delete'}
                      </button>
                      <button
                        onClick={() => { setConfirmDelete(null); setDeleteError(null); }}
                        disabled={deleting === p.id}
                        className="h-6 px-2 rounded text-white/60 hover:text-white hover:bg-white/5"
                      >
                        Cancel
                      </button>
                      {deleteError?.id === p.id && <span className="text-[#e07a6a]">{deleteError.message}</span>}
                    </div>
                  )}
                  <ProductionFailure production={p} />
                  {pJobs.length > 0 && (
                    <div className="mt-2 pl-1 space-y-1" onClick={(e) => e.stopPropagation()}>
                      {pJobs.map((j) => <JobProgress key={j.id} job={j} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {matter && (
          <p className="mt-5 text-[11px] text-white/45 leading-relaxed">
            Start with &ldquo;New production&rdquo;, then add its documents.
          </p>
        )}
        </>)}
      </div>

      {showNew && matter && (
        <NewProductionPanel
          matter={matter}
          initialDirection={showNew}
          onClose={() => setShowNew(null)}
          onDone={() => { setShowNew(null); void refresh(); }}
        />
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// New production flow — a floating two-step panel: details → add documents.
// ─────────────────────────────────────────────────────────────────────────────

function NewProductionPanel({
  matter,
  initialDirection,
  onClose,
  onDone,
}: {
  matter: MatterRef;
  initialDirection: ProductionDirection;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<'form' | 'intake'>('form');
  const [created, setCreated] = useState<Production | null>(null);

  // Step 1 fields
  const [name, setName] = useState('');
  const [direction, setDirection] = useState<ProductionDirection>(initialDirection);
  const [party, setParty] = useState('');
  const [date, setDate] = useState('');
  const [requestRefs, setRequestRefs] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const row = await createProduction({
        matterspace_id: matter.id,
        direction,
        name: name.trim(),
        producing_party: direction === 'incoming' ? (party.trim() || null) : null,
        receiving_party: direction === 'outgoing' ? (party.trim() || null) : null,
        production_date: date || null,
        request_refs: requestRefs.trim() || null,
        notes: notes.trim() || null,
      });
      setCreated(row);
      setStep('intake');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create production');
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    'w-full rounded-md bg-[rgba(18,18,28,0.78)] border border-[rgba(255,255,255,0.1)] px-2.5 py-1.5 text-[12.5px] text-[#f0ebe3] placeholder:text-white/30 focus:outline-none focus:border-[#d4a054]/60 transition-colors';
  const labelCls = 'block text-[10px] font-semibold text-white/45 uppercase tracking-wider mb-1';

  return (
    <FloatingPanel
      title={step === 'form' ? 'New Production' : `Add documents — ${created?.name ?? ''}`}
      icon={<FolderInput size={14} />}
      storageKey="cs.discovery.newprod"
      defaultStyle={{ right: 48, top: 96, width: 400 }}
      onClose={created ? onDone : onClose}
    >
      {step === 'form' && (
        <div className="px-4 py-4 space-y-3 cursor-default">
          <div>
            <label className={labelCls}>Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={direction === 'incoming' ? 'e.g. Defendants’ First Production' : 'e.g. Plaintiff’s Production Vol. 1'}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Direction</label>
            <div className="flex rounded-md border border-[rgba(255,255,255,0.1)] overflow-hidden">
              {(['incoming', 'outgoing'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  className={`flex-1 py-1.5 text-[11.5px] font-medium transition-colors ${
                    direction === d
                      ? 'bg-[#d4a054]/20 text-[#e8b84a]'
                      : 'text-white/55 hover:text-white hover:bg-[rgba(255,255,255,0.04)]'
                  }`}
                >
                  {d === 'incoming' ? 'Incoming — received' : 'Outgoing — we produce'}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>
                {direction === 'incoming' ? 'Producing party' : 'Receiving party'}
              </label>
              <input
                value={party}
                onChange={(e) => setParty(e.target.value)}
                placeholder={direction === 'incoming' ? 'Who produced it' : 'Who receives it'}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Responds to</label>
            <input
              value={requestRefs}
              onChange={(e) => setRequestRefs(e.target.value)}
              placeholder="e.g. RFP Nos. 1–24"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Anything reviewers should know"
              className={`${inputCls} resize-none`}
            />
          </div>
          {error && <p className="text-[11px] text-red-300">{error}</p>}
          <div className="flex justify-end pt-1">
            <button
              onClick={() => void handleCreate()}
              disabled={!name.trim() || saving}
              className="px-4 py-1.5 rounded-lg bg-[#e8b84a]/15 hover:bg-[#e8b84a]/25 border border-[#e8b84a]/35 text-[#e8b84a] text-[12px] font-medium transition-colors disabled:opacity-40"
            >
              {saving ? 'Creating…' : 'Create & add documents'}
            </button>
          </div>
        </div>
      )}

      {step === 'intake' && created && (
        <AddDocumentsStep matter={matter} production={created} onDone={onDone} skipLabel="Skip for now" />
      )}
    </FloatingPanel>
  );
}
