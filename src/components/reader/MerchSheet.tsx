import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Minus, Plus, X } from 'lucide-react';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import PinToggle from '@/components/ui/PinToggle';
import {
  merchApi as liveMerchApi, uploadPrintImage as liveUpload, myMerchProducts as liveMine, merchProductsById as liveById,
  type MerchApi, type MerchBlueprint, type MerchOrder, type MerchProduct, type MerchSource,
} from '@/lib/grapheon-merch';
import {
  type Orientation, coloursOf, sizesFor, reconcile, formatMoney, fromCents, shippingCents, clampQuantity,
  mockupFor, reusableByKey, productNoun, pictureOrientation, orderStatusSentence, orderStillMoving,
} from '@/lib/merch-sheet';

// The product sheet (Grapheon Reader, Phase 2b part 2): a picture from the
// bench on a tee, a tote, a print, sold where the picture is. It opens beside
// the page as a card — the house pattern: a ribbon to drag it by, four-edge
// resize, Pin — with the picture large at the top, the three products as
// three words, colours as swatches, sizes as words, the price in serif, and
// Buy, which is Stripe's own page. On a phone it is the whole screen.
//
// What it does, in order: shows the bench's own preview at once; sets the
// picture out for the print shop (an upload, unless a product made since the
// item last changed exists and lends its picture); makes the first product
// (Printify prices on the made product, so there is no price before that);
// polls for the mockup; makes the others as they are picked. Buy does not
// wait for the mockup — the variants exist from the make.
//
// The second view, Orders, is where a buyer lands on the way back from
// Stripe (?merch=paid&order=): each order is a sentence, refreshed from the
// print shop while it is still moving. Nothing here says anything about tax
// or terms; shipping is the one line the sheet knows (a flat rate per
// product), and the rest is Stripe's page.

export type MerchSheetOpen =
  | {
      kind: 'product';
      /** The bench item's id and when it last changed (products made before that are stale). */
      itemId: string;
      itemUpdatedAt: string | null;
      source: MerchSource;
      /** The bench's own preview of the picture, shown at once. */
      preview: string | null;
      /** The picture at print size, drawn on demand for the upload. */
      getBlob: () => Promise<Blob>;
      bookTitle: string | null;
    }
  | { kind: 'orders'; orderId?: string | null; notice?: string | null };

export type MerchSheetProps = {
  open: MerchSheetOpen;
  userId: string;
  /** Where Stripe sends the buyer back (this page, with its own query). */
  returnPath: string;
  onClose: () => void;
  /** Injectable for the harness. */
  deps?: {
    api?: MerchApi;
    upload?: typeof liveUpload;
    mine?: typeof liveMine;
    byId?: typeof liveById;
    go?: (url: string) => void;
    pollMs?: number;
  };
};

const serif = { fontFamily: '"Playfair Display Variable", serif' } as const;
const GOLD = '#e8b84a';
const MOCKUP_TRIES = 24; // × pollMs ≈ a minute

export default function MerchSheet({ open, userId, returnPath, onClose, deps }: MerchSheetProps) {
  const api = deps?.api ?? liveMerchApi;
  const upload = deps?.upload ?? liveUpload;
  const mine = deps?.mine ?? liveMine;
  const byId = deps?.byId ?? liveById;
  const go = deps?.go ?? ((url: string) => window.location.assign(url));
  const pollMs = deps?.pollMs ?? 2500;

  const { cardRef, pinned, togglePin, isMobile } = useDraggableResizable('cs.reader.merchSheet');
  const [view, setView] = useState<'product' | 'orders'>(open.kind);
  const notice = open.kind === 'orders' ? open.notice ?? null : null;

  // Esc closes, unless something is mid-flight that a close would lose.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = open.kind === 'product' && open.bookTitle ? open.bookTitle : 'Grapheon';

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label="Tee, tote or print"
      data-card-dialog="cs.reader.merchSheet"
      className={`${isMobile ? 'fixed inset-0' : 'fixed'} z-40 flex flex-col overflow-hidden border border-[rgba(255,255,255,0.12)] bg-[#0c0c13]/[0.96] text-[#e8e4de] shadow-2xl backdrop-blur-md ${isMobile ? '' : 'rounded-xl'}`}
      style={isMobile ? undefined : { right: 16, top: 72, width: 420, height: 'calc(100vh - 96px)', maxHeight: 'calc(100vh - 96px)' }}
    >
      {/* Ribbon: the drag handle. */}
      <div data-card-ribbon="" className={`shrink-0 border-b border-[rgba(255,255,255,0.08)] px-4 pt-1.5 pb-2.5 ${isMobile ? '' : 'cursor-grab'}`}>
        {!isMobile && (
          <div className="flex justify-center mb-1.5">
            <div className="w-12 h-1 rounded-full bg-white/25 hover:bg-white/45 transition-colors" title="Drag to move" />
          </div>
        )}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 pt-0.5">
            <h3 className="text-[17px] leading-snug text-white" style={serif}>
              {view === 'product' ? 'On a tee, a tote, a print' : 'Your orders'}
            </h3>
            <div className="text-[11.5px] text-white/50 mt-0.5 truncate">{title}</div>
          </div>
          <div className="flex items-center gap-1 shrink-0" data-card-inert="">
            {open.kind === 'product' && (
              <button
                onClick={() => setView((v) => (v === 'product' ? 'orders' : 'product'))}
                className="rounded px-1.5 py-1 text-[11px] text-white/60 hover:bg-white/[0.08] hover:text-white"
                title={view === 'product' ? 'What you have ordered' : 'Back to the picture'}
              >
                {view === 'product' ? 'Orders' : 'Picture'}
              </button>
            )}
            {!isMobile && <PinToggle pinned={pinned} onToggle={togglePin} />}
            <button onClick={onClose} className="p-1.5 rounded-md hover:bg-white/[0.08] text-white/60 hover:text-white" title="Close (Esc)" aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </div>
      </div>

      <div data-card-body="" className="flex-1 min-h-0 overflow-y-auto">
        {notice && (
          <p className="mx-4 mt-3 rounded-md border border-[rgba(232,184,74,0.35)] bg-[rgba(232,184,74,0.08)] px-2.5 py-1.5 text-[12px] text-[#e8b84a]">
            {notice}
          </p>
        )}
        {view === 'product' && open.kind === 'product' ? (
          <ProductView open={open} userId={userId} returnPath={returnPath} api={api} upload={upload} mine={mine} go={go} pollMs={pollMs} />
        ) : (
          <OrdersView freshId={open.kind === 'orders' ? open.orderId ?? null : null} api={api} byId={byId} pollMs={pollMs} />
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── The picture on a product ───────────────────────── */

type ProductDeps = { api: MerchApi; upload: typeof liveUpload; mine: typeof liveMine; go: (url: string) => void; pollMs: number };

function ProductView({ open, userId, returnPath, api, upload, mine, go, pollMs }: { open: Extract<MerchSheetOpen, { kind: 'product' }>; userId: string; returnPath: string } & ProductDeps) {
  const [blueprints, setBlueprints] = useState<MerchBlueprint[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [key, setKey] = useState<string | null>(null);
  const [products, setProducts] = useState<Map<string, MerchProduct>>(new Map());
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [picture, setPicture] = useState<Orientation | null>(null);
  const [want, setWant] = useState<{ color: string | null; size: string | null }>({ color: null, size: null });
  const [quantity, setQuantity] = useState(1);
  const [fill, setFill] = useState(false);
  const [line, setLine] = useState<string | null>('Setting the picture out…');
  const [trouble, setTrouble] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);
  const making = useRef(new Set<string>());
  // StrictMode mounts, unmounts and mounts again: set on the way in, not only cleared on the way out.
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const bp = blueprints?.find((b) => b.key === key) ?? null;
  const product = key ? products.get(key) ?? null : null;
  const variants = useMemo(() => product?.variants ?? [], [product]);
  const choice = useMemo(() => reconcile(variants, want, bp?.kind ?? 'tee', picture), [variants, want, bp?.kind, picture]);
  const swatches = useMemo(() => coloursOf(variants), [variants]);
  const sizes = useMemo(() => sizesFor(variants, choice.color, bp?.kind ?? 'tee', picture), [variants, choice.color, bp?.kind, picture]);
  const mockup = mockupFor(product?.mockups, choice.variant?.id ?? null);
  const shown = mockup ?? open.preview;
  const unit = choice.variant?.price_cents ?? null;
  const ship = bp ? shippingCents(bp, quantity) : 0;

  // Make (or reuse) the product for a blueprint.
  const makeFor = useCallback(async (k: string, url: string, fillNow: boolean) => {
    if (making.current.has(k)) return;
    making.current.add(k);
    setTrouble(null);
    setLine('Making it at the print shop…');
    try {
      const r = await api<{ product: MerchProduct }>('make', {
        source: open.source, blueprint_key: k, image_url: url, title: open.bookTitle, placement: { fill: fillNow },
      });
      if (!live.current) return;
      setProducts((m) => new Map(m).set(k, r.product));
      setLine(r.product.status === 'rendering' ? 'The print shop is drawing it…' : null);
    } catch (e) {
      if (!live.current) return;
      setLine(null);
      setTrouble(e instanceof Error ? e.message : 'The print shop did not answer.');
    } finally {
      making.current.delete(k);
    }
  }, [api, open.source, open.bookTitle]);

  // Open: the products on offer, what was made before, the picture set out, the first product made.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api<{ products: MerchBlueprint[]; configured: boolean }>('products');
        if (cancelled) return;
        setBlueprints(r.products);
        setConfigured(r.configured !== false);
        const first = r.products[0]?.key ?? null;
        setKey(first);
        if (r.configured === false) { setLine(null); return; }
        const had = reusableByKey(await mine(open.itemId), open.itemUpdatedAt);
        if (cancelled) return;
        if (had.size > 0) {
          setProducts(new Map(had));
          const shown = had.get(first ?? '') ?? [...had.values()][0];
          if (shown?.placement?.fill != null) setFill(shown.placement.fill === true);
        }
        let url = [...had.values()][0]?.image_url ?? null;
        if (!url) {
          const blob = await open.getBlob();
          url = await upload({ userId, itemId: open.itemId, blob });
        }
        if (cancelled) return;
        setImageUrl(url);
        if (first && !had.has(first)) await makeFor(first, url, false);
        else setLine(had.get(first ?? '')?.status === 'rendering' ? 'The print shop is drawing it…' : null);
      } catch (e) {
        if (cancelled) return;
        setLine(null);
        setTrouble(e instanceof Error ? e.message : 'The picture could not be set out.');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open.itemId]);

  // A product picked that is not made yet.
  useEffect(() => {
    if (!key || !imageUrl || products.has(key) || !configured) return;
    void makeFor(key, imageUrl, fill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, imageUrl]);

  // Poll for the mockup while the print shop draws.
  useEffect(() => {
    if (!product || product.status !== 'rendering') return;
    let tries = 0;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      tries += 1;
      try {
        const r = await api<{ product: MerchProduct }>('mockups', { product_id: product.id });
        if (cancelled) return;
        if (r.product.status !== 'rendering') {
          setProducts((m) => new Map(m).set(r.product.blueprint_key, r.product));
          setLine(null);
          return;
        }
      } catch { /* try again */ }
      if (tries < MOCKUP_TRIES) setTimeout(tick, pollMs);
      else setLine('The mockup is slow today; the picture above is what will be printed.');
    };
    const t = setTimeout(tick, pollMs);
    return () => { cancelled = true; clearTimeout(t); };
  }, [product, api, pollMs]);

  // The picture's orientation, for which print sizes come first.
  const onPreviewLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (mockup) return; // a mockup's shape is the product's, not the picture's
    const el = e.currentTarget;
    if (el.naturalWidth && el.naturalHeight) setPicture(pictureOrientation(el.naturalWidth, el.naturalHeight));
  };

  const buy = async () => {
    if (!product || !choice.variant || buying) return;
    setBuying(true);
    setTrouble(null);
    try {
      const r = await api<{ url: string; order_id: string }>('checkout', {
        product_id: product.id, variant_id: choice.variant.id, quantity, return_path: returnPath,
      });
      go(r.url);
    } catch (e) {
      setTrouble(e instanceof Error ? e.message : 'Checkout could not start.');
      setBuying(false);
    }
  };

  const refill = (next: boolean) => {
    // A new placement is a new product: forget the made ones and make again on demand.
    setFill(next);
    setProducts(new Map());
    if (key && imageUrl) void makeFor(key, imageUrl, next);
  };

  return (
    <div className="px-4 pb-5">
      {/* The picture, large. */}
      <div className="relative mt-3 flex items-center justify-center overflow-hidden rounded-md bg-black/40" style={{ minHeight: 220 }}>
        {shown ? (
          <img
            src={shown}
            alt={product ? product.title : 'The picture'}
            onLoad={onPreviewLoad}
            className="max-h-[360px] w-full object-contain"
            draggable={false}
          />
        ) : (
          <Loader2 size={16} className="animate-spin text-white/40" />
        )}
        {line && (
          <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 bg-black/60 px-3 py-1.5 text-[11.5px] text-white/80">
            <Loader2 size={12} className="animate-spin shrink-0" /> {line}
          </div>
        )}
      </div>
      {trouble && <p className="mt-2 text-[12px] text-red-300">{trouble}</p>}
      {!configured && <p className="mt-2 text-[12px] text-white/60">The print shop is not connected on this deployment.</p>}

      {/* The three products, as words. */}
      {blueprints && blueprints.length > 0 && (
        <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-1" data-card-inert="">
          {blueprints.map((b) => {
            const made = products.get(b.key);
            const from = made ? fromCents(made.variants) : null;
            const on = b.key === key;
            return (
              <button
                key={b.key}
                onClick={() => { setKey(b.key); setWant({ color: null, size: null }); }}
                className={`group text-left ${on ? 'text-white' : 'text-white/55 hover:text-white/85'}`}
                aria-pressed={on}
              >
                <span className="text-[19px] leading-none" style={{ ...serif, borderBottom: on ? `1px solid ${GOLD}` : '1px solid transparent', paddingBottom: 2 }}>
                  {productNoun(b.kind, b.label)}
                </span>
                <span className="ml-1.5 text-[11px] text-white/45">
                  {from != null ? `from ${formatMoney(from)}` : `about ${formatMoney(b.estimate_cents)}`}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Colour. */}
      {swatches.length > 0 && (
        <div className="mt-4" data-card-inert="">
          <div className="text-[11px] uppercase tracking-[0.12em] text-white/40">Colour · <span className="normal-case tracking-normal text-white/70">{choice.color}</span></div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {swatches.map((s) => {
              const on = s.name === choice.color;
              return (
                <button
                  key={s.name}
                  onClick={() => setWant((w) => ({ ...w, color: s.name }))}
                  title={s.name}
                  aria-label={s.name}
                  aria-pressed={on}
                  className="h-6 w-6 rounded-full border transition-transform hover:scale-110"
                  style={{ background: s.hex ?? '#777', borderColor: on ? GOLD : 'rgba(255,255,255,0.25)', boxShadow: on ? `0 0 0 2px #0c0c13, 0 0 0 3px ${GOLD}` : undefined }}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Size. */}
      {sizes.length > 0 && !(sizes.length === 1 && sizes[0] === 'One size') && (
        <div className="mt-4" data-card-inert="">
          <div className="text-[11px] uppercase tracking-[0.12em] text-white/40">{bp?.kind === 'print' ? 'Size' : 'Size'}</div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1.5">
            {sizes.map((s) => {
              const on = s === choice.size;
              return (
                <button
                  key={s}
                  onClick={() => setWant((w) => ({ ...w, size: s }))}
                  aria-pressed={on}
                  className={`text-[13px] ${on ? 'text-white' : 'text-white/55 hover:text-white/85'}`}
                  style={{ borderBottom: on ? `1px solid ${GOLD}` : '1px solid transparent', paddingBottom: 1 }}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Placement. */}
      {product && (
        <label className="mt-4 flex items-center gap-2 text-[12px] text-white/60 cursor-pointer select-none" data-card-inert="">
          <input type="checkbox" checked={fill} onChange={(e) => refill(e.target.checked)} className="accent-[#e8b84a]" />
          Fill the print area (edge to edge, which may crop)
        </label>
      )}

      {/* Price, quantity, Buy. */}
      {product && choice.variant && (
        <div className="mt-5 flex items-end justify-between gap-3" data-card-inert="">
          <div>
            <div className="text-[30px] leading-none text-white" style={serif}>{formatMoney(unit)}</div>
            <div className="mt-1 text-[11.5px] text-white/50">
              each · shipping {formatMoney(ship)} for {quantity === 1 ? 'one' : quantity} · US addresses
            </div>
          </div>
          <div className="flex items-center gap-1 text-[13px] text-white/80">
            <button onClick={() => setQuantity((q) => clampQuantity(q - 1))} disabled={quantity <= 1} className="rounded p-1 hover:bg-white/10 disabled:opacity-30" aria-label="One fewer"><Minus size={13} /></button>
            <span className="w-5 text-center tabular-nums">{quantity}</span>
            <button onClick={() => setQuantity((q) => clampQuantity(q + 1))} disabled={quantity >= 10} className="rounded p-1 hover:bg-white/10 disabled:opacity-30" aria-label="One more"><Plus size={13} /></button>
          </div>
        </div>
      )}
      {product && choice.variant && (
        <div className="mt-4" data-card-inert="">
          <button
            onClick={() => void buy()}
            disabled={buying || !configured}
            className="w-full rounded-md border px-4 py-2.5 text-[14px] transition-colors disabled:opacity-50"
            style={{ borderColor: GOLD, color: buying ? '#0c0c13' : GOLD, background: buying ? GOLD : 'transparent' }}
            onMouseEnter={(e) => { if (!buying) { e.currentTarget.style.background = GOLD; e.currentTarget.style.color = '#0c0c13'; } }}
            onMouseLeave={(e) => { if (!buying) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = GOLD; } }}
          >
            {buying ? 'Opening checkout…' : `Buy — ${formatMoney((unit ?? 0) * quantity + ship)} at checkout`}
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-white/45">
            You pay on Stripe's page. The print shop makes it after payment; it can be cancelled any time before it goes into production.
          </p>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Orders ───────────────────────── */

function OrdersView({ freshId, api, byId, pollMs }: { freshId: string | null; api: MerchApi; byId: typeof liveById; pollMs: number }) {
  const [orders, setOrders] = useState<MerchOrder[] | null>(null);
  const [products, setProducts] = useState<Map<string, MerchProduct>>(new Map());
  const [trouble, setTrouble] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api<{ orders: MerchOrder[] }>('orders');
        if (cancelled) return;
        setOrders(r.orders);
        setProducts(await byId(r.orders.map((o) => o.product_id)));
      } catch (e) {
        if (!cancelled) setTrouble(e instanceof Error ? e.message : 'Your orders could not be read.');
      }
    })();
    return () => { cancelled = true; };
  }, [api, byId]);

  // The order just paid for: ask again until the webhook has placed it.
  useEffect(() => {
    if (!freshId) return;
    let tries = 0;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      tries += 1;
      try {
        const r = await api<{ order: MerchOrder }>('order', { order_id: freshId });
        if (cancelled) return;
        setOrders((os) => (os ? os.map((o) => (o.id === r.order.id ? r.order : o)) : [r.order]));
        if (!orderStillMoving(r.order.status)) return;
      } catch { /* try again */ }
      if (tries < 12) setTimeout(tick, pollMs);
    };
    const t = setTimeout(tick, Math.min(pollMs, 1200));
    return () => { cancelled = true; clearTimeout(t); };
  }, [freshId, api, pollMs]);

  if (trouble) return <p className="px-4 py-4 text-[12px] text-red-300">{trouble}</p>;
  if (!orders) return <p className="flex items-center gap-2 px-4 py-4 text-[12px] text-white/60"><Loader2 size={12} className="animate-spin" /> Reading your orders…</p>;
  if (orders.length === 0) return <p className="px-4 py-6 text-[13px] text-white/60">Nothing ordered yet.</p>;

  return (
    <div className="px-4 pb-5">
      {orders.map((o) => {
        const p = products.get(o.product_id);
        const pic = mockupFor(p?.mockups, o.variant_id) ?? p?.image_url ?? null;
        const fresh = o.id === freshId;
        return (
          <div key={o.id} className={`mt-4 flex gap-3 ${fresh ? '' : ''}`}>
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded bg-black/40">
              {pic && <img src={pic} alt="" className="h-full w-full object-cover" draggable={false} />}
            </div>
            <div className="min-w-0 text-[12.5px] leading-relaxed text-white/80">
              <div className="text-[15px] text-white" style={serif}>
                {p?.title ?? 'A product'}{o.variant_title ? `, ${o.variant_title}` : ''}{o.quantity > 1 ? ` × ${o.quantity}` : ''}
              </div>
              <div>
                {formatMoney(o.total_cents)} on {new Date(o.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}.{' '}
                <span className={fresh ? 'text-[#e8b84a]' : ''}>{orderStatusSentence(o)}</span>
                {o.status === 'shipped' && o.tracking?.[0]?.url && (
                  <> <a href={o.tracking[0].url ?? undefined} target="_blank" rel="noreferrer" className="underline underline-offset-2 text-white/70 hover:text-white">Track it</a></>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
