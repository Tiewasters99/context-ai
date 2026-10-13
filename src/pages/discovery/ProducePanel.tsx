import { useEffect, useMemo, useState } from 'react';
import { Stamp, Package, Download, Send, CheckCircle2 } from 'lucide-react';
import {
  nextBatesSeq, updateProduction, enqueueJob, getDiscoverySignedUrl,
  listDeliveries, createDelivery, formatBates, BATES_POSITIONS, getPackageVolumes, isVolumeList,
  type ProcessingJob, type Production, type ProductionItem, type BatesPosition, type Delivery, type PackageVolume,
} from '@/lib/discovery';
import { batesRangeLabel, JobProgress } from './bits';
import FloatingPanel from './FloatingPanel';
import ProductionFailure from './ProductionFailure';
import { withholdFamilies, duplicatesToSetAside } from '../../../lib/discovery/families.mjs';

// "Bates & Produce" — the outgoing-production pipeline panel. Its face
// changes with the production's status:
//   review   → Bates config + stamp
//   stamped  → package (with/without privilege log)
//   packaged → download + record delivery + past deliveries
export default function ProducePanel({
  production,
  items,
  jobs,
  onClose,
  onQueued,
}: {
  production: Production;
  items: ProductionItem[];
  jobs: ProcessingJob[];
  onClose: () => void;
  onQueued: (job: ProcessingJob) => void;
}) {
  // Documents excluded from production: anything tagged with a def whose
  // behavior is 'privileged' or 'non_responsive', and the attachments of an
  // email so excluded (the worker withholds the family, lib/discovery/families.mjs).
  // duplicates: the identical copies "Remove duplicates" would set aside,
  // counted the way the worker decides them (it first clears any earlier
  // marks, old automatic intake duplicates included, then decides afresh).
  const { included, excluded, duplicates } = useMemo(() => {
    const own = new Set(items
      .filter((it) => it.tags.some((t) => t.tag_def?.behavior === 'privileged' || t.tag_def?.behavior === 'non_responsive'))
      .map((it) => it.id));
    const ex = withholdFamilies(items, own).excludedIds;
    const candidates = items.filter((it) => !ex.has(it.id) && it.status === 'ready');
    return {
      included: items.length - ex.size,
      excluded: ex.size,
      duplicates: duplicatesToSetAside(candidates).length,
    };
  }, [items]);
  const movedStamps = items.filter((it) => it.stamp_position).length;

  const activeJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running');

  return (
    <FloatingPanel
      title="Bates & Produce"
      icon={<Stamp size={14} />}
      storageKey="cs.discovery.produce"
      defaultStyle={{ right: 48, top: 110, width: 400 }}
      onClose={onClose}
    >
      <div className="px-4 py-4 cursor-default">
        <StatusRail status={production.status} />
        {activeJobs.map((job) => <JobProgress key={job.id} job={job} />)}
        {activeJobs.length === 0 && production.status === 'review' && (
          <BatesStep production={production} included={included} excluded={excluded} duplicates={duplicates} movedStamps={movedStamps} onQueued={onQueued} />
        )}
        {(production.status === 'processing' || production.status === 'intake') && (
          <p className="text-[11.5px] text-white/45 leading-relaxed">
            Documents are still being added and prepared for review. Bates stamping unlocks when the
            production reaches <span className="text-[#7dd3fc]">review</span>.
          </p>
        )}
        {activeJobs.length === 0 && production.status === 'stamped' && (
          <PackageStep production={production} onQueued={onQueued} />
        )}
        {(production.status === 'packaged' || production.status === 'delivered') && (
          <DeliveryStep production={production} />
        )}
        {/* Migration 071 (F5): an intake parked by the seal or the AI pause.
            Before this branch existed the panel rendered nothing at all for a
            held production — no status, no reason, no next step. */}
        {production.status === 'held' && (
          <p className="text-[11.5px] text-amber-300 leading-relaxed">
            {production.status_reason
              ?? 'This production is held. Nothing was lost — releasing the hold puts it back in the queue.'}
          </p>
        )}
        <ProductionFailure production={production} />
      </div>
    </FloatingPanel>
  );
}

const RAIL: { key: string; label: string }[] = [
  { key: 'review', label: 'Review' },
  { key: 'stamped', label: 'Stamp' },
  { key: 'packaged', label: 'Package' },
  { key: 'delivered', label: 'Deliver' },
];

function StatusRail({ status }: { status: string }) {
  const idx = RAIL.findIndex((r) => r.key === status);
  const activeIdx = idx === -1 ? 0 : idx;
  return (
    <div className="flex items-center gap-1 mb-4">
      {RAIL.map((r, i) => (
        <div key={r.key} className="flex items-center gap-1 flex-1 last:flex-none">
          <span
            className={`text-[9.5px] uppercase tracking-wider font-semibold whitespace-nowrap ${
              i < activeIdx ? 'text-[#4ade80]/80' : i === activeIdx ? 'text-[#d4a054]' : 'text-white/25'
            }`}
          >
            {r.label}
          </span>
          {i < RAIL.length - 1 && (
            <div className={`flex-1 h-px ${i < activeIdx ? 'bg-[#4ade80]/40' : 'bg-white/10'}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Step 1: Bates configuration ─────────────────────────────────────────────

const POSITION_LABEL: Record<BatesPosition, string> = {
  upper_left: 'Upper left', upper_center: 'Upper center', upper_right: 'Upper right',
  lower_left: 'Lower left', lower_center: 'Lower center', lower_right: 'Lower right',
};

function BatesStep({
  production,
  included: includedAll,
  excluded,
  duplicates,
  movedStamps,
  onQueued,
}: {
  production: Production;
  included: number;
  excluded: number;
  duplicates: number;
  movedStamps: number;
  onQueued: (job: ProcessingJob) => void;
}) {
  const [prefix, setPrefix] = useState(production.bates_prefix ?? '');
  const [pad, setPad] = useState(production.bates_pad || 7);
  const [start, setStart] = useState<number>(production.bates_start ?? 1);
  const [position, setPosition] = useState<BatesPosition>(production.bates_position || 'lower_right');
  const [series, setSeries] = useState<{ prefix: string; next: number; perPrefix: boolean } | null>(null);
  // Once the user types their own start number, the suggestion stops
  // overwriting it.
  const [startTouched, setStartTouched] = useState(production.bates_start != null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Remove duplicates" — off unless chosen; sent with the stamp job, which
  // records it on each copy it sets aside.
  const [removeDupes, setRemoveDupes] = useState(false);
  const setAside = removeDupes ? duplicates : 0;
  const included = includedAll - setAside;

  // Suggested start = the next free number in THIS prefix's series (108): a
  // new prefix starts at 1, a repeated prefix continues where it left off.
  // Re-asked as the prefix is typed, after a short pause.
  useEffect(() => {
    let cancelled = false;
    const typed = prefix.trim();
    const t = setTimeout(() => {
      nextBatesSeq(production.matterspace_id, typed).then((r) => {
        if (cancelled) return;
        setSeries({ prefix: typed, ...r });
        if (!startTouched) setStart(r.next);
      }).catch(() => {});
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [production.matterspace_id, prefix, startTouched]);

  const preview = formatBates(prefix || 'PREFIX_', Math.max(1, Math.min(12, pad)), Math.max(1, start));

  const confirm = async () => {
    if (!prefix.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateProduction(production.id, {
        bates_prefix: prefix.trim(),
        bates_pad: Math.max(1, Math.min(12, pad)),
        bates_start: Math.max(1, start),
        bates_position: position,
      });
      const job = await enqueueJob({
        matterspace_id: production.matterspace_id,
        production_id: production.id,
        job_type: 'stamp_production',
        payload: { remove_duplicates: removeDupes },
      });
      onQueued(job);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start stamping');
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    'rounded-md bg-[rgba(18,18,28,0.78)] border border-[rgba(255,255,255,0.1)] px-2.5 py-1.5 text-[12.5px] text-[#f0ebe3] placeholder:text-white/30 focus:outline-none focus:border-[#d4a054]/60 transition-colors';
  const labelCls = 'block text-[10px] font-semibold text-white/45 uppercase tracking-wider mb-1';

  return (
    <div className="space-y-3.5">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-1">
          <label className={labelCls}>Prefix</label>
          <input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value.replace(/\s/g, ''))}
            placeholder="LIT_"
            className={`${inputCls} w-full font-mono`}
          />
        </div>
        <div>
          <label className={labelCls}>Digits</label>
          <input
            type="number"
            min={1}
            max={12}
            value={pad}
            onChange={(e) => setPad(parseInt(e.target.value, 10) || 7)}
            className={`${inputCls} w-full tabular-nums`}
          />
        </div>
        <div>
          <label className={labelCls}>Start at</label>
          <input
            type="number"
            min={1}
            value={start}
            onChange={(e) => { setStartTouched(true); setStart(parseInt(e.target.value, 10) || 1); }}
            className={`${inputCls} w-full tabular-nums`}
          />
        </div>
      </div>
      {series && (
        <p className="text-[10.5px] text-white/40 -mt-1.5">
          {!series.perPrefix ? (
            series.next > 1 ? (
              <>Matter high-water mark: <span className="text-white/65 tabular-nums">{series.next - 1}</span> — numbering
              continues from there. </>
            ) : null
          ) : series.next > 1 ? (
            <><span className="text-white/65">{series.prefix || '(no prefix)'}</span> has been used up to{' '}
            <span className="text-white/65 tabular-nums">{series.next - 1}</span> in this matter — this production
            continues from <span className="text-white/65 tabular-nums">{series.next}</span>. </>
          ) : series.prefix ? (
            <>New prefix in this matter — numbering starts at 1. </>
          ) : null}
          Assigned Bates numbers are immutable.
        </p>
      )}

      {/* Position picker — a miniature page, not a dropdown. */}
      <div className="flex items-start gap-4">
        <div>
          <label className={labelCls}>Stamp position</label>
          <div
            className="relative w-[104px] h-[136px] rounded-[3px] border border-white/20 bg-[#f3ecd9]/90 shadow-inner"
            title="Where the Bates number lands on each page"
          >
            {/* faint "text" lines so it reads as a page */}
            <div className="absolute inset-x-3 top-5 space-y-1.5 pointer-events-none">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-[3px] rounded-full bg-black/10" style={{ width: `${88 - (i % 3) * 14}%` }} />
              ))}
            </div>
            <div className="absolute inset-0 grid grid-cols-3 grid-rows-2 p-1">
              {BATES_POSITIONS.map((pos) => {
                const active = position === pos;
                return (
                  <button
                    key={pos}
                    onClick={() => setPosition(pos)}
                    className="relative flex items-center justify-center group"
                    title={POSITION_LABEL[pos]}
                  >
                    <span
                      className={`block rounded-[2px] transition-all ${
                        active
                          ? 'w-7 h-2.5 bg-[#b58220] shadow'
                          : 'w-5 h-2 bg-black/15 group-hover:bg-[#b58220]/50'
                      }`}
                    />
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-[10px] text-white/45 mt-1 text-center w-[104px]">{POSITION_LABEL[position]}</p>
        </div>
        <div className="flex-1 min-w-0">
          <label className={labelCls}>Preview</label>
          <div className="rounded-md border border-[#d4a054]/30 bg-[#d4a054]/8 px-3 py-2.5">
            <span className="font-mono text-[14px] tracking-wide text-[#e8b84a]">{preview}</span>
          </div>
          <p className="text-[11px] text-white/55 mt-3 leading-relaxed">
            <span className="text-[#f5f1e8] tabular-nums font-medium">{included}</span> document{included === 1 ? '' : 's'} included
            {' · '}
            <span className="text-[#f87171]/90 tabular-nums font-medium">{excluded}</span> excluded
            <span className="text-white/35"> (privileged / non-responsive)</span>
            {setAside > 0 && (
              <>
                {' · '}
                <span className="text-[#e8b84a] tabular-nums font-medium">{setAside}</span> set aside as duplicates
              </>
            )}
          </p>
        </div>
      </div>

      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={removeDupes}
          onChange={(e) => setRemoveDupes(e.target.checked)}
          className="mt-0.5 accent-[#e8b84a]"
        />
        <span className="text-[11.5px] text-[#f0ebe3] leading-snug">
          Remove duplicates
          {duplicates > 0 && <span className="text-white/45 tabular-nums"> ({duplicates} found)</span>}
          <span className="block text-[10.5px] text-white/45 mt-0.5">
            Identical copies are produced once; the load file names every custodian and location where a copy was found.
          </span>
        </span>
      </label>

      {error && <p className="text-[11px] text-red-300">{error}</p>}
      <button
        onClick={() => void confirm()}
        disabled={!prefix.trim() || busy || included === 0}
        className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-[#e8b84a]/15 hover:bg-[#e8b84a]/25 border border-[#e8b84a]/35 text-[#e8b84a] text-[12.5px] font-medium transition-colors disabled:opacity-40"
      >
        <Stamp size={14} strokeWidth={1.75} />
        {busy ? 'Queuing…' : `Stamp ${included} document${included === 1 ? '' : 's'}`}
      </button>
      <p className="text-[10px] text-white/35 leading-relaxed -mt-1">
        {movedStamps > 0
          ? `${movedStamps} document${movedStamps === 1 ? ' keeps its' : 's keep their'} own stamp position, set in the Review Room. `
          : 'To move the stamp on one document only, use the stamp menu in the Review Room toolbar. '}
        Stamping locks the production — late additions go in a supplemental production.
      </p>
    </div>
  );
}

// ── Step 2: Package ─────────────────────────────────────────────────────────

function PackageStep({ production, onQueued }: { production: Production; onQueued: (job: ProcessingJob) => void }) {
  const [includePrivLog, setIncludePrivLog] = useState(true);
  const [imageFormat, setImageFormat] = useState<'pdf' | 'tiff'>('pdf');
  // "Split into volumes of about N pages" (worker lib/discovery/volumes.mjs).
  // Off: one ZIP, unless the size would pass the storage limit.
  const [splitVolumes, setSplitVolumes] = useState(false);
  const [volumePages, setVolumePages] = useState(2500);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totalPages = production.bates_start != null && production.bates_end != null
    ? production.bates_end - production.bates_start + 1 : null;
  const pagesPerVolume = Math.min(Math.max(Math.round(volumePages) || 2500, 100), 100_000);

  const handlePackage = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const job = await enqueueJob({
        matterspace_id: production.matterspace_id,
        production_id: production.id,
        job_type: 'package_production',
        payload: {
          include_privilege_log: includePrivLog,
          image_format: imageFormat,
          ...(splitVolumes ? { volume_pages: pagesPerVolume } : {}),
        },
      });
      onQueued(job);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to queue packaging');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[11.5px] text-white/55 leading-relaxed">
        Stamped <span className="font-mono text-[#d4a054]">{batesRangeLabel(production) ?? ''}</span>.
        Packaging builds a ZIP with a sha256 (or one per volume), in the four standard parts: IMAGES (the stamped pages), NATIVES (spreadsheets, audio and video, as produced), TEXT (each document's text) and DATA (the load files).
      </p>
      <div className="space-y-1.5">
        <p className="text-[10.5px] uppercase tracking-wider text-white/40">Images</p>
        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Image format">
          {([
            ['pdf', 'PDF', 'One stamped PDF per document'],
            ['tiff', 'TIFF', 'One image per page (B&W TIFF, colour JPEG)'],
          ] as const).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={imageFormat === value}
              onClick={() => setImageFormat(value)}
              className={`text-left px-2.5 py-1.5 rounded-lg border transition-colors ${
                imageFormat === value
                  ? 'border-[#e8b84a]/50 bg-[#e8b84a]/10 text-[#e8b84a]'
                  : 'border-white/10 text-white/60 hover:border-white/20'
              }`}
            >
              <span className="block text-[12px] font-medium">{label}</span>
              <span className="block text-[10px] leading-snug opacity-70">{hint}</span>
            </button>
          ))}
        </div>
        <p className="text-[10px] text-white/35 leading-relaxed">
          Choose TIFF when the ESI protocol or the other side asks for it. The load files follow the choice.
        </p>
      </div>
      <label className="flex items-center gap-2 text-[11.5px] text-white/70 cursor-pointer">
        <input
          type="checkbox"
          checked={includePrivLog}
          onChange={(e) => setIncludePrivLog(e.target.checked)}
          className="accent-[#d4a054]"
        />
        Include the privilege log in the package
      </label>
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-[11.5px] text-white/70 cursor-pointer">
          <input
            type="checkbox"
            checked={splitVolumes}
            onChange={(e) => setSplitVolumes(e.target.checked)}
            className="accent-[#d4a054]"
          />
          Split into volumes of about
          <input
            type="number"
            min={100}
            step={100}
            value={volumePages}
            onChange={(e) => setVolumePages(Number(e.target.value))}
            disabled={!splitVolumes}
            aria-label="Pages per volume"
            className="w-[72px] rounded-md bg-[rgba(18,18,28,0.78)] border border-[rgba(255,255,255,0.1)] px-1.5 py-0.5 text-[11.5px] text-[#f0ebe3] disabled:opacity-40"
          />
          pages
        </label>
        <p className="text-[10px] text-white/35 leading-relaxed pl-6">
          {splitVolumes
            ? `Each volume is its own ZIP (NAME_VOL001, NAME_VOL002…) with its own load files; Bates numbers run on across them, and no document or email family is split.${
              totalPages ? ` About ${Math.max(1, Math.ceil(totalPages / pagesPerVolume))} volume(s) for ${totalPages.toLocaleString()} pages.` : ''}`
            : 'One ZIP. A production too large for one is split into volumes anyway, and the panel says so.'}
        </p>
      </div>
      {error && <p className="text-[11px] text-red-300">{error}</p>}
      <button
        onClick={() => void handlePackage()}
        disabled={busy}
        className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-[#e8b84a]/15 hover:bg-[#e8b84a]/25 border border-[#e8b84a]/35 text-[#e8b84a] text-[12.5px] font-medium transition-colors disabled:opacity-40"
      >
        <Package size={14} strokeWidth={1.75} />
        {busy ? 'Queuing…' : 'Package production'}
      </button>
    </div>
  );
}

// ── Step 3: Download + deliveries ───────────────────────────────────────────

function DeliveryStep({ production }: { production: Production }) {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [method, setMethod] = useState<'download' | 'email_link'>('download');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const split = isVolumeList(production.package_storage_path);
  const [volumes, setVolumes] = useState<PackageVolume[] | null>(null);
  const [autoSplit, setAutoSplit] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listDeliveries(production.id).then((d) => { if (!cancelled) setDeliveries(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [production.id]);

  useEffect(() => {
    if (!split) return;
    let cancelled = false;
    getPackageVolumes(production).then((r) => {
      if (cancelled || !r) return;
      setVolumes(r.volumes);
      setAutoSplit(r.autoSplit);
    }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read the volume list'); });
    return () => { cancelled = true; };
  }, [split, production]);

  const handleDownload = async (storagePath = production.package_storage_path) => {
    if (!storagePath) return;
    try {
      const url = await getDiscoverySignedUrl(storagePath, 600, 'download');
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to sign download URL');
    }
  };
  const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`);

  const handleRecord = async () => {
    if (!recipientName.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const row = await createDelivery({
        matterspace_id: production.matterspace_id,
        production_id: production.id,
        recipient_name: recipientName.trim(),
        recipient_email: recipientEmail.trim() || null,
        method,
        package_storage_path: production.package_storage_path,
        package_sha256: production.package_sha256,
        bates_range: batesRangeLabel(production),
      });
      setDeliveries((prev) => [row, ...prev]);
      setRecipientName('');
      setRecipientEmail('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to record delivery');
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    'w-full rounded-md bg-[rgba(18,18,28,0.78)] border border-[rgba(255,255,255,0.1)] px-2.5 py-1.5 text-[12px] text-[#f0ebe3] placeholder:text-white/30 focus:outline-none focus:border-[#d4a054]/60 transition-colors';

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-[#4ade80]/25 bg-[#4ade80]/6 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={13} className="text-[#4ade80] shrink-0" />
          <span className="text-[12px] text-[#4ade80] font-medium">
            Package ready{production.bates_prefix ? ` — ${batesRangeLabel(production)}` : ''}
          </span>
          {!split && (
            <button
              onClick={() => void handleDownload()}
              disabled={!production.package_storage_path}
              className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#4ade80]/12 hover:bg-[#4ade80]/22 border border-[#4ade80]/30 text-[#4ade80] text-[11px] font-medium transition-colors disabled:opacity-40 shrink-0"
            >
              <Download size={11} strokeWidth={2} />
              Download
            </button>
          )}
        </div>
        {split && (
          <div className="mt-2 space-y-1">
            <p className="text-[11px] text-white/60">
              {volumes ? `${volumes.length} volumes` : 'Reading the volumes…'}
              {autoSplit ? ' — split because one ZIP would have passed the storage limit (2 GB).' : '.'}
              {' '}Download each; the production&rsquo;s letter, privilege log and reconciliation are in the last.
            </p>
            {(volumes ?? []).map((v) => (
              <div key={v.name} className="flex items-center gap-2 rounded-md border border-white/8 px-2 py-1">
                <span className="text-[11px] text-[#f5f1e8] font-mono truncate" title={`sha256 ${v.sha256}`}>{v.name}</span>
                <span className="text-[10px] text-white/40 truncate">
                  {v.bates_first}–{v.bates_last} · {v.docs.toLocaleString()} doc(s) · {v.pages.toLocaleString()} p · {mb(v.bytes)}
                </span>
                <button
                  onClick={() => void handleDownload(v.storage_path)}
                  className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#4ade80]/12 hover:bg-[#4ade80]/22 border border-[#4ade80]/30 text-[#4ade80] text-[10.5px] font-medium shrink-0"
                >
                  <Download size={10} strokeWidth={2} />
                  Download
                </button>
              </div>
            ))}
          </div>
        )}
        {production.package_sha256 && (
          <p className="mt-1.5 text-[9.5px] font-mono text-white/40 break-all"
            title={split ? 'sha256 of the volume list, which records each volume\'s own sha256' : 'sha256 of the package'}>
            sha256 {production.package_sha256}{split ? ' (volume list)' : ''}
          </p>
        )}
      </div>

      <div>
        <p className="text-[10px] font-semibold text-white/45 uppercase tracking-wider mb-2">Record delivery</p>
        <div className="space-y-2">
          <input
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value)}
            placeholder="Recipient name"
            className={inputCls}
          />
          <input
            value={recipientEmail}
            onChange={(e) => setRecipientEmail(e.target.value)}
            placeholder="Recipient email (optional)"
            type="email"
            className={inputCls}
          />
          <div className="flex rounded-md border border-[rgba(255,255,255,0.1)] overflow-hidden">
            {(['download', 'email_link'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMethod(m)}
                className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${
                  method === m
                    ? 'bg-[#d4a054]/20 text-[#e8b84a]'
                    : 'text-white/55 hover:text-white hover:bg-[rgba(255,255,255,0.04)]'
                }`}
              >
                {m === 'download' ? 'Direct download' : 'Email link'}
              </button>
            ))}
          </div>
          {error && <p className="text-[11px] text-red-300">{error}</p>}
          <button
            onClick={() => void handleRecord()}
            disabled={!recipientName.trim() || busy}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-[#e8b84a]/15 hover:bg-[#e8b84a]/25 border border-[#e8b84a]/35 text-[#e8b84a] text-[12px] font-medium transition-colors disabled:opacity-40"
          >
            <Send size={12} strokeWidth={1.75} />
            {busy ? 'Recording…' : 'Record delivery'}
          </button>
        </div>
      </div>

      {deliveries.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-white/45 uppercase tracking-wider mb-1.5">Past deliveries</p>
          <div className="rounded-md border border-[rgba(255,255,255,0.08)] divide-y divide-[rgba(255,255,255,0.05)]">
            {deliveries.map((d) => (
              <div key={d.id} className="px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11.5px] text-[#f5f1e8] truncate">{d.recipient_name}</span>
                  <span className="text-[9.5px] uppercase tracking-wider text-white/35 border border-white/12 rounded px-1 py-px shrink-0">
                    {d.method === 'download' ? 'download' : 'email link'}
                  </span>
                  <span className="ml-auto text-[10px] text-white/40 tabular-nums shrink-0">
                    {new Date(d.sent_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                </div>
                {d.recipient_email && <p className="text-[10px] text-white/40 mt-0.5">{d.recipient_email}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
