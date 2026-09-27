// The Brief Desk's front door, /app/brief.
//
// One place to start: drop a brief (or choose one — Downloads, a synced
// OneDrive folder, anywhere on this computer), bring one in from Contextspaces,
// or start a blank one; and the briefs you have been working on, newest first.
// An import lands in the desk with a banner that offers "Confirm this brief".
// The filing (a document in the matter, its editable body, a first version,
// the original file kept beside it) happens without a question; the one thing
// asked is which matter it belongs to, remembered from last time.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FolderOpen, FilePlus2, Loader2, Lock, Stamp, AlertTriangle } from 'lucide-react';
import { useServerspaces } from '@/hooks/useServerspaces';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';
import CorpusDocumentPicker from '@/components/matter/CorpusDocumentPicker';
import {
  createBrief, importBriefFile, importBriefFromDocument, listRecentBriefs, type RecentBrief,
} from '@/lib/brief/draft-store';
import { IMPORT_ACCEPT, kindOf, refusalFor } from '@/lib/brief/import';

const MATTER_KEY = 'cs.brief.matter';

interface MatterOption { id: string; label: string; sealed: boolean }

function useMatterOptions(): { options: MatterOption[]; loading: boolean } {
  const { data: spaces = [], isLoading } = useServerspaces();
  const options = useMemo(() => {
    const out: MatterOption[] = [];
    for (const s of spaces) {
      const walk = (nodes: MatterTreeNode[], trail: string[], sealedAbove: boolean) => {
        for (const n of nodes) {
          const sealed = sealedAbove || n.matter.ai_tier !== 'A';
          const path = [...trail, n.matter.name];
          out.push({ id: n.matter.id, label: path.join(' › '), sealed });
          walk(n.children, path, sealed);
        }
      };
      walk(buildMatterTree(s.matterspaces), [s.name], false);
    }
    return out;
  }, [spaces]);
  return { options, loading: isLoading };
}

export default function BriefDeskHome() {
  const navigate = useNavigate();
  const { options, loading } = useMatterOptions();
  const names = useMemo(() => new Map(options.map((o) => [o.id, o.label])), [options]);

  const [matterId, setMatterId] = useState<string>(() => {
    try { return localStorage.getItem(MATTER_KEY) ?? ''; } catch { return ''; }
  });
  // The remembered matter must still be one this person can open.
  const chosen = options.find((o) => o.id === matterId) ?? null;
  useEffect(() => {
    try { if (matterId) localStorage.setItem(MATTER_KEY, matterId); } catch { /* private window */ }
  }, [matterId]);

  const [recent, setRecent] = useState<RecentBrief[] | null>(null);
  const [recentErr, setRecentErr] = useState<string | null>(null);
  useEffect(() => {
    listRecentBriefs().then((r) => {
      setRecent(r);
      // Nothing remembered yet: the matter of the brief worked on last.
      setMatterId((cur) => cur || r[0]?.matterspace_id || '');
    }, (e) => setRecentErr((e as Error).message));
  }, []);

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const land = useCallback((id: string, from: string, losses: string[]) => {
    navigate(`/app/brief/${id}`, { state: { imported: { from, losses } } });
  }, [navigate]);

  const importFile = useCallback(async (file: File | undefined) => {
    if (!file || busy) return;
    setErr(null);
    const refusal = refusalFor(kindOf(file.name));
    if (refusal) { setErr(refusal); return; }
    if (!chosen) { setErr('Choose the matter this brief belongs to, then drop it again.'); return; }
    setBusy(`Bringing in ${file.name}…`);
    try {
      const r = await importBriefFile(chosen.id, file);
      land(r.id, file.name, r.losses);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }, [busy, chosen, land]);

  const newBlank = async () => {
    if (!chosen || busy) { if (!chosen) setErr('Choose the matter this brief belongs to.'); return; }
    setBusy('Starting a brief…');
    try {
      const id = await createBrief(chosen.id, 'Untitled brief');
      navigate(`/app/brief/${id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  };

  // A file dropped anywhere on the page.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void importFile(e.dataTransfer.files?.[0]);
  };

  return (
    <div
      className="h-full min-h-0 overflow-y-auto bg-[#0e0e14] text-white"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
    >
      <div className="max-w-3xl mx-auto px-4 md:px-8 py-8 md:py-12">
        <div className="flex items-center gap-2 mb-1">
          <Stamp size={18} className="text-[#e8b84a]" />
          <h1 className="text-[20px] font-medium text-white/95">Brief Desk</h1>
        </div>
        <p className="text-[13px] text-white/50 mb-6">Bring a brief in, edit it as text, and check every cite against the cases in your matter.</p>

        <label className="block text-[11px] uppercase tracking-[0.14em] text-white/40 mb-1.5">Matter</label>
        <div className="flex items-center gap-2 mb-5">
          <select
            value={chosen?.id ?? ''}
            onChange={(e) => { setMatterId(e.target.value); setErr(null); }}
            className="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.1] rounded-lg px-3 py-2 text-[13px] text-white/90 outline-none focus:border-[#e8b84a]/50"
            aria-label="The matter the brief belongs to"
          >
            <option value="">{loading ? 'Loading your matters…' : 'Choose the matter…'}</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}{o.sealed ? '  (sealed)' : ''}</option>)}
          </select>
          {chosen?.sealed && <span className="inline-flex items-center gap-1 text-[11px] text-white/50"><Lock size={11} /> sealed</span>}
        </div>

        <button
          type="button"
          disabled={!!busy}
          onClick={() => fileRef.current?.click()}
          className={`w-full rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors disabled:opacity-60 ${
            dragging ? 'border-[#e8b84a] bg-[#e8b84a]/[0.08]' : 'border-white/[0.14] hover:border-[#e8b84a]/60 hover:bg-white/[0.02]'
          }`}
        >
          {busy ? (
            <span className="inline-flex items-center gap-2 text-[14px] text-[#e8b84a]"><Loader2 size={16} className="animate-spin" /> {busy}</span>
          ) : (
            <>
              <Upload size={22} className="mx-auto text-[#e8b84a] mb-2" />
              <div className="text-[15px] text-white/90">Import a brief</div>
              <div className="text-[12px] text-white/45 mt-1">Drop it here, or click to choose — from Downloads, OneDrive, anywhere on this computer.</div>
              <div className="text-[11px] text-white/30 mt-1">Word (.docx), Markdown or text. Footnotes come with it.</div>
            </>
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={IMPORT_ACCEPT}
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void importFile(f); }}
        />

        <div className="flex flex-wrap gap-2 mt-3">
          <button
            type="button"
            disabled={!!busy}
            onClick={() => { setErr(null); setPicking(true); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.1] text-[12px] text-white/80 hover:bg-white/[0.05] disabled:opacity-40"
          >
            <FolderOpen size={13} /> From Contextspaces
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void newBlank()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.1] text-[12px] text-white/80 hover:bg-white/[0.05] disabled:opacity-40"
          >
            <FilePlus2 size={13} /> New blank brief
          </button>
        </div>

        {err && (
          <p className="mt-3 text-[12px] text-red-300 inline-flex items-start gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{err}</p>
        )}

        <h2 className="mt-10 mb-2 text-[11px] uppercase tracking-[0.14em] text-white/40">Your briefs</h2>
        {recentErr && <p className="text-[12px] text-red-300">{recentErr}</p>}
        {!recent && !recentErr && <p className="text-[12px] text-white/40">Loading…</p>}
        {recent && recent.length === 0 && <p className="text-[12px] text-white/40">None yet. Import one above.</p>}
        {recent && recent.length > 0 && (
          <div className="rounded-lg border border-white/[0.08] divide-y divide-white/[0.06] overflow-hidden">
            {recent.map((b) => (
              <button
                key={b.id}
                onClick={() => navigate(`/app/brief/${b.id}`)}
                className="w-full text-left px-4 py-2.5 hover:bg-white/[0.03] flex items-baseline gap-3"
              >
                <span className="flex-1 min-w-0 truncate text-[13px] text-white/90">{b.title}</span>
                <span className="hidden sm:inline max-w-[45%] truncate text-[11px] text-white/40">{names.get(b.matterspace_id) ?? ''}</span>
                <span className="shrink-0 text-[11px] text-white/35">{new Date(b.updated_at).toLocaleDateString()}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {picking && (
        <CorpusDocumentPicker
          title="Bring a brief in from Contextspaces"
          rootMatterId={chosen?.id}
          onCancel={() => setPicking(false)}
          onPicked={(picked) => {
            setPicking(false);
            setBusy(`Bringing in ${picked.title}…`);
            importBriefFromDocument(picked.documentId).then(
              (r) => (r.existing ? navigate(`/app/brief/${r.id}`) : land(r.id, picked.title, r.losses)),
              (e) => { setErr((e as Error).message); setBusy(null); },
            );
          }}
        />
      )}
    </div>
  );
}
