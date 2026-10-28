// The product sheet's arithmetic and wording, kept pure so it can be tested
// without a browser (scripts/_test-merch-sheet.mjs): which colour and size
// pair is valid, which size a print should offer first for a given picture,
// what a thing costs, which mockup shows, what an order's status says.

import type { MerchBlueprint, MerchMockup, MerchOrder, MerchProduct, MerchVariant } from '@/lib/grapheon-merch';

/* ───────────────────────── Sizes ───────────────────────── */

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL', 'XXXL', '4XL', '5XL', '6XL'];
/** When nothing has been chosen, the size most people take. */
const SIZE_PREFERENCE = ['M', 'L', 'S', 'XL', 'One size'];

export type Orientation = 'vertical' | 'horizontal' | 'square';

/**
 * A print's size as Printify titles it: `8" x 12" (Vertical)`, `12″ x 16″
 * (Vertical)`, `24″ x 24″`, `10″ x 8″ (Horizontal)`. Both inch marks occur.
 */
export function parsePrintSize(size: string | null | undefined): { w: number; h: number; orientation: Orientation } | null {
  if (!size) return null;
  const m = /(\d+(?:\.\d+)?)\s*[″"”']?\s*[x×]\s*(\d+(?:\.\d+)?)/i.exec(size);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!(w > 0) || !(h > 0)) return null;
  const said = /vertical|portrait/i.test(size) ? 'vertical' : /horizontal|landscape/i.test(size) ? 'horizontal' : null;
  const orientation: Orientation = said ?? (w === h ? 'square' : w < h ? 'vertical' : 'horizontal');
  return { w, h, orientation };
}

export function pictureOrientation(w: number, h: number): Orientation {
  if (!(w > 0) || !(h > 0)) return 'square';
  const r = w / h;
  if (r > 1.05) return 'horizontal';
  if (r < 0.95) return 'vertical';
  return 'square';
}

/**
 * Sizes in the order the sheet offers them. Clothes: smallest to largest.
 * Prints: the picture's own orientation first, then square, then the other
 * way round; within a group, smallest first.
 */
export function sortSizes(sizes: string[], kind: string, picture?: Orientation | null): string[] {
  const unique = [...new Set(sizes.filter(Boolean))];
  if (kind === 'print') {
    const rank = (o: Orientation) => (!picture || picture === 'square' ? (o === 'square' ? 0 : 1) : o === picture ? 0 : o === 'square' ? 1 : 2);
    return unique
      .map((s, i) => ({ s, i, p: parsePrintSize(s) }))
      .sort((a, b) => {
        if (!a.p || !b.p) return a.p ? -1 : b.p ? 1 : a.i - b.i;
        const r = rank(a.p.orientation) - rank(b.p.orientation);
        if (r !== 0) return r;
        return a.p.w * a.p.h - b.p.w * b.p.h || a.i - b.i;
      })
      .map((x) => x.s);
  }
  return unique
    .map((s, i) => ({ s, i, r: SIZE_ORDER.indexOf(s.toUpperCase()) }))
    .sort((a, b) => (a.r === -1 && b.r === -1 ? a.i - b.i : a.r === -1 ? 1 : b.r === -1 ? -1 : a.r - b.r))
    .map((x) => x.s);
}

/* ───────────────────────── Colours and the valid pair ───────────────────────── */

export type Swatch = { name: string; hex: string | null };

/** The colours offered, in Printify's order, counting only variants that can be bought. */
export function coloursOf(variants: MerchVariant[]): Swatch[] {
  const seen = new Map<string, Swatch>();
  for (const v of variants) {
    if (v.available === false || !v.color) continue;
    if (!seen.has(v.color)) seen.set(v.color, { name: v.color, hex: v.color_hex });
  }
  return [...seen.values()];
}

/** The sizes offered in a colour (all sizes when the product has no colours). */
export function sizesFor(variants: MerchVariant[], color: string | null, kind: string, picture?: Orientation | null): string[] {
  const sizes = variants
    .filter((v) => v.available !== false && (color == null || v.color === color))
    .map((v) => v.size ?? '')
    .filter(Boolean);
  return sortSizes(sizes, kind, picture);
}

export function pickVariant(variants: MerchVariant[], color: string | null, size: string | null): MerchVariant | null {
  return variants.find((v) => v.available !== false && (color == null || v.color === color) && (size == null || v.size === size)) ?? null;
}

export type Choice = { color: string | null; size: string | null; variant: MerchVariant | null };

/**
 * The colour and size the sheet shows, kept to a pair that is actually
 * offered: the wanted colour if it exists, else the first; the wanted size
 * if it comes in that colour, else the usual one, else the first offered.
 */
export function reconcile(
  variants: MerchVariant[],
  want: { color?: string | null; size?: string | null },
  kind: string,
  picture?: Orientation | null,
): Choice {
  const swatches = coloursOf(variants);
  const hasColours = swatches.length > 0;
  const color = hasColours
    ? (swatches.find((s) => s.name === want.color)?.name ?? swatches[0].name)
    : null;
  const sizes = sizesFor(variants, color, kind, picture);
  const hasSizes = sizes.length > 0;
  let size: string | null = null;
  if (hasSizes) {
    if (want.size && sizes.includes(want.size)) size = want.size;
    else if (kind === 'print') size = sizes[0];
    else size = SIZE_PREFERENCE.find((s) => sizes.includes(s)) ?? sizes[0];
  }
  return { color, size, variant: pickVariant(variants, color, size) };
}

/* ───────────────────────── Money ───────────────────────── */

export function formatMoney(cents: number | null | undefined): string {
  const n = Math.max(0, Math.round(Number(cents) || 0));
  return `$${(n / 100).toFixed(2)}`;
}

/** The lowest price among the variants that can be bought; null if none. */
export function fromCents(variants: MerchVariant[]): number | null {
  const prices = variants.filter((v) => v.available !== false && v.price_cents > 0).map((v) => v.price_cents);
  return prices.length ? Math.min(...prices) : null;
}

export function shippingCents(bp: Pick<MerchBlueprint, 'shipping_first_cents' | 'shipping_additional_cents'>, quantity: number): number {
  const q = Math.min(10, Math.max(1, Math.floor(quantity) || 1));
  return Number(bp.shipping_first_cents || 0) + Number(bp.shipping_additional_cents || 0) * (q - 1);
}

export function clampQuantity(q: number): number {
  return Math.min(10, Math.max(1, Math.floor(Number(q) || 1)));
}

/* ───────────────────────── Mockups ───────────────────────── */

/** The picture to show for a variant: its own front mockup, else the default, else the first. */
export function mockupFor(mockups: MerchMockup[] | null | undefined, variantId: number | null): string | null {
  const list = mockups ?? [];
  if (list.length === 0) return null;
  const mine = variantId == null ? [] : list.filter((m) => (m.variant_ids || []).includes(variantId));
  const front = (xs: MerchMockup[]) => xs.find((m) => m.position === 'front') ?? xs.find((m) => m.is_default) ?? xs[0];
  return (mine.length ? front(mine) : list.find((m) => m.is_default) ?? front(list))?.src ?? null;
}

/* ───────────────────────── Products ───────────────────────── */

/** Of the products already made from a bench item, the one to reuse per blueprint: the newest made since the item last changed and not failed. */
export function reusableByKey(products: MerchProduct[], itemUpdatedAt: string | null): Map<string, MerchProduct> {
  const since = itemUpdatedAt ? Date.parse(itemUpdatedAt) : 0;
  const out = new Map<string, MerchProduct>();
  for (const p of [...products].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
    if (p.status === 'failed' || out.has(p.blueprint_key)) continue;
    if (Date.parse(p.created_at) < since) continue;
    out.set(p.blueprint_key, p);
  }
  return out;
}

/** "A tee", "A tote", "A print" — what the sheet calls each product. */
export function productNoun(kind: string, label?: string | null): string {
  if (kind === 'tee') return 'A tee';
  if (kind === 'tote') return 'A tote';
  if (kind === 'print') return 'A print';
  return label ? `A ${label.toLowerCase()}` : 'A product';
}

/* ───────────────────────── Orders ───────────────────────── */

/** One sentence for where an order stands. */
export function orderStatusSentence(o: Pick<MerchOrder, 'status' | 'tracking' | 'shipped_at'>): string {
  switch (o.status) {
    case 'pending': return 'Checkout was not finished. Nothing was charged.';
    case 'paid': return 'Paid. Placing it with the printer now.';
    case 'placed': return 'Placed with the printer, on hold until it goes to production. It can still be cancelled.';
    case 'in_production': return 'Being made. It cannot be cancelled now.';
    case 'shipped': {
      const t = (o.tracking || []).find((x) => x.number);
      return t ? `Shipped${t.carrier ? ` with ${t.carrier}` : ''}, tracking ${t.number}.` : 'Shipped.';
    }
    case 'delivered': return 'Delivered.';
    case 'canceled': return 'Cancelled.';
    case 'refunded': return 'Refunded.';
    case 'failed': return 'Checkout failed before payment. Nothing was charged.';
    default: return String(o.status);
  }
}

/** True while the sheet should keep asking the server about this order. */
export function orderStillMoving(status: MerchOrder['status']): boolean {
  return status === 'pending' || status === 'paid';
}

/* ───────────────────────── The way back from Stripe ───────────────────────── */

export type MerchReturn = { kind: 'paid' | 'cancel'; orderId: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?merch=paid&order=<id>` or `?merch=cancel&order=<id>` on the way back from Checkout. */
export function readMerchReturn(search: string): MerchReturn | null {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const kind = q.get('merch');
  if (kind !== 'paid' && kind !== 'cancel') return null;
  const order = q.get('order');
  return { kind, orderId: order && UUID_RE.test(order) ? order : null };
}

/** The same search string with the two return parameters taken out ('' when nothing is left). */
export function stripMerchReturn(search: string): string {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  q.delete('merch');
  q.delete('order');
  const s = q.toString();
  return s ? `?${s}` : '';
}
