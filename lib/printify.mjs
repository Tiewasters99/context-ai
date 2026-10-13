// lib/printify.mjs — the Printify REST client (Grapheon Reader, Phase 2b).
//
// Ported near-verbatim from grapheon-ai/lib/printify.ts (Amin's wrapper:
// plain fetch, typed errors, a retry on 429), with two changes: it is ESM
// with no Next, and it reads its token and shop from a config getter so a
// harness can stub them and a deployment without them is dormant. The
// shop is a `custom_integration` channel, so there is no publish step:
// products are made by API and orders are placed by API.
//
// Env: PRINTIFY_API_TOKEN (printify.com → Account → Connections),
//      PRINTIFY_SHOP_ID ("Reading Wizard", 25109380 — D10).

export const PRINTIFY_API = 'https://api.printify.com/v1';
const USER_AGENT = 'Grapheon/0.2.0';

export function printifyConfig(env = process.env) {
  return { token: env.PRINTIFY_API_TOKEN || '', shopId: env.PRINTIFY_SHOP_ID || '' };
}

export function printifyConfigured(env = process.env) {
  const c = printifyConfig(env);
  return Boolean(c.token && c.shopId);
}

export class PrintifyAPIError extends Error {
  constructor(status, message, response) {
    super(message);
    this.name = 'PrintifyAPIError';
    this.status = status;
    this.response = response;
  }
}

const ERROR_MESSAGES = {
  401: 'Printify refused the token (PRINTIFY_API_TOKEN).',
  403: 'Printify refused: the token lacks that scope.',
  404: 'Printify has no such thing.',
  422: 'Printify rejected the request as malformed.',
  429: 'Printify rate limit; retry after a pause.',
  500: 'Printify server error; try again later.',
};

/**
 * One Printify call. `opts.fetchImpl` and `opts.env` exist for the harness.
 * Throws PrintifyAPIError; never returns a non-2xx silently.
 */
export async function printifyRequest(endpoint, options = {}, { fetchImpl = null, env = process.env, timeoutMs = 20_000 } = {}) {
  const { token, shopId } = printifyConfig(env);
  if (!token) throw new PrintifyAPIError(401, 'PRINTIFY_API_TOKEN is not set on this deployment.');
  if (!shopId && !endpoint.includes('/catalog/') && !endpoint.startsWith('/shops.json')) {
    throw new PrintifyAPIError(401, 'PRINTIFY_SHOP_ID is not set on this deployment.');
  }
  const doFetch = fetchImpl || globalThis.fetch;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    ...(options.headers || {}),
  };
  let response;
  try {
    response = await doFetch(`${PRINTIFY_API}${endpoint}`, { ...options, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new PrintifyAPIError(500, err?.message || 'Printify could not be reached.', err);
  }
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message = errorData?.message || ERROR_MESSAGES[response.status] || `Printify answered ${response.status}.`;
    throw new PrintifyAPIError(response.status, message, errorData);
  }
  const text = await response.text().catch(() => '');
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function withRetry(endpoint, options, ctx, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await printifyRequest(endpoint, options, ctx);
    } catch (error) {
      if (error instanceof PrintifyAPIError && error.status === 429 && i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, i) * 1000));
        continue;
      }
      throw error;
    }
  }
  throw new PrintifyAPIError(429, 'Printify rate limit; retries exhausted.');
}

const shop = (ctx) => printifyConfig(ctx?.env || process.env).shopId;

/* ───────────────────────── Catalog ───────────────────────── */

export function getShops(ctx) {
  return printifyRequest('/shops.json', { method: 'GET' }, ctx);
}

export function getBlueprintDetails(blueprintId, ctx) {
  return printifyRequest(`/catalog/blueprints/${blueprintId}.json`, { method: 'GET' }, ctx);
}

export function getPrintProviders(blueprintId, ctx) {
  return printifyRequest(`/catalog/blueprints/${blueprintId}/print_providers.json`, { method: 'GET' }, ctx);
}

/** The variants a provider offers for a blueprint. Printify wraps the array
 *  in { id, title, variants } here; sibling endpoints return arrays. */
export async function getBlueprintVariants(blueprintId, printProviderId, ctx) {
  const raw = await printifyRequest(
    `/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`,
    { method: 'GET' },
    ctx,
  );
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.variants)) return raw.variants;
  return [];
}

/** Shipping profiles (first item / additional item, per country group). */
export function getBlueprintShipping(blueprintId, printProviderId, ctx) {
  return printifyRequest(
    `/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/shipping.json`,
    { method: 'GET' },
    ctx,
  );
}

/* ───────────────────────── Images and products ───────────────────────── */

/** `{ file_url }` or `{ contents (base64), file_name }`. */
export function uploadImageToPrintify(imageData, ctx) {
  return withRetry('/uploads/images.json', { method: 'POST', body: JSON.stringify(imageData) }, ctx);
}

/**
 * Make a product in the shop. `variants` are { id, price (cents), isEnabled };
 * `printAreas` default to one front placeholder with the image centred at
 * `scale` of the print area.
 */
export function createPrintifyProduct(cfg, ctx) {
  const printAreas = cfg.printAreas?.map((pa) => ({ variant_ids: pa.variantIds, placeholders: pa.placeholders })) || [{
    variant_ids: cfg.variants.map((v) => v.id),
    placeholders: [{
      position: cfg.position || 'front',
      images: [{ id: cfg.uploadedImageId, x: 0.5, y: 0.5, scale: cfg.scale ?? 1, angle: 0 }],
    }],
  }];
  const payload = {
    title: cfg.title,
    description: cfg.description || '',
    blueprint_id: cfg.blueprintId,
    print_provider_id: cfg.printProviderId,
    variants: cfg.variants.map((v) => ({ id: v.id, price: v.price, is_enabled: v.isEnabled })),
    print_areas: printAreas,
  };
  return withRetry(`/shops/${shop(ctx)}/products.json`, { method: 'POST', body: JSON.stringify(payload) }, ctx);
}

/** Set the retail prices on an existing product (the shop's own record). */
export function updateProductPrices(productId, variants, ctx) {
  return printifyRequest(
    `/shops/${shop(ctx)}/products/${productId}.json`,
    { method: 'PUT', body: JSON.stringify({ variants: variants.map((v) => ({ id: v.id, price: v.price, is_enabled: v.isEnabled ?? true })) }) },
    ctx,
  );
}

export function getPrintifyProduct(productId, ctx) {
  return printifyRequest(`/shops/${shop(ctx)}/products/${productId}.json`, { method: 'GET' }, ctx);
}

export function deletePrintifyProduct(productId, ctx) {
  return printifyRequest(`/shops/${shop(ctx)}/products/${productId}.json`, { method: 'DELETE' }, ctx);
}

/* ───────────────────────── Orders ───────────────────────── */

/** A shipping quote for an address (needs product and variant ids). */
export function calculateShippingCost({ lineItems, addressTo }, ctx) {
  const payload = {
    line_items: lineItems.map((item) => ({ product_id: item.productId, variant_id: item.variantId, quantity: item.quantity })),
    address_to: addressTo,
  };
  return printifyRequest(`/shops/${shop(ctx)}/orders/shipping.json`, { method: 'POST', body: JSON.stringify(payload) }, ctx);
}

/**
 * Place an order. It waits on hold in the shop until sendOrderToProduction;
 * on hold it can be cancelled without a print being made.
 */
export function createPrintifyOrder(order, ctx) {
  const a = order.shippingAddress;
  const payload = {
    external_id: order.externalId,
    label: order.label || order.customerEmail,
    line_items: order.lineItems.map((item) => ({ product_id: item.productId, variant_id: item.variantId, quantity: item.quantity })),
    shipping_method: order.shippingMethod || 1,
    send_shipping_notification: order.sendShippingNotification ?? true,
    address_to: {
      first_name: a.firstName,
      last_name: a.lastName,
      email: order.customerEmail,
      phone: a.phone || '',
      country: a.country,
      region: a.state || '',
      address1: a.address1,
      address2: a.address2 || '',
      city: a.city,
      zip: a.zipCode,
    },
  };
  return withRetry(`/shops/${shop(ctx)}/orders.json`, { method: 'POST', body: JSON.stringify(payload) }, ctx);
}

export function getOrderStatus(orderId, ctx) {
  return printifyRequest(`/shops/${shop(ctx)}/orders/${orderId}.json`, { method: 'GET' }, ctx);
}

export function sendOrderToProduction(orderId, ctx) {
  return printifyRequest(`/shops/${shop(ctx)}/orders/${orderId}/send_to_production.json`, { method: 'POST', body: '{}' }, ctx);
}

export function cancelPrintifyOrder(orderId, ctx) {
  return printifyRequest(`/shops/${shop(ctx)}/orders/${orderId}/cancel.json`, { method: 'POST', body: '{}' }, ctx);
}

export function listOrders(page = 1, limit = 20, ctx) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  return printifyRequest(`/shops/${shop(ctx)}/orders.json?${params}`, { method: 'GET' }, ctx);
}
