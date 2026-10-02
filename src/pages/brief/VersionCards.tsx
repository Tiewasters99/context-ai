// "Save as v19" and Compare (Eden, 10-02): a brief is worked on one version at
// a time, Word style. When a review is done it is saved as the next version, a
// document of its own in the Vault; the old version stays as it was. Compare
// shows the changes between any two versions as a redline, so the reviewer
// checks the redline instead of hunting for edits.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import CardDialog from '@/components/ui/CardDialog';
import {
  briefTitleTaken, listVersionCandidates, loadBriefBody, saveAsNewVersion,
  type BriefMeta, type VersionCandidate,
} from '@/lib/brief/draft-store';
import { redline, versionNumber, type Redline } from '@/lib/brief/versions';
import type { BriefDoc } from '@/lib/brief/md';

// ── Save as the next version ─────────────────────────────────────────

export function SaveAsVersionCard({ meta, suggested, getBody, flush, onSaved, onClose }: {
  meta: BriefMeta;
  suggested: string;
  /** The brief as it is on screen now. */
  getBody: () => BriefDoc | null;
  /** Save pending edits to THIS version first (a no-op when there are none or it was changed elsewhere). */
  flush: () => Promise<void>;
  onSaved: (id: string, title: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [taken, setTaken] = useState<{ id: string; title: string } | null>(null);
  const clean = title.trim();

  // Say at once if the name is already used in this matter.
  useEffect(() => {
    let live = true;
    setTaken(null);
    if (!clean) return;
    const t = setTimeout(() => {
      briefTitleTaken(meta.matterspace_id, clean).then((r) => { if (live) setTaken(r); }).catch(() => {});
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [clean, meta.matterspace_id]);

  const save = async () => {
    const body = getBody();
    if (!body || !clean || busy) return;
    setBusy(true); setErr(null);
    try {
      await flush().catch(() => {});
      if (await briefTitleTaken(meta.matterspace_id, clean)) {
        setErr(`“${clean}” already exists in this matter. Choose another name.`);
        return;
      }
      const id = await saveAsNewVersion(meta, body, clean);
      onSaved(id, clean);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <CardDialog
      storageKey="cs.brief.save-as-version"
      title="Save as a new version"
      subtitle={`The brief as it is now becomes a new document in this matter, and opens. “${meta.title}” stays exactly as it was.`}
      onClose={onClose}
      busy={busy}
      maxWidth={520}
      footer={(
        <>
          <button onClick={onClose} className="h-8 px-3 text-[12px] text-white/60 hover:text-white">Cancel</button>
          <button
            onClick={() => void save()}
            disabled={!clean || busy || !!taken}
            className="h-8 px-3 rounded-md bg-[#e8b84a] text-black text-[12px] font-semibold disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            {busy && <Loader2 size={12} className="animate-spin" />} Save as “{clean || '…'}”
          </button>
        </>
      )}
    >
      <label className="block text-[12px] text-white/60 mb-1" htmlFor="save-as-title">Name of the new version</label>
      <input
        id="save-as-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
        className="w-full h-9 rounded-md bg-white/[0.06] border border-white/15 px-2.5 text-[13px] text-white outline-none focus:border-[#e8b84a]"
      />
      {taken && <p className="mt-2 text-[12px] text-amber-200/90">“{taken.title}” already exists in this matter. Change the name to save a new version.</p>}
      {err && <p className="mt-2 text-[12px] text-red-300">{err}</p>}
      <p className="mt-3 text-[11.5px] text-white/45 leading-relaxed">
        The cites you confirmed stay in this version’s Log. To bring them across, open the Log in the new version and use “Carry the check from an earlier version”.
      </p>
    </CardDialog>
  );
}

// ── Compare two versions ─────────────────────────────────────────────

export function CompareCard({ meta, getBody, matterName, onClose }: {
  meta: BriefMeta;
  getBody: () => BriefDoc | null;
  matterName: (id: string) => string | null;
  onClose: () => void;
}) {
  const [cands, setCands] = useState<VersionCandidate[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [other, setOther] = useState<VersionCandidate | null>(null);
  const [result, setResult] = useState<{ r: Redline; olderTitle: string; newerTitle: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listVersionCandidates(meta).then((c) => {
      const n = (x: VersionCandidate) => versionNumber(x.title) ?? -1;
      setCands([...c].sort((a, b) => n(b) - n(a) || b.updated_at.localeCompare(a.updated_at)));
    }, (e) => setErr((e as Error).message));
  }, [meta]);

  const run = async (c: VersionCandidate) => {
    const mine = getBody();
    if (!mine) return;
    setOther(c); setBusy(true); setErr(null); setResult(null); setAt(0);
    try {
      const theirs = await loadBriefBody(c.id);
      // The older version is the one with the lower number; with none, the
      // one being compared against.
      const vMine = versionNumber(meta.title ?? '');
      const vOther = versionNumber(c.title);
      const otherIsOlder = vMine === null || vOther === null ? true : vOther <= vMine;
      const r = otherIsOlder ? redline(theirs, mine) : redline(mine, theirs);
      setResult({
        r,
        olderTitle: otherIsOlder ? c.title : (meta.title ?? 'this brief'),
        newerTitle: otherIsOlder ? (meta.title ?? 'this brief') : c.title,
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changeIdx = useMemo(() => (result ? result.r.blocks.map((b, i) => (b.kind === 'same' ? -1 : i)).filter((i) => i >= 0) : []), [result]);
  const go = (k: number) => {
    if (!changeIdx.length) return;
    const n = (k + changeIdx.length) % changeIdx.length;
    setAt(n);
    listRef.current?.querySelector(`[data-block="${changeIdx[n]}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  return (
    <CardDialog
      storageKey="cs.brief.compare"
      title="Compare versions"
      subtitle={result
        ? `Changes from “${result.olderTitle}” to “${result.newerTitle}”`
        : `Pick a version to compare with “${meta.title}”.`}
      onClose={onClose}
      maxWidth={900}
      height="min(720px, 88vh)"
      bodyClassName="px-0 py-0 flex flex-col min-h-0"
    >
      {!result && (
        <div className="px-5 py-4 overflow-y-auto">
          {err && <p className="text-[12px] text-red-300 mb-2">{err}</p>}
          {!cands ? (
            <p className="text-[12px] text-white/50 inline-flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Finding the other versions…</p>
          ) : cands.length === 0 ? (
            <p className="text-[12px] text-white/50">No other version of this brief is in the desk. A version saved with “Save as”, or a Word file brought into the desk, will show here.</p>
          ) : (
            <div className="rounded-lg border border-white/[0.08] divide-y divide-white/[0.06]" role="listbox" aria-label="Version to compare with">
              {cands.map((c) => (
                <button
                  key={c.id}
                  role="option"
                  aria-selected={other?.id === c.id}
                  onClick={() => void run(c)}
                  disabled={busy}
                  className="w-full text-left px-3 py-2 flex items-baseline gap-2 hover:bg-white/[0.04] disabled:opacity-50"
                >
                  <span className="flex-1 min-w-0 truncate text-[13px] text-white/90">{c.title}</span>
                  <span className="shrink-0 text-[11px] text-white/45 max-w-[35%] truncate">{matterName(c.matterspace_id) ?? ''}</span>
                  <span className="shrink-0 text-[11px] text-white/35">{new Date(c.updated_at).toLocaleDateString()}</span>
                </button>
              ))}
            </div>
          )}
          {busy && <p className="mt-3 text-[12px] text-white/50 inline-flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Comparing…</p>}
          <p className="mt-3 text-[11.5px] text-white/40 leading-relaxed">
            Listed: the briefs in this matter, and briefs anywhere with the same name before the version number.
            The text now on screen is compared, including edits not yet saved.
          </p>
        </div>
      )}

      {result && (
        <>
          <div className="px-5 py-2 border-b border-white/[0.08] flex flex-wrap items-center gap-3 text-[12px] text-white/70">
            <span>
              {result.r.changes === 0 ? 'No changes.' : <>{result.r.changes} {result.r.changes === 1 ? 'passage' : 'passages'} changed · <span className="text-sky-300">+{result.r.wordsAdded}</span> / <span className="text-red-300">−{result.r.wordsDeleted}</span> words</>}
            </span>
            {result.r.changes > 0 && (
              <span className="inline-flex items-center gap-1">
                <button onClick={() => go(at - 1)} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-white/5" title="Previous change"><ChevronUp size={14} /></button>
                <span className="tabular-nums text-white/50">{at + 1}/{changeIdx.length}</span>
                <button onClick={() => go(at + 1)} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-white/5" title="Next change"><ChevronDown size={14} /></button>
              </span>
            )}
            <label className="inline-flex items-center gap-1.5 text-white/55">
              <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} /> Changed passages only
            </label>
            <button onClick={() => { setResult(null); setOther(null); }} className="ml-auto text-[12px] text-[#e8b84a]/85 hover:text-[#e8b84a]">Compare with another version</button>
          </div>
          <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-6 py-4 bg-[#f7f4ee] text-[#1c1c1c]" data-testid="redline">
            <style>{`.rl ins{color:#0b5cad;text-decoration:underline;text-decoration-thickness:1.5px;background:rgba(11,92,173,0.08)} .rl del{color:#b3261e;text-decoration:line-through;background:rgba(179,38,30,0.06)}`}</style>
            {result.r.blocks.map((b, i) => {
              if (onlyChanges && b.kind === 'same') return null;
              return (
                <p
                  key={i}
                  data-block={i}
                  className={`rl whitespace-pre-wrap font-serif text-[14px] leading-relaxed mb-3 ${b.kind === 'same' ? 'text-[#1c1c1c]/70' : ''} ${changeIdx[at] === i ? 'outline outline-2 outline-[#e8b84a]/70 outline-offset-4 rounded-sm' : ''}`}
                >
                  {b.kind === 'ins' && <span className="mr-1 text-[11px] font-sans text-[#0b5cad]">[added]</span>}
                  {b.kind === 'del' && <span className="mr-1 text-[11px] font-sans text-[#b3261e]">[cut]</span>}
                  {b.pieces.map((pc, k) => (pc.op === '+' ? <ins key={k}>{pc.text}</ins> : pc.op === '-' ? <del key={k}>{pc.text}</del> : <span key={k}>{pc.text}</span>))}
                </p>
              );
            })}
          </div>
        </>
      )}
    </CardDialog>
  );
}
