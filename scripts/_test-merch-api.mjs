// api/merch.mjs and api/grapheon-webhook.mjs — a picture from the bench on a
// tee, a tote, a print (Grapheon Reader Phase 2b, migration 117). Driven
// here with no network: `fetchImpl` plays Supabase Auth and PostgREST (with
// an in-memory merch_products / merch_orders), Printify and Stripe, and
// records every call.
//
//   node --test scripts/_test-merch-api.mjs
//
// What is held: the bearer is checked first; the rights gate in `make`
// refuses a book outside the Library serverspace, a still someone else
// brought in, an in-copyright edition's plate, and a picture not under the
// caller's own prints folder — all before Printify is asked anything; a
// good make uploads by file_url, makes the product at the blueprint's
// scale, prices every variant at cost + 40% to .99 (D9) and sets those
// prices on the product; `mockups` turns the row ready once Printify has
// drawn them; `checkout` writes a pending order and opens a Stripe Session
// with US shipping, one flat shipping line, no automatic tax by default and
// the order id in its metadata; the webhook refuses a bad signature, places
// the Printify order once (a replayed event places nothing), reads the
// address from the re-fetched Session, sends to production only when
// MERCH_SEND_TO_PRODUCTION=1, and releases its claim on a Printify failure
// so the retry can place the order.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

const { default: merch, priceCents, imageUrlIsMine, readPrintifyProduct } = await import('../api/merch.mjs');
const { default: webhook, addressFromSession } = await import('../api/grapheon-webhook.mjs');

const READER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = 'ffffffff-0000-4111-8222-333333333333';
const TOKENS = { 'tok-reader': READER, 'tok-other': OTHER };
const LIB_DOC = '11111111-2222-4333-8444-555555555551';
const MATTER_DOC = '11111111-2222-4333-8444-555555555552';
const LIB_MATTER = '22222222-2222-4333-8444-555555555551';
const CASE_MATTER = '22222222-2222-4333-8444-555555555552';
const LIB_SS = '33333333-2222-4333-8444-555555555551';
const CASE_SS = '33333333-2222-4333-8444-555555555552';
const SNIP = '44444444-2222-4333-8444-555555555551';
const SNIP_MATTER = '44444444-2222-4333-8444-555555555552';
const STILL_OTHERS = '44444444-2222-4333-8444-555555555553';
const SNIPPET = '44444444-2222-4333-8444-555555555554';
const EDITION_PD = '55555555-2222-4333-8444-555555555551';
const EDITION_OWN = '55555555-2222-4333-8444-555555555552';
const ESNIP_PD = '66666666-2222-4333-8444-555555555551';
const ESNIP_OWN = '66666666-2222-4333-8444-555555555552';
const MY_IMAGE = `https://example.supabase.co/storage/v1/object/public/cover-images/${READER}/prints/${SNIP}-1791898333315.jpg`;

const ENV = {
  PRINTIFY_API_TOKEN: 'printify-token',
  PRINTIFY_SHOP_ID: '25109380',
  GRAPHEON_STRIPE_SECRET_KEY: 'sk_test_grapheon',
  GRAPHEON_STRIPE_WEBHOOK_SECRET: 'whsec_grapheon',
};

/** A tiny PostgREST: eq / is / lt filters and or=(…), POST, PATCH, GET. */
function makeStore() {
  const tables = { merch_products: [], merch_orders: [] };
  let n = 0;
  const newId = () => `77777777-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const test1 = (row, key, op, val) => {
    const v = row[key];
    if (op === 'eq') return String(v) === val;
    if (op === 'is') return val === 'null' ? v == null : val === 'true' ? v === true : v === false;
    if (op === 'lt') return v != null && String(v) < val;
    throw new Error(`unknown op ${op}`);
  };
  const matches = (row, params) => {
    for (const [key, raw] of params) {
      if (['select', 'order', 'limit'].includes(key)) continue;
      if (key === 'or') {
        const inner = raw.replace(/^\(|\)$/g, '').split(',');
        const any = inner.some((clause) => { const [k, op, ...rest] = clause.split('.'); return test1(row, k, op, rest.join('.')); });
        if (!any) return false;
        continue;
      }
      const [op, ...rest] = raw.split('.');
      if (!test1(row, key, op, rest.join('.'))) return false;
    }
    return true;
  };
  return {
    tables,
    handle(table, method, params, body) {
      const rows = tables[table];
      if (method === 'POST') {
        const row = { id: newId(), created_at: new Date().toISOString(), tracking: [], mockups: [], options: [], variants: [], placing_at: null, printify_order_id: null, stripe_session_id: null, ...body };
        rows.push(row);
        return [row];
      }
      const hit = rows.filter((r) => matches(r, params));
      if (method === 'PATCH') { for (const r of hit) Object.assign(r, body); return hit; }
      return hit;
    },
  };
}

function fakeWorld({ printifyImages = [], failOrder = false } = {}) {
  const calls = [];
  const store = makeStore();
  let printifyOrders = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const auth = String(init.headers?.authorization ?? init.headers?.Authorization ?? '');
    const apikey = String(init.headers?.apikey ?? '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body.startsWith('{') || init.body.startsWith('[') ? init.body : '{}') : null;
    calls.push({ host: u.host, path: u.pathname, search: u.search, method, auth, apikey, body, form: init.body && !init.body.startsWith('{') ? new URLSearchParams(init.body) : null });
    const respond = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    const asUser = () => { const tok = auth.replace(/^Bearer /, ''); return apikey === 'anon-key' ? TOKENS[tok] ?? null : null; };
    const isService = auth === 'Bearer service-key' && apikey === 'service-key';

    if (u.host === 'example.supabase.co') {
      if (u.pathname === '/auth/v1/user') {
        const id = TOKENS[auth.replace(/^Bearer /, '')];
        return id ? respond(200, { id, email: `${id.slice(0, 4)}@example.test` }) : respond(401, { message: 'bad token' });
      }
      const table = u.pathname.replace('/rest/v1/', '');
      const p = u.searchParams;
      const eq = (k) => p.get(k)?.replace(/^eq\./, '');
      if (table === 'rpc/_edition_can_read') {
        if (!asUser()) return respond(401, { message: 'not as the user' });
        return respond(200, [EDITION_PD, EDITION_OWN].includes(body.p_edition));
      }
      if (table === 'document_workshop_items') {
        if (!asUser()) return respond(401, { message: 'not as the user' });
        const items = {
          [SNIP]: { id: SNIP, kind: 'snip', user_id: READER, media_document_id: null, document_id: LIB_DOC },
          [SNIP_MATTER]: { id: SNIP_MATTER, kind: 'snip', user_id: READER, media_document_id: null, document_id: MATTER_DOC },
          [STILL_OTHERS]: { id: STILL_OTHERS, kind: 'media', user_id: OTHER, media_document_id: LIB_DOC, document_id: LIB_DOC },
          [SNIPPET]: { id: SNIPPET, kind: 'snippet', user_id: READER, media_document_id: null, document_id: LIB_DOC },
        };
        const it = items[eq('id')];
        return respond(200, it && it.document_id === eq('document_id') ? [it] : []);
      }
      if (table === 'documents') {
        if (!asUser()) return respond(401, {});
        const docs = { [LIB_DOC]: { id: LIB_DOC, title: 'Through the Russian Revolution', matterspace_id: LIB_MATTER }, [MATTER_DOC]: { id: MATTER_DOC, title: 'Exhibit 4', matterspace_id: CASE_MATTER } };
        return respond(200, docs[eq('id')] ? [docs[eq('id')]] : []);
      }
      if (table === 'matterspaces') {
        if (!asUser()) return respond(401, {});
        const ms = { [LIB_MATTER]: { id: LIB_MATTER, serverspace_id: LIB_SS }, [CASE_MATTER]: { id: CASE_MATTER, serverspace_id: CASE_SS } };
        return respond(200, ms[eq('id')] ? [ms[eq('id')]] : []);
      }
      if (table === 'serverspaces') {
        if (!asUser()) return respond(401, {});
        const ss = { [LIB_SS]: { id: LIB_SS, name: 'Library' }, [CASE_SS]: { id: CASE_SS, name: 'Quainton Law' } };
        return respond(200, ss[eq('id')] ? [ss[eq('id')]] : []);
      }
      if (table === 'edition_bench_items') {
        if (!asUser()) return respond(401, {});
        const items = { [ESNIP_PD]: { id: ESNIP_PD, kind: 'snip', user_id: READER, edition_id: EDITION_PD }, [ESNIP_OWN]: { id: ESNIP_OWN, kind: 'snip', user_id: READER, edition_id: EDITION_OWN } };
        const it = items[eq('id')];
        return respond(200, it && it.edition_id === eq('edition_id') ? [it] : []);
      }
      if (table === 'editions') {
        if (!asUser()) return respond(401, {});
        const eds = { [EDITION_PD]: { id: EDITION_PD, title: 'Innocents Abroad', rights: 'public_domain', merch_allowed: false }, [EDITION_OWN]: { id: EDITION_OWN, title: 'My Illustrated Novel', rights: 'own', merch_allowed: false } };
        return respond(200, eds[eq('id')] ? [eds[eq('id')]] : []);
      }
      if (table === 'merch_blueprints') {
        if (!isService) return respond(401, { message: 'service only' });
        const rows = [{ key: 'tee', kind: 'tee', label: 'Unisex cotton tee', blueprint_id: 5, provider_id: 99, position: 'front', default_scale: '0.850', estimate_cents: 2799, shipping_first_cents: 495, shipping_additional_cents: 240, countries: ['US'], enabled: true, sort_order: 1 }];
        const k = eq('key');
        return respond(200, k ? rows.filter((r) => r.key === k) : rows);
      }
      if (table === 'merch_products' || table === 'merch_orders') {
        if (method === 'GET') {
          const uid = asUser();
          if (uid) {
            const own = table === 'merch_products' ? 'owner_user_id' : 'buyer_user_id';
            return respond(200, store.handle(table, 'GET', p, null).filter((r) => r[own] === uid));
          }
          if (!isService) return respond(401, {});
          return respond(200, store.handle(table, 'GET', p, null));
        }
        if (!isService) return respond(401, { message: 'service only' });
        return respond(method === 'POST' ? 201 : 200, store.handle(table, method, p, body));
      }
      return respond(404, { message: `no fixture for ${u.pathname}` });
    }

    if (u.host === 'api.printify.com') {
      if (auth !== 'Bearer printify-token') return respond(401, { message: 'bad token' });
      if (u.pathname === '/v1/uploads/images.json') return respond(200, { id: 'img-1', file_name: 'plate.jpg', width: 3600, height: 2400 });
      if (u.pathname === '/v1/catalog/blueprints/5/print_providers/99/variants.json') {
        return respond(200, { id: 5, title: 'tee', variants: [{ id: 17390, title: 'Heather Grey / XS', options: { color: 'Heather Grey', size: 'XS' } }, { id: 17393, title: 'Heather Grey / L', options: { color: 'Heather Grey', size: 'L' } }] });
      }
      const product = {
        id: 'prod-1', title: 'x', blueprint_id: 5, print_provider_id: 99,
        options: [
          { name: 'Colors', type: 'color', values: [{ id: 831, title: 'Heather Grey', colors: ['#a4a4a3'] }] },
          { name: 'Sizes', type: 'size', values: [{ id: 13, title: 'XS' }, { id: 16, title: 'L' }] },
        ],
        variants: [
          { id: 17390, title: 'Heather Grey / XS', cost: 1989, price: 100, options: [831, 13], is_available: true, is_enabled: true },
          { id: 17393, title: 'Heather Grey / L', cost: 2001, price: 100, options: [831, 16], is_available: true, is_enabled: true },
        ],
        images: printifyImages,
      };
      if (u.pathname === '/v1/shops/25109380/products.json' && method === 'POST') return respond(200, product);
      if (u.pathname === '/v1/shops/25109380/products/prod-1.json') return respond(200, { ...product, images: [{ src: 'https://images.printify.com/mock-1', variant_ids: [17390, 17393], position: 'front', is_default: true }] });
      if (u.pathname === '/v1/shops/25109380/orders.json' && method === 'POST') {
        if (failOrder) return respond(500, { message: 'Printify fell over' });
        printifyOrders += 1;
        return respond(200, { id: `po-${printifyOrders}`, status: 'on-hold' });
      }
      if (/^\/v1\/shops\/25109380\/orders\/po-\d+\/send_to_production\.json$/.test(u.pathname)) return respond(200, { id: 'po-1', status: 'in-production' });
      return respond(404, { message: `no printify fixture for ${u.pathname}` });
    }

    if (u.host === 'api.stripe.com') {
      if (auth !== 'Bearer sk_test_grapheon') return respond(401, { error: { message: 'wrong account key' } });
      if (u.pathname === '/v1/checkout/sessions' && method === 'POST') return respond(200, { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
      if (u.pathname === '/v1/checkout/sessions/cs_test_1' && method === 'GET') {
        return respond(200, {
          id: 'cs_test_1', payment_status: 'paid', amount_total: 3294,
          customer_details: { email: 'reader@example.test', phone: '+12125551212', name: 'Eden Reader' },
          shipping_details: { name: 'Eden Reader', address: { line1: '1 Main St', line2: '', city: 'Princeton', state: 'NJ', postal_code: '08540', country: 'US' } },
          total_details: { amount_tax: 0, amount_shipping: 495 },
        });
      }
      return respond(404, { error: { message: `no stripe fixture for ${u.pathname}` } });
    }
    return respond(500, { message: `unexpected host ${u.host}` });
  };
  return { calls, store, fetchImpl, printify: () => calls.filter((c) => c.host === 'api.printify.com'), stripe: () => calls.filter((c) => c.host === 'api.stripe.com') };
}

function response() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (b) => { res.body = b ?? ''; return res; };
  res.json = () => JSON.parse(res.body || 'null');
  return res;
}

async function post(world, token, body, env = ENV) {
  const req = { method: 'POST', headers: { authorization: token ? `Bearer ${token}` : '', host: 'www.contextspaces.ai', 'x-forwarded-proto': 'https' }, body };
  const res = response();
  await merch(req, res, { fetchImpl: world.fetchImpl, env });
  return res;
}

const DOC_SOURCE = { kind: 'document', id: LIB_DOC, bench_item_id: SNIP };

test('pure: price to .99 above cost + 40%, and only my own prints folder is a picture', () => {
  assert.equal(priceCents(1989), 2799);
  assert.equal(priceCents(1000), 1499);
  assert.equal(priceCents(0), 99);
  assert.equal(imageUrlIsMine(MY_IMAGE, READER), true);
  assert.equal(imageUrlIsMine(MY_IMAGE, OTHER), false);
  assert.equal(imageUrlIsMine('https://evil.example/plate.jpg', READER), false);
  assert.equal(imageUrlIsMine(`https://example.supabase.co/storage/v1/object/public/cover-images/${READER}/prints/../x.jpg`, READER), false);
});

test('pure: a Printify product is read into options with hex, priced variants and mockups', () => {
  const r = readPrintifyProduct({
    options: [{ name: 'Colors', type: 'color', values: [{ id: 1, title: 'Solid Black', colors: ['#050505'] }] }, { name: 'Sizes', type: 'size', values: [{ id: 2, title: 'L' }] }],
    variants: [{ id: 9, title: 'Solid Black / L', cost: 1200, options: [1, 2], is_available: true }],
    images: [{ src: 'u', variant_ids: [9], position: 'front', is_default: true }],
  });
  assert.deepEqual(r.variants[0], { id: 9, title: 'Solid Black / L', color: 'Solid Black', color_hex: '#050505', size: 'L', paper: null, cost_cents: 1200, price_cents: 1699, available: true });
  assert.equal(r.mockups.length, 1);
});

test('no bearer is a 401 before anything is asked; a bad action is a 400', async () => {
  const w = fakeWorld();
  const r = await post(w, null, { action: 'products' });
  assert.equal(r.statusCode, 401);
  assert.equal(w.calls.length, 0);
  const r2 = await post(w, 'tok-reader', { action: 'nonsense' });
  assert.equal(r2.statusCode, 400);
});

test('products lists the enabled blueprints and says whether the shop is connected', async () => {
  const w = fakeWorld();
  const r = await post(w, 'tok-reader', { action: 'products' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().products[0].key, 'tee');
  assert.equal(r.json().configured, true);
  const r2 = await post(w, 'tok-reader', { action: 'products' }, { ...ENV, PRINTIFY_API_TOKEN: '' });
  assert.equal(r2.json().configured, false);
});

test('make refuses, before Printify is asked: a picture not under my prints folder; a book outside the Library; another reader’s still; a snippet; an in-copyright edition’s plate', async () => {
  const w = fakeWorld();
  const foreign = await post(w, 'tok-reader', { action: 'make', blueprint_key: 'tee', image_url: 'https://evil.example/plate.jpg', source: DOC_SOURCE });
  assert.equal(foreign.statusCode, 400);
  const matter = await post(w, 'tok-reader', { action: 'make', blueprint_key: 'tee', image_url: MY_IMAGE, source: { kind: 'document', id: MATTER_DOC, bench_item_id: SNIP_MATTER } });
  assert.equal(matter.statusCode, 403);
  assert.match(matter.json().message, /Library/);
  const still = await post(w, 'tok-reader', { action: 'make', blueprint_key: 'tee', image_url: MY_IMAGE, source: { kind: 'document', id: LIB_DOC, bench_item_id: STILL_OTHERS } });
  assert.equal(still.statusCode, 403);
  const words = await post(w, 'tok-reader', { action: 'make', blueprint_key: 'tee', image_url: MY_IMAGE, source: { kind: 'document', id: LIB_DOC, bench_item_id: SNIPPET } });
  assert.equal(words.statusCode, 400);
  const own = await post(w, 'tok-reader', { action: 'make', blueprint_key: 'tee', image_url: MY_IMAGE, source: { kind: 'edition', id: EDITION_OWN, bench_item_id: ESNIP_OWN } });
  assert.equal(own.statusCode, 403);
  assert.match(own.json().message, /copyright/);
  assert.equal(w.printify().length, 0, 'Printify was never asked');
  assert.equal(w.store.tables.merch_products.length, 0, 'no row was written');
  // The rights questions were asked AS THE USER, never with the service key.
  for (const c of w.calls.filter((c) => /document_workshop_items|documents|matterspaces|serverspaces|editions|edition_bench_items|_edition_can_read/.test(c.path))) {
    assert.equal(c.apikey, 'anon-key', c.path);
  }
});

test('make: a Library plate goes up by file_url, the product is made at the blueprint’s scale, every variant is priced at cost + 40% to .99 and those prices are set on the product', async () => {
  const w = fakeWorld();
  const r = await post(w, 'tok-reader', { action: 'make', blueprint_key: 'tee', image_url: MY_IMAGE, source: DOC_SOURCE, title: 'Through the Russian Revolution' });
  assert.equal(r.statusCode, 200, r.body);
  const p = r.json().product;
  assert.equal(p.status, 'rendering', 'no mockups yet');
  assert.equal(p.title, 'Through the Russian Revolution — Unisex cotton tee');
  assert.deepEqual(p.variants.map((v) => [v.id, v.cost_cents, v.price_cents, v.color_hex]), [[17390, 1989, 2799, '#a4a4a3'], [17393, 2001, 2899, '#a4a4a3']]);
  const up = w.printify().find((c) => c.path === '/v1/uploads/images.json');
  assert.deepEqual(up.body, { file_url: MY_IMAGE });
  const made = w.printify().find((c) => c.path === '/v1/shops/25109380/products.json' && c.method === 'POST');
  assert.equal(made.body.print_areas[0].placeholders[0].images[0].scale, 0.85);
  assert.equal(made.body.print_areas[0].placeholders[0].position, 'front');
  assert.deepEqual(made.body.print_areas[0].variant_ids, [17390, 17393]);
  const priced = w.printify().find((c) => c.path === '/v1/shops/25109380/products/prod-1.json' && c.method === 'PUT');
  assert.deepEqual(priced.body.variants.map((v) => [v.id, v.price]), [[17390, 2799], [17393, 2899]]);
  const row = w.store.tables.merch_products[0];
  assert.equal(row.printify_product_id, 'prod-1');
  assert.equal(row.owner_user_id, READER);
  assert.equal(row.source_kind, 'document');

  // fill: true sends the picture at scale 1.
  const r2 = await post(w, 'tok-reader', { action: 'make', blueprint_key: 'tee', image_url: MY_IMAGE, source: { kind: 'edition', id: EDITION_PD, bench_item_id: ESNIP_PD }, placement: { fill: true } });
  assert.equal(r2.statusCode, 200, r2.body);
  const made2 = w.printify().filter((c) => c.path === '/v1/shops/25109380/products.json' && c.method === 'POST')[1];
  assert.equal(made2.body.print_areas[0].placeholders[0].images[0].scale, 1);

  // mockups: once Printify has drawn them the row is ready; another reader cannot poll my product.
  const m = await post(w, 'tok-reader', { action: 'mockups', product_id: p.id });
  assert.equal(m.statusCode, 200);
  assert.equal(m.json().product.status, 'ready');
  assert.equal(m.json().product.mockups[0].src, 'https://images.printify.com/mock-1');
  const m2 = await post(w, 'tok-other', { action: 'mockups', product_id: p.id });
  assert.equal(m2.statusCode, 404);
});

test('without the Printify token, make is a 503 and nothing is written', async () => {
  const w = fakeWorld();
  const r = await post(w, 'tok-reader', { action: 'make', blueprint_key: 'tee', image_url: MY_IMAGE, source: DOC_SOURCE }, { ...ENV, PRINTIFY_API_TOKEN: '' });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().error, 'merch_not_configured');
  assert.equal(w.store.tables.merch_products.length, 0);
});

async function makeReadyProduct(w) {
  const r = await post(w, 'tok-reader', { action: 'make', blueprint_key: 'tee', image_url: MY_IMAGE, source: DOC_SOURCE, title: 'Through the Russian Revolution' });
  assert.equal(r.statusCode, 200, r.body);
  await post(w, 'tok-reader', { action: 'mockups', product_id: r.json().product.id });
  return r.json().product;
}

test('checkout: a pending order, then a Stripe Session in Grapheon’s account with US shipping, one flat shipping line, no automatic tax by default, the order id in metadata and in the return URLs', async () => {
  const w = fakeWorld();
  const p = await makeReadyProduct(w);
  const r = await post(w, 'tok-reader', { action: 'checkout', product_id: p.id, variant_id: 17393, quantity: 2, return_path: '/app/doc/abc?x=1' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  const order = w.store.tables.merch_orders[0];
  assert.equal(order.status, 'pending');
  assert.equal(order.item_cents, 2899 * 2);
  assert.equal(order.shipping_cents, 495 + 240);
  assert.equal(order.total_cents, 2899 * 2 + 495 + 240);
  assert.equal(order.stripe_session_id, 'cs_test_1');
  const s = w.stripe().find((c) => c.path === '/v1/checkout/sessions');
  const f = s.form;
  assert.equal(f.get('mode'), 'payment');
  assert.equal(f.get('line_items[0][price_data][unit_amount]'), '2899');
  assert.equal(f.get('line_items[0][quantity]'), '2');
  assert.equal(f.get('line_items[0][price_data][product_data][images][0]'), 'https://images.printify.com/mock-1');
  assert.equal(f.get('shipping_address_collection[allowed_countries][0]'), 'US');
  assert.equal(f.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]'), '735');
  assert.equal(f.get('phone_number_collection[enabled]'), 'true');
  assert.equal(f.get('automatic_tax[enabled]'), null, 'tax is off until Stripe Tax is turned on');
  assert.equal(f.get('metadata[kind]'), 'merch');
  assert.equal(f.get('metadata[order_id]'), order.id);
  assert.equal(f.get('success_url'), `https://www.contextspaces.ai/app/doc/abc?x=1&merch=paid&order=${order.id}`);
  assert.equal(f.get('cancel_url'), `https://www.contextspaces.ai/app/doc/abc?x=1&merch=cancel&order=${order.id}`);

  // With the flag, tax is on; a variant not offered is refused; another reader cannot buy my product.
  const r2 = await post(w, 'tok-reader', { action: 'checkout', product_id: p.id, variant_id: 17393, quantity: 1 }, { ...ENV, GRAPHEON_STRIPE_TAX: '1' });
  assert.equal(r2.statusCode, 200);
  assert.equal(w.stripe().filter((c) => c.path === '/v1/checkout/sessions')[1].form.get('automatic_tax[enabled]'), 'true');
  const bad = await post(w, 'tok-reader', { action: 'checkout', product_id: p.id, variant_id: 99999, quantity: 1 });
  assert.equal(bad.statusCode, 400);
  const other = await post(w, 'tok-other', { action: 'checkout', product_id: p.id, variant_id: 17393, quantity: 1 });
  assert.equal(other.statusCode, 404);
  // Without Grapheon's Stripe key: 503, and no order row.
  const before = w.store.tables.merch_orders.length;
  const dormant = await post(w, 'tok-reader', { action: 'checkout', product_id: p.id, variant_id: 17393, quantity: 1 }, { ...ENV, GRAPHEON_STRIPE_SECRET_KEY: '' });
  assert.equal(dormant.statusCode, 503);
  assert.equal(w.store.tables.merch_orders.length, before);
});

/* ───────────────────────── the webhook ───────────────────────── */

function signed(secret, event, nowSec) {
  const payload = JSON.stringify(event);
  const sig = createHmac('sha256', secret).update(`${nowSec}.${payload}`).digest('hex');
  return { payload, header: `t=${nowSec},v1=${sig}` };
}

async function deliver(w, event, { env = ENV, secret = ENV.GRAPHEON_STRIPE_WEBHOOK_SECRET, header = null } = {}) {
  const nowSec = 1_800_000_000;
  const s = signed(secret, event, nowSec);
  const req = { method: 'POST', headers: { 'stripe-signature': header ?? s.header }, rawBody: Buffer.from(s.payload) };
  const res = response();
  await webhook(req, res, { fetchImpl: w.fetchImpl, env, nowMs: nowSec * 1000 });
  return res;
}

const paidEvent = (orderId, id = 'evt_1') => ({
  id, type: 'checkout.session.completed', created: 1_800_000_000,
  data: { object: { id: 'cs_test_1', object: 'checkout.session', payment_status: 'paid', amount_total: 3294, payment_intent: 'pi_1', metadata: { kind: 'merch', order_id: orderId }, customer_details: { email: 'reader@example.test' }, total_details: { amount_tax: 0, amount_shipping: 495 } } },
});

test('pure: the address off a Session, whichever field the API version puts it in', () => {
  const a = addressFromSession({ shipping_details: { name: 'Eden Q Reader', address: { line1: '1 Main St', city: 'Princeton', state: 'NJ', postal_code: '08540', country: 'US' } }, customer_details: { phone: '+1' } });
  assert.deepEqual([a.firstName, a.lastName, a.phone, a.zipCode], ['Eden Q', 'Reader', '+1', '08540']);
  const b = addressFromSession({ collected_information: { shipping_details: { name: 'Solo', address: { line1: 'x', city: 'y', postal_code: 'z', country: 'US' } } } });
  assert.deepEqual([b.firstName, b.lastName], ['Solo', '-']);
  assert.equal(addressFromSession({}), null);
});

test('webhook: a bad signature is a 400; without the secret a 503; another kind is acknowledged and ignored', async () => {
  const w = fakeWorld();
  const bad = await deliver(w, paidEvent('x'), { header: 't=1800000000,v1=deadbeef' });
  assert.equal(bad.statusCode, 400);
  const off = await deliver(w, paidEvent('x'), { env: { ...ENV, GRAPHEON_STRIPE_WEBHOOK_SECRET: '' } });
  assert.equal(off.statusCode, 503);
  const other = await deliver(w, { id: 'evt_9', type: 'checkout.session.completed', data: { object: { id: 'cs_9', metadata: { kind: 'subscription' } } } });
  assert.equal(other.statusCode, 200);
  assert.equal(other.json().ignored, 'checkout.session.completed');
  assert.equal(w.printify().length, 0);
});

test('webhook: the paid order is placed at Printify once, on hold, with the address re-fetched from the Session; a replayed event places nothing', async () => {
  const w = fakeWorld();
  const p = await makeReadyProduct(w);
  const c = await post(w, 'tok-reader', { action: 'checkout', product_id: p.id, variant_id: 17393, quantity: 1 });
  const orderId = c.json().order_id;

  const r = await deliver(w, paidEvent(orderId));
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().printify_order_id, 'po-1');
  assert.equal(r.json().status, 'placed');
  const order = w.store.tables.merch_orders.find((o) => o.id === orderId);
  assert.equal(order.status, 'placed');
  assert.equal(order.printify_order_id, 'po-1');
  assert.equal(order.placing_at, null, 'the claim is released once placed');
  assert.equal(order.stripe_payment_intent, 'pi_1');
  assert.equal(order.email, 'reader@example.test');
  const placed = w.printify().find((x) => x.path === '/v1/shops/25109380/orders.json' && x.method === 'POST');
  assert.equal(placed.body.external_id, orderId);
  assert.deepEqual(placed.body.line_items, [{ product_id: 'prod-1', variant_id: 17393, quantity: 1 }]);
  assert.equal(placed.body.address_to.first_name, 'Eden');
  assert.equal(placed.body.address_to.last_name, 'Reader');
  assert.equal(placed.body.address_to.address1, '1 Main St');
  assert.equal(placed.body.address_to.region, 'NJ');
  assert.equal(placed.body.address_to.zip, '08540');
  assert.equal(placed.body.address_to.phone, '+12125551212');
  assert.equal(placed.body.address_to.email, 'reader@example.test');
  assert.ok(w.stripe().some((x) => x.path === '/v1/checkout/sessions/cs_test_1' && x.method === 'GET'), 'the Session was re-fetched');
  assert.equal(w.printify().filter((x) => /send_to_production/.test(x.path)).length, 0, 'not sent to production by default');

  // Replay: nothing more at Printify.
  const again = await deliver(w, paidEvent(orderId, 'evt_1_again'));
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().already, 'placed');
  assert.equal(w.printify().filter((x) => x.path === '/v1/shops/25109380/orders.json' && x.method === 'POST').length, 1);

  // The reader sees the order, and an order action reads it back without needing Printify.
  const mine = await post(w, 'tok-reader', { action: 'orders' });
  assert.equal(mine.json().orders[0].status, 'placed');
  const others = await post(w, 'tok-other', { action: 'orders' });
  assert.equal(others.json().orders.length, 0);
});

test('webhook: MERCH_SEND_TO_PRODUCTION=1 sends the placed order to production', async () => {
  const w = fakeWorld();
  const p = await makeReadyProduct(w);
  const c = await post(w, 'tok-reader', { action: 'checkout', product_id: p.id, variant_id: 17390, quantity: 1 });
  const r = await deliver(w, paidEvent(c.json().order_id), { env: { ...ENV, MERCH_SEND_TO_PRODUCTION: '1' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'in_production');
  assert.equal(w.printify().filter((x) => /send_to_production/.test(x.path)).length, 1);
  assert.ok(w.store.tables.merch_orders[0].sent_to_production_at);
});

test('webhook: a Printify failure answers 500 and releases the claim, so the retry places the order', async () => {
  const w = fakeWorld({ failOrder: true });
  const p = await makeReadyProduct(w);
  const c = await post(w, 'tok-reader', { action: 'checkout', product_id: p.id, variant_id: 17390, quantity: 1 });
  const orderId = c.json().order_id;
  const r = await deliver(w, paidEvent(orderId));
  assert.equal(r.statusCode, 500);
  const order = w.store.tables.merch_orders.find((o) => o.id === orderId);
  assert.equal(order.status, 'paid', 'paid, not placed');
  assert.equal(order.placing_at, null, 'the claim was released');
  assert.match(order.error, /Printify/);
  // Printify recovers; Stripe retries.
  const w2 = { ...w };
  w2.fetchImpl = async (url, init) => {
    if (String(url).endsWith('/orders.json') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'po-7', status: 'on-hold' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return w.fetchImpl(url, init);
  };
  const retry = await deliver(w2, paidEvent(orderId, 'evt_retry'));
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(order.status, 'placed');
  assert.equal(order.printify_order_id, 'po-7');
  assert.equal(order.error, null);
});
