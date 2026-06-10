import { useEffect, useMemo, useState } from 'react';
import { Stamp, Package, Download, Send, CheckCircle2 } from 'lucide-react';
import {
  maxBatesSeq, updateProduction, enqueueJob, getDiscoverySignedUrl,
  listDeliveries, createDelivery, formatBates, BATES_POSITIONS,
  type Production, type ProductionItem, type BatesPosition, type Delivery,
} from '@/lib/discovery';
import { batesRangeLabel } from './bits';
import FloatingPanel from './FloatingPanel';

// "Bates & Produce" — the outgoing-production pipeline panel. Its face
// changes with the production's status:
//   review   → Bates config + stamp
//   stamped  → package (with/without privilege log)
//   packaged → download + record delivery + past deliveries
export default function ProducePanel({
  production,
  items,
  onClose,
  onChanged,
}: {
  production: Production;
  items: ProductionItem[];
  onClose: () => void;
  onChanged: () => void;
}) {
  // Documents excluded from production: anything tagged with a def whose
  // behavior is 'privileged' or 'non_responsive'.
  const { included, excluded } = useMemo(() => {
    let ex = 0;
    for (const it of items) {
      if (it.tags.some((t) => t.tag_def?.behavior === 'privileged' || t.tag_def?.behavior === 'non_responsive')) ex++;
    }
    return { included: items.length - ex, excluded: ex };
  }, [items]);

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
        {production.status === 'review' && (
          <BatesStep production={production} included={included} excluded={excluded} onChanged={onChanged} />
        )}
        {(production.status === 'processing' || production.status === 'intake') && (
          <p className="text-[11.5px] text-white/45 leading-relaxed">
            Documents are still being intaken/normalized. Bates stamping unlocks when the
            production reaches <span className="text-[#7dd3fc]">review</span>.
          </p>
        )}
        {production.status === 'stamped' && (
          <PackageStep production={production} onChanged={onChanged} />
        )}
        {(production.status === 'packaged' || production.status === 'delivered') && (
          <DeliveryStep production={production} />
        )}
        {production.status === 'error' && (
          <p className="text-[11.5px] text-red-300">
            The last worker job failed — check the job log on the Discovery home, fix the cause,
            and re-run.
          </p>
        )}
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
  included,
  excluded,
  onChanged,
}: {
  production: Production;
  included: number;
  excluded: number;
  onChanged: () => void;
}) {
  const [prefix, setPrefix] = useState(production.bates_prefix ?? '');
  const [pad, setPad] = useState(production.bates_pad || 7);
  const [start, setStart] = useState<number>(production.bates_start ?? 1);
  const [position, setPosition] = useState<BatesPosition>(production.bates_position || 'lower_right');
  const [highWater, setHighWater] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default start = matter high-water mark + 1 (supplemental productions
  // continue the matter's numbering); 1 when nothing was ever stamped.
  useEffect(() => {
    let cancelled = false;
    maxBatesSeq(production.matterspace_id).then((max) => {
      if (cancelled) return;
      setHighWater(max);
      if (production.bates_start == null) setStart(max + 1);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [production.matterspace_id, production.bates_start]);

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
      await enqueueJob({
        matterspace_id: production.matterspace_id,
        production_id: production.id,
        job_type: 'stamp_production',
        payload: {},
      });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start stamping');
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
            onChange={(e) => setStart(parseInt(e.target.value, 10) || 1)}
            className={`${inputCls} w-full tabular-nums`}
          />
        </div>
      </div>
      {highWater !== null && highWater > 0 && (
        <p className="text-[10.5px] text-white/40 -mt-1.5">
          Matter high-water mark: <span className="text-white/65 tabular-nums">{highWater}</span> — numbering
          continues from there. Assigned Bates numbers are immutable.
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
          </p>
        </div>
      </div>

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
        Stamping locks the production — late additions go in a supplemental production.
      </p>
    </div>
  );
}

// ── Step 2: Package ─────────────────────────────────────────────────────────

function PackageStep({ production, onChanged }: { production: Production; onChanged: () => void }) {
  const [includePrivLog, setIncludePrivLog] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePackage = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await enqueueJob({
        matterspace_id: production.matterspace_id,
        production_id: production.id,
        job_type: 'package_production',
        payload: { include_privilege_log: includePrivLog },
      });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to queue packaging');
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[11.5px] text-white/55 leading-relaxed">
        Stamped <span className="font-mono text-[#d4a054]">{batesRangeLabel(production) ?? ''}</span>.
        Packaging bundles the endorsed PDFs, natives, and a load file into one ZIP with a sha256.
      </p>
      <label className="flex items-center gap-2 text-[11.5px] text-white/70 cursor-pointer">
        <input
          type="checkbox"
          checked={includePrivLog}
          onChange={(e) => setIncludePrivLog(e.target.checked)}
          className="accent-[#d4a054]"
        />
        Include the privilege log in the package
      </label>
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

  useEffect(() => {
    let cancelled = false;
    listDeliveries(production.id).then((d) => { if (!cancelled) setDeliveries(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [production.id]);

  const handleDownload = async () => {
    if (!production.package_storage_path) return;
    try {
      const url = await getDiscoverySignedUrl(production.package_storage_path, 600);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to sign download URL');
    }
  };

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
          <button
            onClick={() => void handleDownload()}
            disabled={!production.package_storage_path}
            className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#4ade80]/12 hover:bg-[#4ade80]/22 border border-[#4ade80]/30 text-[#4ade80] text-[11px] font-medium transition-colors disabled:opacity-40 shrink-0"
          >
            <Download size={11} strokeWidth={2} />
            Download
          </button>
        </div>
        {production.package_sha256 && (
          <p className="mt-1.5 text-[9.5px] font-mono text-white/40 break-all" title="sha256 of the package">
            sha256 {production.package_sha256}
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
