// POST /api/merch — a picture from the bench on a tee, a tote, a print
// (Grapheon Reader, Phase 2b; docs/specs/GRAPHEON-READER-2026-10-10.md,
// "Merchandise (Phase 2b)"; migration 117).
//
// The one door between the reader and Printify and Stripe. Every action:
//   1. verifies the bearer with Supabase Auth, as every api/ file does;
//   2. asks the rights question AS THE USER (anon key + bearer, so RLS
//      decides what the reader can see), never with the service key;
//   3. only then talks to Printify or Stripe with the deployment's keys
//      and writes the record with the service role.
//
// Actions (request { action, ... })
//   products                 → { products: [...] }      the curated blueprints (enabled rows)
//   make                     → { product }              upload the picture, make the Printify
//     source {kind,id,bench_item_id}, blueprint_key,     product, price its variants (D9), keep
//     image_url, title, placement {fill}                 the row; mockups follow
//   mockups, product_id      → { product }              poll until Printify has drawn them
//   checkout, product_id,    → { url, order_id }        a pending order and a Stripe Checkout
//     variant_id, quantity, return_path                   Session (US shipping, flat rate)
//   order, order_id          → { order }                one order, refreshed from Printify when
//                                                        it has been placed
//   orders                   → { orders: [...] }        the caller's orders, newest first
//   cancel, order_id         → { order }                a held order: cancelled at the printer,
//                                                        refunded in full; 409 too_late once
//                                                        it is in production
//
// The rights gate in `make` (D11 and the Library rule), server-side:
//   document: the bench item is readable as the user; its document's matter
//             is in the Library serverspace. Matter material is never offered.
//   edition:  _edition_can_read as the user; a snip needs the edition to be
//             public domain (or merch_allowed, false everywhere in 2b); a
//             media item must be the caller's own. An edition_illustrations
//             row is never a source.
//   and the picture must sit under cover-images/<caller>/prints/ — the folder
//   the bench writes — or anyone could hand Grapheon any picture to print.
//
// Prices: Printify reports a variant's cost only on the product it has made,
// so `make` creates the product first and prices from the answer:
// cost × 1.4, taken up to the next .99 (D9). Shipping is a flat line from
// the blueprint row. Grapheon.ai LLC's Stripe account (D3), never
// Contextspaces' — GRAPHEON_STRIPE_SECRET_KEY, not STRIPE_SECRET_KEY.
//
// Refusals 401 missing_bearer / invalid_session · 403 not_allowed
//          · 404 not_found · 400 bad_request · 409 not_ready
//          · 502 printify_error / stripe_error · 503 merch_not_configured
//
// Plain fetch with an injectable fetchImpl, like api/editions.mjs, so
// scripts/_test-merch-api.mjs drives this file with no network.

import {
  json, corsPreflight, bearerFrom, readJsonBody, authUser, userRpcClient,
  SUPABASE_URL, ANON_KEY, SERVICE_KEY,
} from '../lib/account-security.mjs';
import { stripeRequest } from '../lib/stripe-core.mjs';
import {
  printifyConfigured, PrintifyAPIError, uploadImageToPrintify, getBlueprintVariants,
  createPrintifyProduct, updateProductPrices, getPrintifyProduct, getOrderStatus, cancelPrintifyOrder,
} from '../lib/printify.mjs';
import { productionMode, cancelWindowMin, cancelUntil } from '../lib/merch-window.mjs';

const TIMEOUT_MS = 8000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['products', 'make', 'mockups', 'checkout', 'order', 'orders', 'cancel']);
const PRINTS_BUCKET = 'cover-images';
const LIBRARY_SERVERSPACE = 'library';
const LOG = '[merch]';

const base = () => String(SUPABASE_URL() || '').replace(/\/$/, '');

export const grapheonStripeKey = (env = process.env) => env.GRAPHEON_STRIPE_SECRET_KEY || '';

/** D9: Printify's cost plus a flat 40%, taken up to the next .99. */
export function priceCents(costCents) {
  const c = Math.max(0, Number(costCents) || 0);
  const raw = c * 1.4;
  return Math.ceil((raw - 99) / 100) * 100 + 99;
}

/** The picture must be the caller's own upload under cover-images/<uid>/prints/. */
export function imageUrlIsMine(url, userId, supabaseUrl = base()) {
  const prefix = `${String(supabaseUrl).replace(/\/$/, '')}/storage/v1/object/public/${PRINTS_BUCKET}/${userId}/prints/`;
  if (typeof url !== 'string' || !url.startsWith(prefix)) return false;
  const rest = url.slice(prefix.length);
  return /^[A-Za-z0-9._-]+$/.test(rest);
}

/* ───────────────────────── PostgREST helpers ───────────────────────── */

async function userSelect(bearer, table, query, doFetch) {
  try {
    const res = await doFetch(`${base()}/rest/v1/${table}?${query}`, {
      headers: { apikey: ANON_KEY(), authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, rows: null };
    const rows = await res.json().catch(() => null);
    return { ok: Array.isArray(rows), status: res.status, rows: Array.isArray(rows) ? rows : null };
  } catch {
    return { ok: false, status: 0, rows: null };
  }
}

async function serviceSelect(table, query, doFetch) {
  try {
    const res = await doFetch(`${base()}/rest/v1/${table}?${query}`, {
      headers: { apikey: SERVICE_KEY(), authorization: `Bearer ${SERVICE_KEY()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, rows: null };
    const rows = await res.json().catch(() => null);
    return { ok: Array.isArray(rows), status: res.status, rows: Array.isArray(rows) ? rows : null };
  } catch {
    return { ok: false, status: 0, rows: null };
  }
}

export async function serviceWrite(method, table, query, body, doFetch) {
  try {
    const res = await doFetch(`${base()}/rest/v1/${table}${query ? `?${query}` : ''}`, {
      method,
      headers: {
        'content-type': 'application/json',
        apikey: SERVICE_KEY(),
        authorization: `Bearer ${SERVICE_KEY()}`,
        prefer: 'return=representation',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, row: null, error: data?.message ?? `write_${res.status}` };
    return { ok: true, status: res.status, row: Array.isArray(data) ? data[0] ?? null : data, error: null };
  } catch (err) {
    return { ok: false, status: 0, row: null, error: err?.message || 'write_unreachable' };
  }
}

/* ───────────────────────── Shapes ───────────────────────── */

/** What a reader may see of a product row. */
function publicProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    blueprint_key: row.blueprint_key,
    title: row.title,
    image_url: row.image_url,
    options: row.options ?? [],
    variants: row.variants ?? [],
    mockups: row.mockups ?? [],
    placement: row.placement ?? {},
    status: row.status,
    error: row.error ?? null,
    created_at: row.created_at,
  };
}

function publicOrder(row, env = process.env) {
  if (!row) return null;
  return {
    id: row.id,
    product_id: row.product_id,
    variant_id: row.variant_id,
    variant_title: row.variant_title,
    quantity: row.quantity,
    currency: row.currency,
    item_cents: row.item_cents,
    shipping_cents: row.shipping_cents,
    tax_cents: row.tax_cents,
    total_cents: row.total_cents,
    status: row.status,
    tracking: row.tracking ?? [],
    placed_at: row.placed_at,
    sent_to_production_at: row.sent_to_production_at ?? null,
    // Until when the buyer can cancel it here (window mode); null when it waits for a hand.
    cancel_until: cancelUntil(row, env),
    shipped_at: row.shipped_at,
    created_at: row.created_at,
    error: row.error ?? null,
  };
}

/**
 * Printify's product, read into our row: the options (colours carry their
 * hex), the variants with cost and our price, the mockups.
 */
export function readPrintifyProduct(p) {
  const options = (p?.options || []).map((o) => ({
    name: o.name,
    type: o.type,
    values: (o.values || []).map((v) => ({ id: v.id, title: v.title, colors: v.colors || null })),
  }));
  const byOptionId = new Map();
  for (const o of options) for (const v of o.values) byOptionId.set(v.id, { type: o.type, ...v });
  const variants = (p?.variants || []).map((v) => {
    let color = null; let size = null; let colorHex = null; let paper = null;
    for (const oid of v.options || []) {
      const ov = byOptionId.get(oid);
      if (!ov) continue;
      if (ov.type === 'color') { color = ov.title; colorHex = ov.colors?.[0] ?? null; }
      else if (ov.type === 'size') size = ov.title;
      else if (ov.type === 'paper') paper = ov.title;
    }
    const cost = Number(v.cost) || 0;
    return {
      id: v.id,
      title: v.title,
      color,
      color_hex: colorHex,
      size,
      paper,
      cost_cents: cost,
      price_cents: priceCents(cost),
      available: v.is_available !== false,
    };
  });
  const mockups = (p?.images || []).map((im) => ({
    src: im.src, variant_ids: im.variant_ids || [], position: im.position || 'front', is_default: !!im.is_default,
  }));
  return { options, variants, mockups };
}

/* ───────────────────────── The rights gate ───────────────────────── */

/**
 * May this caller put this bench item on merchandise? Returns { ok, title }
 * or { ok: false, status, error, message }.
 */
async function rightsFor(bearer, user, source, doFetch) {
  const kind = source?.kind;
  const id = String(source?.id ?? '');
  const benchId = String(source?.bench_item_id ?? '');

  // A spotlight picture: set out by the editors under cover-images/spotlight/
  // (only the service role can write there — the bucket lets a user write
  // under their own uid alone), for a public-domain edition. Its presence
  // there is the editors' attestation; no bench item is involved. The row is
  // written as an edition product with no bench item.
  if (kind === 'spotlight') {
    const slug = String(source?.slug ?? '');
    const file = String(source?.file ?? '');
    if (!UUID_RE.test(id) || !/^[a-z0-9-]{3,60}$/.test(slug) || !/^[A-Za-z0-9._-]{1,120}$/.test(file) || file.includes('..')) {
      return { ok: false, status: 400, error: 'bad_request', message: 'The spotlight needs its edition, its slug and its picture.' };
    }
    const ed = await serviceSelect('editions', `id=eq.${id}&select=id,title,rights`, doFetch);
    if (!ed.ok) return { ok: false, status: 503, error: 'storage_unavailable', message: 'The edition could not be checked.' };
    const e = ed.rows[0];
    if (!e) return { ok: false, status: 404, error: 'not_found', message: 'The spotlighted edition could not be found.' };
    if (e.rights !== 'public_domain') {
      return { ok: false, status: 403, error: 'not_allowed', message: 'Only a public-domain work’s pictures go on merchandise from a spotlight.' };
    }
    const url = `${base()}/storage/v1/object/public/${PRINTS_BUCKET}/spotlight/${slug}/${file}`;
    let head = null;
    try { head = await doFetch(url, { method: 'HEAD' }); } catch { head = null; }
    if (!head || !head.ok) return { ok: false, status: 404, error: 'not_found', message: 'That spotlight picture is not on the shelf.' };
    return { ok: true, title: e.title || 'Grapheon' };
  }

  if (!UUID_RE.test(id) || !UUID_RE.test(benchId)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'The source needs an id and a bench item.' };
  }

  if (kind === 'document') {
    // The bench item, as the user: RLS says whether they can see it at all.
    const item = await userSelect(bearer, 'document_workshop_items',
      `id=eq.${benchId}&document_id=eq.${id}&select=id,kind,user_id,media_document_id`, doFetch);
    if (!item.ok) return { ok: false, status: 503, error: 'storage_unavailable', message: 'The bench could not be read.' };
    const row = item.rows[0];
    if (!row) return { ok: false, status: 404, error: 'not_found', message: 'That bench item is not yours to see.' };
    if (row.kind === 'snippet') return { ok: false, status: 400, error: 'bad_request', message: 'A snippet is words, not a picture.' };
    if (row.kind === 'media' && row.user_id !== user.id) {
      return { ok: false, status: 403, error: 'not_allowed', message: 'Only the person who brought a still in can put it on merchandise.' };
    }
    // The document's matter must be in the Library serverspace (never matter material).
    const doc = await userSelect(bearer, 'documents', `id=eq.${id}&select=id,title,matterspace_id`, doFetch);
    const d = doc.ok ? doc.rows[0] : null;
    if (!d) return { ok: false, status: 404, error: 'not_found', message: 'The book could not be read.' };
    const matter = d.matterspace_id
      ? await userSelect(bearer, 'matterspaces', `id=eq.${d.matterspace_id}&select=id,serverspace_id`, doFetch)
      : { ok: true, rows: [] };
    const ssId = matter.ok ? matter.rows[0]?.serverspace_id : null;
    const ss = ssId ? await userSelect(bearer, 'serverspaces', `id=eq.${ssId}&select=id,name`, doFetch) : { ok: true, rows: [] };
    const name = String(ss.ok ? ss.rows[0]?.name ?? '' : '').trim().toLowerCase();
    if (name !== LIBRARY_SERVERSPACE) {
      return { ok: false, status: 403, error: 'not_allowed', message: 'Only a Library book can go on merchandise.' };
    }
    return { ok: true, title: d.title || 'Grapheon' };
  }

  if (kind === 'edition') {
    const can = await userRpcClient(bearer, { fetchImpl: doFetch }).rpc('_edition_can_read', { p_edition: id });
    if (can.error) return { ok: false, status: 503, error: 'storage_unavailable', message: 'The edition could not be checked.' };
    if (can.data !== true) return { ok: false, status: 403, error: 'not_allowed', message: 'You cannot read that edition.' };
    const item = await userSelect(bearer, 'edition_bench_items',
      `id=eq.${benchId}&edition_id=eq.${id}&select=id,kind,user_id`, doFetch);
    const row = item.ok ? item.rows[0] : null;
    if (!row) return { ok: false, status: 404, error: 'not_found', message: 'That bench item is not yours to see.' };
    if (row.kind === 'snippet') return { ok: false, status: 400, error: 'bad_request', message: 'A snippet is words, not a picture.' };
    const ed = await userSelect(bearer, 'editions', `id=eq.${id}&select=id,title,rights,merch_allowed`, doFetch);
    const e = ed.ok ? ed.rows[0] : null;
    if (!e) return { ok: false, status: 404, error: 'not_found', message: 'The edition could not be read.' };
    if (row.kind === 'snip' && e.rights !== 'public_domain' && e.merch_allowed !== true) {
      return { ok: false, status: 403, error: 'not_allowed', message: 'This edition’s pictures are in copyright and are not offered on merchandise.' };
    }
    if (row.kind === 'media' && row.user_id !== user.id) {
      return { ok: false, status: 403, error: 'not_allowed', message: 'Only the person who brought a still in can put it on merchandise.' };
    }
    return { ok: true, title: e.title || 'Grapheon' };
  }

  return { ok: false, status: 400, error: 'bad_request', message: 'The source must be a document, an edition or a spotlight.' };
}

/* ───────────────────────── Handler ───────────────────────── */

export default async function handler(req, res, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const env = deps.env || process.env;
  const ctx = { fetchImpl: doFetch, env };
  if (corsPreflight(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  if (!SUPABASE_URL() || !ANON_KEY() || !SERVICE_KEY()) return json(res, 500, { error: 'config_error' });

  const bearer = bearerFrom(req);
  if (!bearer) return json(res, 401, { error: 'missing_bearer' });
  const user = await authUser(bearer, { fetchImpl: doFetch });
  if (!user) return json(res, 401, { error: 'invalid_session' });

  const body = await readJsonBody(req);
  const action = String(body?.action ?? '');
  if (!ACTIONS.has(action)) return json(res, 400, { error: 'bad_request', message: 'Unknown action.' });

  if (action === 'products') {
    const r = await serviceSelect('merch_blueprints', 'enabled=is.true&order=sort_order.asc&select=key,kind,label,estimate_cents,shipping_first_cents,shipping_additional_cents,countries,default_scale', doFetch);
    if (!r.ok) return json(res, 503, { error: 'storage_unavailable' });
    return json(res, 200, {
      products: r.rows,
      configured: printifyConfigured(env) && Boolean(grapheonStripeKey(env)),
      // Minutes a paid order waits before it goes to the printer; null when it waits for a hand.
      cancel_window_min: productionMode(env) === 'window' ? cancelWindowMin(env) : null,
    });
  }

  if (action === 'orders') {
    const r = await userSelect(bearer, 'merch_orders', 'select=*&order=created_at.desc&limit=50', doFetch);
    if (!r.ok) return json(res, 503, { error: 'storage_unavailable' });
    return json(res, 200, { orders: r.rows.map((o) => publicOrder(o, env)) });
  }

  if (action === 'order') {
    const id = String(body.order_id ?? '');
    if (!UUID_RE.test(id)) return json(res, 400, { error: 'bad_request' });
    const r = await userSelect(bearer, 'merch_orders', `id=eq.${id}&select=*`, doFetch);
    let row = r.ok ? r.rows[0] : null;
    if (!row) return json(res, 404, { error: 'not_found' });
    if (row.printify_order_id && ['placed', 'in_production', 'shipped'].includes(row.status) && printifyConfigured(env)) {
      row = await refreshFromPrintify(row, ctx, doFetch);
    }
    return json(res, 200, { order: publicOrder(row, env) });
  }

  if (!printifyConfigured(env)) {
    return json(res, 503, { error: 'merch_not_configured', message: 'The print shop is not connected on this deployment.' });
  }

  if (action === 'cancel') {
    const id = String(body.order_id ?? '');
    if (!UUID_RE.test(id)) return json(res, 400, { error: 'bad_request' });
    const r = await userSelect(bearer, 'merch_orders', `id=eq.${id}&select=*`, doFetch);
    const row = r.ok ? r.rows[0] : null;
    if (!row) return json(res, 404, { error: 'not_found' });
    return cancelOrder(res, { row, env, ctx, doFetch });
  }
  if (action === 'make') return make(req, res, { bearer, user, body, ctx, doFetch });
  if (action === 'mockups') return mockups(res, { bearer, body, ctx, doFetch });
  if (action === 'checkout') return checkout(req, res, { bearer, user, body, env, doFetch });
  return json(res, 400, { error: 'bad_request' });
}

/* ───────────────────────── make ───────────────────────── */

async function make(req, res, { bearer, user, body, ctx, doFetch }) {
  const key = String(body.blueprint_key ?? '');
  const imageUrl = String(body.image_url ?? '');
  const fill = body?.placement?.fill === true;
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(key)) return json(res, 400, { error: 'bad_request', message: 'Which product?' });
  if (!imageUrlIsMine(imageUrl, user.id)) {
    return json(res, 400, { error: 'bad_request', message: 'The picture must be one the bench set out for you.' });
  }

  const rights = await rightsFor(bearer, user, body.source, doFetch);
  if (!rights.ok) return json(res, rights.status, { error: rights.error, message: rights.message });

  const bp = await serviceSelect('merch_blueprints', `key=eq.${key}&enabled=is.true&select=*`, doFetch);
  const blueprint = bp.ok ? bp.rows[0] : null;
  if (!blueprint) return json(res, 404, { error: 'not_found', message: 'That product is not offered.' });

  const title = `${String(body.title ?? rights.title ?? 'Grapheon').trim().slice(0, 120) || 'Grapheon'} — ${blueprint.label}`;
  const scale = fill ? 1 : Number(blueprint.default_scale) || 0.85;

  // The row first, so a failure part-way leaves a record the owner can see.
  const made = await serviceWrite('POST', 'merch_products', '', {
    owner_user_id: user.id,
    // A spotlight is an edition product with no bench item (merch_products
    // knows document and edition only).
    source_kind: body.source.kind === 'spotlight' ? 'edition' : body.source.kind,
    source_id: body.source.id,
    bench_item_id: body.source.bench_item_id ?? null,
    blueprint_key: key,
    title,
    image_url: imageUrl,
    placement: { scale, fill },
    status: 'rendering',
  }, doFetch);
  if (!made.ok) return json(res, 503, { error: 'storage_unavailable', message: made.error });
  const row = made.row;

  const fail = async (status, error, message) => {
    await serviceWrite('PATCH', 'merch_products', `id=eq.${row.id}`, { status: 'failed', error: message }, doFetch);
    return json(res, status, { error, message, product_id: row.id });
  };

  try {
    // Printify's upload takes a file name and a url (not file_url: that
    // shape answers 422 "Validation failed.").
    const fileName = decodeURIComponent(imageUrl.split('?')[0].split('/').pop() || '') || 'picture.png';
    const image = await uploadImageToPrintify({ file_name: fileName, url: imageUrl }, ctx);
    if (!image?.id) return fail(502, 'printify_error', 'Printify did not take the picture.');

    const catalog = await getBlueprintVariants(blueprint.blueprint_id, blueprint.provider_id, ctx);
    const variantIds = catalog.map((v) => v.id);
    if (variantIds.length === 0) return fail(502, 'printify_error', 'Printify offers no variants of that product.');

    // Printify prices on products are cents; the real figure is set once the
    // cost is known (a second, cheap call). 100 is a placeholder, not a sale.
    const product = await createPrintifyProduct({
      title,
      description: `Made in the Grapheon Reader from ${rights.title}.`,
      blueprintId: blueprint.blueprint_id,
      printProviderId: blueprint.provider_id,
      uploadedImageId: image.id,
      position: blueprint.position || 'front',
      scale,
      variants: variantIds.map((id) => ({ id, price: 100, isEnabled: true })),
    }, ctx);
    if (!product?.id) return fail(502, 'printify_error', 'Printify did not make the product.');

    const read = readPrintifyProduct(product);
    try {
      await updateProductPrices(product.id, read.variants.map((v) => ({ id: v.id, price: v.price_cents, isEnabled: v.available })), ctx);
    } catch (err) {
      console.warn(`${LOG} prices not set on ${product.id}: ${err?.message}`);
    }

    const saved = await serviceWrite('PATCH', 'merch_products', `id=eq.${row.id}`, {
      printify_image_id: image.id,
      printify_product_id: product.id,
      options: read.options,
      variants: read.variants,
      mockups: read.mockups,
      status: read.mockups.length > 0 ? 'ready' : 'rendering',
      error: null,
    }, doFetch);
    if (!saved.ok) return json(res, 503, { error: 'storage_unavailable', message: saved.error, product_id: row.id });
    return json(res, 200, { product: publicProduct(saved.row) });
  } catch (err) {
    const msg = err instanceof PrintifyAPIError ? err.message : (err?.message || 'Printify failed.');
    console.error(`${LOG} make failed for ${row.id}: ${msg}`);
    return fail(502, 'printify_error', msg);
  }
}

/* ───────────────────────── mockups ───────────────────────── */

async function mockups(res, { bearer, body, ctx, doFetch }) {
  const id = String(body.product_id ?? '');
  if (!UUID_RE.test(id)) return json(res, 400, { error: 'bad_request' });
  const r = await userSelect(bearer, 'merch_products', `id=eq.${id}&select=*`, doFetch);
  const row = r.ok ? r.rows[0] : null;
  if (!row) return json(res, 404, { error: 'not_found' });
  if (row.status !== 'rendering' || !row.printify_product_id) return json(res, 200, { product: publicProduct(row) });
  try {
    const p = await getPrintifyProduct(row.printify_product_id, ctx);
    const read = readPrintifyProduct(p);
    if (read.mockups.length === 0) return json(res, 200, { product: publicProduct(row) });
    const saved = await serviceWrite('PATCH', 'merch_products', `id=eq.${row.id}`, {
      mockups: read.mockups, options: read.options, variants: read.variants, status: 'ready',
    }, doFetch);
    return json(res, 200, { product: publicProduct(saved.ok ? saved.row : { ...row, mockups: read.mockups, status: 'ready' }) });
  } catch (err) {
    return json(res, 502, { error: 'printify_error', message: err?.message || 'Printify failed.' });
  }
}

/* ───────────────────────── checkout ───────────────────────── */

function originFor(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

async function checkout(req, res, { bearer, user, body, env, doFetch }) {
  const secretKey = grapheonStripeKey(env);
  if (!secretKey) return json(res, 503, { error: 'merch_not_configured', message: 'Payments are not connected on this deployment.' });

  const productId = String(body.product_id ?? '');
  const variantId = Number(body.variant_id);
  const quantity = Math.min(10, Math.max(1, Math.floor(Number(body.quantity) || 1)));
  const returnPath = typeof body.return_path === 'string' && body.return_path.startsWith('/') && !body.return_path.startsWith('//')
    ? body.return_path.split('#')[0]
    : '/';
  if (!UUID_RE.test(productId) || !Number.isInteger(variantId)) return json(res, 400, { error: 'bad_request' });

  // The product, as the user: RLS allows the owner only.
  const pr = await userSelect(bearer, 'merch_products', `id=eq.${productId}&select=*`, doFetch);
  const product = pr.ok ? pr.rows[0] : null;
  if (!product) return json(res, 404, { error: 'not_found' });
  if (!product.printify_product_id || product.status === 'failed') {
    return json(res, 409, { error: 'not_ready', message: 'The product is not ready to buy.' });
  }
  const variant = (product.variants || []).find((v) => Number(v.id) === variantId);
  if (!variant || variant.available === false) return json(res, 400, { error: 'bad_request', message: 'Pick a colour and size that is offered.' });

  const bp = await serviceSelect('merch_blueprints', `key=eq.${product.blueprint_key}&select=*`, doFetch);
  const blueprint = bp.ok ? bp.rows[0] : null;
  if (!blueprint) return json(res, 404, { error: 'not_found', message: 'That product is not offered.' });

  const itemCents = Number(variant.price_cents) * quantity;
  const shippingCents = Number(blueprint.shipping_first_cents) + Number(blueprint.shipping_additional_cents) * (quantity - 1);
  const variantTitle = [variant.color, variant.size, variant.paper].filter(Boolean).join(' / ') || variant.title || String(variantId);

  // The order row first, pending, so the Session can carry its id.
  const made = await serviceWrite('POST', 'merch_orders', '', {
    buyer_user_id: user.id,
    product_id: product.id,
    variant_id: variantId,
    variant_title: variantTitle,
    quantity,
    currency: 'usd',
    item_cents: itemCents,
    shipping_cents: shippingCents,
    tax_cents: 0,
    total_cents: itemCents + shippingCents,
    email: user.email || null,
    status: 'pending',
  }, doFetch);
  if (!made.ok) return json(res, 503, { error: 'storage_unavailable', message: made.error });
  const order = made.row;

  const origin = originFor(req);
  const sep = returnPath.includes('?') ? '&' : '?';
  const mockup = (product.mockups || []).find((m) => (m.variant_ids || []).includes(variantId)) || (product.mockups || [])[0];
  const session = await stripeRequest('/v1/checkout/sessions', {
    secretKey,
    idempotencyKey: `merch-${order.id}`,
    fetchImpl: doFetch,
    body: {
      mode: 'payment',
      client_reference_id: user.id,
      customer_email: user.email || undefined,
      line_items: [{
        quantity,
        price_data: {
          currency: 'usd',
          unit_amount: Number(variant.price_cents),
          product_data: {
            name: `${product.title} — ${variantTitle}`,
            images: mockup?.src ? [mockup.src] : undefined,
          },
        },
      }],
      shipping_address_collection: { allowed_countries: blueprint.countries?.length ? blueprint.countries : ['US'] },
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: shippingCents, currency: 'usd' },
          display_name: 'Standard shipping',
          delivery_estimate: { minimum: { unit: 'business_day', value: 5 }, maximum: { unit: 'business_day', value: 12 } },
        },
      }],
      phone_number_collection: { enabled: true },
      automatic_tax: env.GRAPHEON_STRIPE_TAX === '1' ? { enabled: true } : undefined,
      success_url: `${origin}${returnPath}${sep}merch=paid&order=${order.id}`,
      cancel_url: `${origin}${returnPath}${sep}merch=cancel&order=${order.id}`,
      metadata: { kind: 'merch', order_id: order.id, product_id: product.id, variant_id: String(variantId), quantity: String(quantity), user_id: user.id },
      payment_intent_data: { metadata: { kind: 'merch', order_id: order.id } },
    },
  });
  if (!session.ok || !session.data?.url) {
    await serviceWrite('PATCH', 'merch_orders', `id=eq.${order.id}`, { status: 'failed', error: session.error || 'Stripe refused.' }, doFetch);
    console.error(`${LOG} checkout session failed for ${order.id}: ${session.error}`);
    return json(res, 502, { error: 'stripe_error', message: session.error || 'Could not start checkout.' });
  }
  await serviceWrite('PATCH', 'merch_orders', `id=eq.${order.id}`, { stripe_session_id: session.data.id }, doFetch);
  return json(res, 200, { url: session.data.url, order_id: order.id });
}

/* ───────────────────────── order status ───────────────────────── */

export function statusFromPrintify(o) {
  const s = String(o?.status || '').toLowerCase();
  if (o?.shipments?.length || s === 'shipped' || s === 'fulfilled' || s === 'delivered') return s === 'delivered' ? 'delivered' : 'shipped';
  if (s === 'canceled' || s === 'cancelled') return 'canceled';
  if (s === 'in-production' || s === 'in_production' || o?.sent_to_production_at) return 'in_production';
  if (s === 'on-hold' || s === 'pending' || s === 'payment-not-received' || s === 'callback-received') return 'placed';
  return null;
}

async function refreshFromPrintify(row, ctx, doFetch) {
  try {
    const o = await getOrderStatus(row.printify_order_id, ctx);
    const status = statusFromPrintify(o);
    const tracking = (o?.shipments || []).map((s) => ({ carrier: s.carrier, number: s.number, url: s.url, delivered_at: s.delivered_at || null }));
    const patch = { tracking };
    // Never backward: between the sweep's claim and Printify's answer the shop
    // still says on-hold, and a read then must not undo the claim.
    const settled = row.status === 'in_production' || row.status === 'shipped' || row.status === 'delivered';
    if (status && status !== row.status && !(status === 'placed' && settled)) patch.status = status;
    if (status === 'shipped' && !row.shipped_at) patch.shipped_at = new Date().toISOString();
    if (o?.sent_to_production_at && !row.sent_to_production_at) patch.sent_to_production_at = o.sent_to_production_at;
    const saved = await serviceWrite('PATCH', 'merch_orders', `id=eq.${row.id}`, patch, doFetch);
    return saved.ok && saved.row ? saved.row : { ...row, ...patch };
  } catch (err) {
    console.warn(`${LOG} order refresh failed for ${row.id}: ${err?.message}`);
    return row;
  }
}

/* ───────────────────────── cancel ───────────────────────── */

// A held order is the buyer's to cancel until the sweep (api/merch-release)
// or MERCH_SEND_TO_PRODUCTION=1 has sent it to production. The conditional
// claim placed → canceled is what keeps a cancel and a release from both
// winning. The refund goes back through Grapheon's Stripe account, in full;
// Stripe's charge.refunded then reaches the webhook, which already records it.
async function cancelOrder(res, { row, env, ctx, doFetch }) {
  const tooLate = (order) => json(res, 409, { error: 'too_late', message: 'The printer has already started on it; it cannot be cancelled now.', order: publicOrder(order, env) });
  if (row.status === 'canceled' || row.status === 'refunded') return json(res, 200, { order: publicOrder(row, env) });
  if (row.status === 'pending' || row.status === 'failed') return json(res, 409, { error: 'not_cancellable', message: 'Nothing was charged for this order.' });
  if (row.status === 'paid') return json(res, 409, { error: 'not_cancellable', message: 'It is being placed with the printer; try again in a moment.' });
  if (row.status !== 'placed' || !row.printify_order_id) return tooLate(row);

  const claim = await serviceWrite('PATCH', 'merch_orders', `id=eq.${row.id}&status=eq.placed`, { status: 'canceled', error: null }, doFetch);
  if (!claim.ok) return json(res, 503, { error: 'storage_unavailable', message: claim.error });
  if (!claim.row) return tooLate(row);

  try {
    await cancelPrintifyOrder(row.printify_order_id, ctx);
  } catch (err) {
    // Printify would not let go: it has moved on. Put the record back and let the refresh say where it stands.
    const back = await serviceWrite('PATCH', 'merch_orders', `id=eq.${row.id}`, { status: 'placed', error: `not cancelled: ${err?.message || 'Printify refused'}` }, doFetch);
    const cur = back.ok && back.row ? await refreshFromPrintify(back.row, ctx, doFetch) : row;
    return tooLate(cur);
  }

  let patch = { status: 'canceled', error: 'refund pending' };
  if (row.stripe_payment_intent && env.GRAPHEON_STRIPE_SECRET_KEY) {
    const refund = await stripeRequest('/v1/refunds', {
      secretKey: env.GRAPHEON_STRIPE_SECRET_KEY,
      idempotencyKey: `merch-refund-${row.id}`,
      fetchImpl: doFetch,
      body: { payment_intent: row.stripe_payment_intent, metadata: { kind: 'merch', order_id: row.id } },
    });
    if (refund.ok) patch = { status: 'refunded', error: null };
    else {
      patch.error = `refund failed: ${refund.error || 'Stripe refused'}`;
      console.error(`${LOG} refund failed for ${row.id}: ${refund.error}`);
    }
  }
  const saved = await serviceWrite('PATCH', 'merch_orders', `id=eq.${row.id}`, patch, doFetch);
  return json(res, 200, { order: publicOrder(saved.ok && saved.row ? saved.row : { ...row, ...patch }, env) });
}
