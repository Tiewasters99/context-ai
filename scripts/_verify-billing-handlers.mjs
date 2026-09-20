// Section G of scripts/_verify-billing.mjs: the real handlers, offline.
//
// The two services the billing endpoints talk to are replaced by one `fetch`
// stub:
//
//   api.stripe.com  → canned objects, with every request body captured so the
//                     test can assert what was actually sent (mode, interval,
//                     invoice_creation, the matter name on the line item).
//                     No network, no Stripe account, not even test mode.
//
//   PostgREST       → NOT a fake. The request is translated into SQL and run
//                     against the same PGlite database the migration half
//                     built, with the role and the JWT claim taken from the
//                     Authorization header exactly as PostgREST does it. So
//                     when a matter read comes back empty here, it came back
//                     empty because of a real RLS policy.
//
// Kept in its own file because the migration half is already long, and because
// the two halves fail for completely different reasons.

import { createHmac } from 'node:crypto';

import handleCheckout from '../api/billing-checkout.mjs';
import handlePortal from '../api/billing-portal.mjs';
import handleCredits from '../api/billing-credits-checkout.mjs';
import handleWebhook from '../api/billing-webhook.mjs';
import handleConfig from '../api/billing-config.mjs';

const SUPA = 'https://stub.supabase.test';
const SERVICE_KEY = 'service-key-stub';
const ANON_KEY = 'anon-key-stub';
const WEBHOOK_SECRET = 'whsec_stub_secret';

// ---------------------------------------------------------------------------
// The smallest PostgREST that is still honest.
// ---------------------------------------------------------------------------
function makePostgrest(db) {
  return async function postgrest(url, init = {}) {
    const u = new URL(url);
    const headers = Object.fromEntries(
      Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const auth = String(headers.authorization || '').replace(/^Bearer\s+/i, '');

    // /auth/v1/user — turn a token into a user, as Supabase Auth would. This
    // is GoTrue rather than PostgREST, so it runs as the owner and not as the
    // caller (a signed-in role cannot read auth.users, and on the real database
    // this request never goes near Postgres roles at all).
    if (u.pathname === '/auth/v1/user') {
      await db.exec('reset role');
      const m = /^usertoken:(.+)$/.exec(auth);
      if (!m) return jsonResponse(401, { message: 'invalid token' });
      const { rows } = await db.query(`select id, email from auth.users where id = $1`, [m[1]]);
      if (!rows.length) return jsonResponse(401, { message: 'no such user' });
      return jsonResponse(200, rows[0]);
    }

    // Become the caller. The service key is the owner's key; anything else is a
    // signed-in user whose id rides in the token.
    if (auth === SERVICE_KEY) {
      await db.exec(`reset role; set role service_role;`);
      await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    } else {
      const m = /^usertoken:(.+)$/.exec(auth);
      await db.exec('reset role');
      await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [m ? m[1] : '']);
      await db.exec(m ? 'set role authenticated' : 'set role anon');
    }

    try {
      // POST /rest/v1/rpc/<fn> with named arguments.
      const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/i.exec(u.pathname);
      if (rpc) {
        const args = JSON.parse(init.body || '{}');
        const names = Object.keys(args);
        const call = names.length
          ? `${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}`
          : '';
        const { rows } = await db.query(
          `select public.${rpc[1]}(${call}) as r`, names.map((n) => args[n]));
        return jsonResponse(200, rows[0]?.r ?? null);
      }

      // GET /rest/v1/<table>?<col>=eq.<v>&select=...&limit=n
      const tbl = /^\/rest\/v1\/([a-z0-9_]+)$/i.exec(u.pathname);
      if (tbl && (init.method || 'GET').toUpperCase() === 'GET') {
        const params = u.searchParams;
        const select = params.get('select') || '*';
        const where = [];
        const values = [];
        for (const [k, v] of params.entries()) {
          if (k === 'select' || k === 'limit' || k === 'order') continue;
          const eq = /^eq\.(.*)$/.exec(v);
          if (!eq) continue;
          values.push(eq[1]);
          where.push(`${k} = $${values.length}`);
        }
        const limit = params.get('limit') ? ` limit ${parseInt(params.get('limit'), 10) || 1}` : '';
        const sql = `select ${select === '*' ? '*' : select} from public.${tbl[1]}`
          + (where.length ? ` where ${where.join(' and ')}` : '') + limit;
        const { rows } = await db.query(sql, values);
        return jsonResponse(200, rows);
      }
    } catch (err) {
      return jsonResponse(400, { message: err?.message || String(err), code: err?.code || null });
    }
    return jsonResponse(404, { message: 'stub: unrouted' });
  };
}

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

// ---------------------------------------------------------------------------
// Stripe, canned. Every request is recorded so the test can read it back.
// ---------------------------------------------------------------------------
function makeStripe(state) {
  let n = 0;
  return async function stripe(url, init = {}) {
    const u = new URL(url);
    const form = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    state.calls.push({ path: u.pathname, method: init.method || 'POST', form,
      idempotencyKey: (init.headers || {})['Idempotency-Key'] || null });

    if (state.failNext) { state.failNext = false; return jsonResponse(500, { error: { message: 'stripe is down' } }); }

    if (u.pathname === '/v1/customers') {
      return jsonResponse(200, { id: `cus_stub_${++n}`, email: form.email || null });
    }
    if (u.pathname === '/v1/checkout/sessions') {
      const id = `cs_stub_${++n}`;
      state.sessions[id] = form;
      return jsonResponse(200, {
        id,
        url: `https://checkout.stripe.test/${id}`,
        customer: form.customer || `cus_stub_${n}`,
      });
    }
    if (u.pathname === '/v1/billing_portal/sessions') {
      return jsonResponse(200, { id: `bps_${++n}`, url: 'https://billing.stripe.test/portal' });
    }
    const inv = /^\/v1\/invoices\/(.+)$/.exec(u.pathname);
    if (inv) {
      if (state.invoiceFails) return jsonResponse(404, { error: { message: 'no such invoice' } });
      return jsonResponse(200, { id: inv[1], hosted_invoice_url: `https://invoice.stripe.test/${inv[1]}` });
    }
    const sub = /^\/v1\/subscriptions\/(.+)$/.exec(u.pathname);
    if (sub) {
      return jsonResponse(200, state.subscriptions[sub[1]] || null);
    }
    return jsonResponse(404, { error: { message: 'stub: unrouted' } });
  };
}

// ---------------------------------------------------------------------------
// Node-shaped req/res, small enough to read.
// ---------------------------------------------------------------------------
function mockReq({ method = 'POST', headers = {}, body = null, raw = null } = {}) {
  const req = { method, url: '/', headers: { ...headers } };
  if (raw !== null) {
    req[Symbol.asyncIterator] = async function* () { yield Buffer.from(raw, 'utf8'); };
  } else if (body !== null) {
    req.body = body;
  }
  return req;
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(b) { this.body = b; return this; },
    get json() { try { return JSON.parse(this.body || 'null'); } catch { return null; } },
  };
}

const userAuth = (id) => ({ authorization: `Bearer usertoken:${id}` });

/** Sign an event the way Stripe does: HMAC-SHA256 over `${t}.${payload}`. */
function signedEvent(event, { secret = WEBHOOK_SECRET, tSeconds = null, mangle = false } = {}) {
  const payload = JSON.stringify(event);
  const t = tSeconds ?? Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return { payload, header: `t=${t},v1=${mangle ? sig.replace(/^../, 'ff') : sig}` };
}

// ===========================================================================
export async function runHandlerChecks({ db, check, makeUser, asOwner, asUser, matterId }) {
  console.log('\n=== G. the handlers, offline =====================================');
  let localFailures = 0;
  const wrapped = (ok, label, detail = '') => { if (!ok) localFailures += 1; check(ok, label, detail); };

  const stripeState = { calls: [], sessions: {}, subscriptions: {}, failNext: false, invoiceFails: false };
  const stripe = makeStripe(stripeState);
  const postgrest = makePostgrest(db);
  const fetchImpl = async (url, init) =>
    (String(url).startsWith('https://api.stripe.com') ? stripe(url, init) : postgrest(url, init));

  const saved = { ...process.env };
  process.env.VITE_SUPABASE_URL = SUPA;
  process.env.VITE_SUPABASE_ANON_KEY = ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  process.env.SITE_ORIGIN = 'https://www.contextspaces.test';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  for (const k of Object.keys(process.env)) if (/^STRIPE_PRICE_/.test(k)) delete process.env[k];

  await asOwner(db);
  const customer = await makeUser(db, 'free', 'customer@example.test');
  const before = Number((await db.query(`select count(*)::int as n from public.billing_events`)).rows[0].n);

  // ---- dormant --------------------------------------------------------------
  console.log('\n--- with no Stripe key, nothing half-works ---------------------');
  {
    const cases = [
      ['/api/billing-checkout', handleCheckout, { plan_key: 'basic' }],
      ['/api/billing-portal', handlePortal, {}],
      ['/api/billing-credits-checkout', handleCredits, { pack_key: 'pack_25' }],
    ];
    for (const [name, fn, body] of cases) {
      const res = mockRes();
      await fn(mockReq({ headers: userAuth(customer), body }), res, { fetchImpl });
      wrapped(res.statusCode === 503 && res.json?.error === 'billing_not_configured',
        `${name} answers 503 billing_not_configured`, `${res.statusCode} ${res.json?.error}`);
    }
    const res = mockRes();
    await handleWebhook(mockReq({ headers: { 'stripe-signature': 't=1,v1=x' }, raw: '{}' }), res, { fetchImpl });
    wrapped(res.statusCode === 503 && res.json?.error === 'billing_not_configured',
      '/api/billing-webhook answers 503 too — Stripe will retry once the secret is set');

    const cfgRes = mockRes();
    await handleConfig(mockReq({ method: 'GET', headers: userAuth(customer) }), cfgRes, { fetchImpl });
    wrapped(cfgRes.statusCode === 200 && cfgRes.json?.configured === false && cfgRes.json?.mode === null,
      '/api/billing-config says configured:false, so the UI can render the quiet state');

    const after = Number((await db.query(`select count(*)::int as n from public.billing_events`)).rows[0].n);
    wrapped(after === before, 'and the dormant calls changed nothing in the database');
    wrapped(stripeState.calls.length === 0, 'and never touched Stripe');
  }

  // ---- switched on ----------------------------------------------------------
  process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  await asOwner(db);
  await db.exec(`update public.billing_plans set stripe_price_id = 'price_basic' where tier_key = 'basic';
                 update public.billing_plans set stripe_price_id = 'price_pro'   where tier_key = 'pro';
                 update public.billing_plans set stripe_price_id = null          where tier_key = 'max';`);

  console.log('\n--- subscription checkout --------------------------------------');
  {
    const res = mockRes();
    await handleCheckout(mockReq({ headers: userAuth(customer), body: { plan_key: 'basic' } }), res, { fetchImpl });
    wrapped(res.statusCode === 200 && /checkout\.stripe\.test/.test(res.json?.url || ''),
      'a signed-in user gets a Checkout URL back', `${res.statusCode}`);

    const sessionCall = stripeState.calls.find((c) => c.path === '/v1/checkout/sessions');
    wrapped(sessionCall?.form.mode === 'subscription', "the session is mode 'subscription'");
    wrapped(sessionCall?.form['line_items[0][price]'] === 'price_basic',
      'and carries the price id from the billing_plans row');
    wrapped(!Object.values(sessionCall?.form || {}).some((v) => /year|annual/i.test(String(v))),
      'nothing in the request mentions a year — monthly only, by decision');
    wrapped(sessionCall?.form.client_reference_id === customer
      && sessionCall?.form['subscription_data[metadata][user_id]'] === customer,
      'the user id rides on the session AND on the subscription, so the webhook can resolve it');
    wrapped(!('subscription_data[trial_period_days]' in (sessionCall?.form || {})),
      'and no trial is sent, because the seeded default is none');

    const custCall = stripeState.calls.find((c) => c.path === '/v1/customers');
    wrapped(custCall?.idempotencyKey === `cs-customer-${customer}`,
      'the customer is created with an idempotency key, so a retry cannot make two');

    await asOwner(db);
    const linked = (await db.query(
      `select stripe_customer_id from public.billing_accounts where user_id = $1`, [customer])).rows[0];
    wrapped(Boolean(linked?.stripe_customer_id),
      'and the customer is on file BEFORE the session exists — otherwise the first webhook has nothing to resolve',
      linked?.stripe_customer_id);
  }

  {
    const res = mockRes();
    await handleCheckout(mockReq({ headers: userAuth(customer), body: { plan_key: 'nope' } }), res, { fetchImpl });
    wrapped(res.statusCode === 404 && res.json?.error === 'unknown_plan', 'an unknown plan is a 404');

    const res2 = mockRes();
    await handleCheckout(mockReq({ headers: userAuth(customer), body: { plan_key: 'max' } }), res2, { fetchImpl });
    wrapped(res2.statusCode === 503 && res2.json?.error === 'plan_price_missing',
      'a plan with no Stripe price says exactly that, rather than failing at Stripe',
      res2.json?.detail);

    const res3 = mockRes();
    await handleCheckout(mockReq({ headers: userAuth(customer), body: { plan_key: 'free' } }), res3, { fetchImpl });
    wrapped(res3.statusCode === 400 && res3.json?.error === 'plan_not_purchasable',
      'and nobody can "buy" the free plan');

    const res4 = mockRes();
    await handleCheckout(mockReq({ body: { plan_key: 'basic' } }), res4, { fetchImpl });
    wrapped(res4.statusCode === 401, 'checkout without a bearer is a 401');
  }

  console.log('\n--- credit packs, with and without a matter --------------------');
  await asOwner(db);
  const buyer2 = await makeUser(db, 'basic', 'buyer2@example.test');
  const { rows: cs2 } = await db.query(`select id from public.clientspaces where user_id = $1 limit 1`, [buyer2]);
  const { rows: ss2 } = await db.query(
    `insert into public.serverspaces (clientspace_id, name) values ($1, 'Buyer2 Firm') returning id`, [cs2[0].id]);
  await db.query(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`,
    [ss2[0].id, buyer2]);
  const { rows: ms2 } = await db.query(
    `insert into public.matterspaces (serverspace_id, name) values ($1, 'Anlauf v. UKC') returning id`, [ss2[0].id]);
  const ownMatter = ms2[0].id;
  await db.query(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'admin')`,
    [ownMatter, buyer2]);

  let creditSessionId = null;
  {
    const res = mockRes();
    await handleCredits(mockReq({ headers: userAuth(buyer2), body: { pack_key: 'pack_100', matter_id: ownMatter } }),
      res, { fetchImpl });
    wrapped(res.statusCode === 200, 'a tagged pack purchase starts', `${res.statusCode} ${res.json?.error || ''}`);
    creditSessionId = res.json?.session_id;
    const form = stripeState.sessions[creditSessionId] || {};
    wrapped(form.mode === 'payment', "the pack session is mode 'payment' — a one-time charge, not a plan");
    wrapped(form['invoice_creation[enabled]'] === 'true',
      'invoice_creation is on, so Stripe issues a real invoice and not just a card receipt');
    wrapped(form['line_items[0][price_data][product_data][description]'] === 'Contextspaces usage credits — Matter: Anlauf v. UKC',
      "the matter's NAME is on the line item, which is what a client pass-through rests on",
      form['line_items[0][price_data][product_data][description]']);
    wrapped(form['invoice_creation[invoice_data][description]'] === 'Contextspaces usage credits — Matter: Anlauf v. UKC',
      'and on the invoice itself');
    wrapped(form['metadata[matter_name]'] === 'Anlauf v. UKC' && form['metadata[matter_id]'] === ownMatter,
      'and in the metadata the webhook will snapshot into the ledger');
    wrapped(form['metadata[credit_cents]'] === '10000',
      'the credits granted come from the pack row, not from the amount charged');
  }

  {
    // A matter belonging to someone else. RLS is what answers, not a flag.
    const res = mockRes();
    await handleCredits(mockReq({ headers: userAuth(buyer2), body: { pack_key: 'pack_25', matter_id: matterId } }),
      res, { fetchImpl });
    wrapped(res.statusCode === 403 && res.json?.error === 'matter_not_accessible',
      "a matter the buyer cannot read is refused — its name is not theirs to print on an invoice",
      `${res.statusCode}`);

    const res2 = mockRes();
    await handleCredits(mockReq({ headers: userAuth(buyer2),
      body: { pack_key: 'pack_25', matter_id: '11111111-2222-3333-4444-555555555555' } }), res2, { fetchImpl });
    wrapped(res2.statusCode === 403,
      'and a matter that does not exist is refused in exactly the same words');

    const res3 = mockRes();
    await handleCredits(mockReq({ headers: userAuth(buyer2), body: { pack_key: 'pack_25' } }), res3, { fetchImpl });
    wrapped(res3.statusCode === 200 && res3.json?.matter === null, 'an untagged purchase is fine too');
  }

  console.log('\n--- the webhook ------------------------------------------------');
  const custId = (await db.query(
    `select stripe_customer_id from public.billing_accounts where user_id = $1`, [customer])).rows[0].stripe_customer_id;

  const post = async (event, opts = {}) => {
    const { payload, header } = signedEvent(event, opts);
    const res = mockRes();
    await handleWebhook(mockReq({ headers: { 'stripe-signature': opts.header ?? header }, raw: payload }),
      res, { fetchImpl });
    return res;
  };

  const subEvent = (id, created, status, price, subId = 'sub_hook') => ({
    id, type: 'customer.subscription.updated', created,
    data: { object: { id: subId, customer: custId, status,
      items: { data: [{ price: { id: price }, current_period_end: 1790000000 }] },
      cancel_at_period_end: false } },
  });

  {
    const bad = await post(subEvent('evt_h1', 9_000_000, 'active', 'price_basic'), { mangle: true });
    wrapped(bad.statusCode === 400 && bad.json?.error === 'invalid_signature', 'a bad signature is a 400');

    const wrongSecret = await post(subEvent('evt_h2', 9_000_001, 'active', 'price_basic'), { secret: 'whsec_other' });
    wrapped(wrongSecret.statusCode === 400, 'a signature from the wrong secret is a 400');

    const stale = await post(subEvent('evt_h3', 9_000_002, 'active', 'price_basic'),
      { tSeconds: Math.floor(Date.now() / 1000) - 1000 });
    wrapped(stale.statusCode === 400,
      'a correctly-signed request with a stale timestamp is still a 400 — a captured body cannot be replayed later');

    const none = await post(subEvent('evt_h4', 9_000_003, 'active', 'price_basic'), { header: '' });
    wrapped(none.statusCode === 400, 'and no signature header at all is a 400');

    wrapped(await tierOfUser(db, customer) === 'free',
      'none of those four changed anything');
  }

  {
    const ok = await post(subEvent('evt_h10', 9_000_010, 'active', 'price_basic'));
    wrapped(ok.statusCode === 200 && await tierOfUser(db, customer) === 'basic',
      'a correctly-signed subscription event moves the account to the plan', `${ok.statusCode}`);

    const again = await post(subEvent('evt_h10', 9_000_010, 'canceled', 'price_basic'));
    wrapped(again.statusCode === 200 && again.json?.replay === true
      && await tierOfUser(db, customer) === 'basic',
      'the same event id delivered again is acknowledged and ignored');

    // Rotation: two v1 signatures, only the second of which is ours.
    const { payload, header } = signedEvent(subEvent('evt_h11', 9_000_011, 'active', 'price_pro'));
    const rotated = mockRes();
    await handleWebhook(mockReq({
      headers: { 'stripe-signature': `${header.split(',v1=')[0]},v1=${'0'.repeat(64)},v1=${header.split(',v1=')[1]}` },
      raw: payload,
    }), rotated, { fetchImpl });
    wrapped(rotated.statusCode === 200 && await tierOfUser(db, customer) === 'pro',
      'a header carrying two v1 signatures (a secret rotation) is accepted on the one that matches');

    const other = await post({ id: 'evt_h12', type: 'customer.discount.created', created: 9_000_012, data: { object: {} } });
    wrapped(other.statusCode === 200 && other.json?.ignored === 'customer.discount.created',
      'an event type this endpoint does not handle is acknowledged, never 4xx-ed into a retry loop');
  }

  console.log('\n--- the webhook fulfils a credit pack --------------------------');
  {
    const balBefore = await balanceOfUser(db, buyer2);
    const paid = await post({
      id: 'evt_h20', type: 'checkout.session.completed', created: 9_000_020,
      data: { object: {
        id: creditSessionId, mode: 'payment', payment_status: 'paid',
        customer: 'cus_stub_buyer2', client_reference_id: buyer2, invoice: 'in_hook_1',
        payment_intent: 'pi_hook_1', amount_total: 10000,
        metadata: { kind: 'usage_credits', user_id: buyer2, pack_key: 'pack_100',
          credit_cents: '10000', matter_id: ownMatter, matter_name: 'Anlauf v. UKC' },
      } },
    });
    wrapped(paid.statusCode === 200 && await balanceOfUser(db, buyer2) === balBefore + 10000,
      'a paid credit-pack session grants exactly the pack\'s credits', `${paid.statusCode}`);
    const row = (await db.query(
      `select matter_name, invoice_url, stripe_payment_intent_id from public.usage_credit_ledger
        where stripe_session_id = $1`, [creditSessionId])).rows[0];
    wrapped(row?.matter_name === 'Anlauf v. UKC' && row?.stripe_payment_intent_id === 'pi_hook_1',
      'the ledger row carries the matter name and the payment intent');
    wrapped(row?.invoice_url === 'https://invoice.stripe.test/in_hook_1',
      'and the hosted invoice URL, fetched from Stripe at grant time', row?.invoice_url);

    const replayed = await post({
      id: 'evt_h21', type: 'checkout.session.completed', created: 9_000_021,
      data: { object: { id: creditSessionId, mode: 'payment', payment_status: 'paid',
        client_reference_id: buyer2, amount_total: 10000,
        metadata: { kind: 'usage_credits', user_id: buyer2, credit_cents: '10000' } } },
    });
    wrapped(replayed.json?.replay === true && await balanceOfUser(db, buyer2) === balBefore + 10000,
      'the same SESSION under a new event id grants nothing more');

    const unpaid = await post({
      id: 'evt_h22', type: 'checkout.session.completed', created: 9_000_022,
      data: { object: { id: 'cs_unpaid', mode: 'payment', payment_status: 'unpaid',
        client_reference_id: buyer2, metadata: { kind: 'usage_credits', user_id: buyer2, credit_cents: '5000' } } },
    });
    wrapped(unpaid.statusCode === 200 && unpaid.json?.applied === false
      && await balanceOfUser(db, buyer2) === balBefore + 10000,
      'a session that completed WITHOUT payment grants nothing');

    // The invoice lookup failing must not lose the purchase.
    stripeState.invoiceFails = true;
    const noInvoice = await post({
      id: 'evt_h23', type: 'checkout.session.completed', created: 9_000_023,
      data: { object: { id: 'cs_noinv', mode: 'payment', payment_status: 'paid',
        client_reference_id: buyer2, invoice: 'in_missing', amount_total: 2500,
        metadata: { kind: 'usage_credits', user_id: buyer2, pack_key: 'pack_25', credit_cents: '2500' } } },
    });
    stripeState.invoiceFails = false;
    wrapped(noInvoice.statusCode === 200 && await balanceOfUser(db, buyer2) === balBefore + 12500,
      'and if the invoice URL cannot be fetched, the credits are still granted');
  }

  console.log('\n--- a subscription session that has to fetch its subscription --');
  {
    stripeState.subscriptions.sub_fetched = {
      id: 'sub_fetched', customer: custId, status: 'active',
      items: { data: [{ price: { id: 'price_basic' }, current_period_end: 1790000000 }] },
      cancel_at_period_end: false,
    };
    const res = await post({
      id: 'evt_h30', type: 'checkout.session.completed', created: 9_000_030,
      data: { object: { id: 'cs_sub', mode: 'subscription', subscription: 'sub_fetched',
        customer: custId, client_reference_id: customer,
        metadata: { kind: 'subscription', user_id: customer, tier_key: 'basic' } } },
    });
    wrapped(res.statusCode === 200 && await tierOfUser(db, customer) === 'basic',
      'checkout.session.completed in subscription mode fetches the subscription and applies it');
  }

  console.log('\n--- when the database is unreachable, Stripe is asked to retry -');
  {
    const brokenFetch = async (url, init) => (String(url).startsWith('https://api.stripe.com')
      ? stripe(url, init)
      : (String(url).includes('/rest/v1/rpc/') ? jsonResponse(500, { message: 'boom' }) : postgrest(url, init)));
    const { payload, header } = signedEvent(subEvent('evt_h40', 9_000_040, 'active', 'price_basic'));
    const res = mockRes();
    await handleWebhook(mockReq({ headers: { 'stripe-signature': header }, raw: payload }), res,
      { fetchImpl: brokenFetch });
    wrapped(res.statusCode === 500,
      'an RPC failure is a 500, so Stripe redelivers rather than the event being lost');
    const seen = Number((await db.query(
      `select count(*)::int as n from public.billing_events where event_id = 'evt_h40'`)).rows[0].n);
    wrapped(seen === 0,
      'and the event was NOT recorded as handled — the idempotency row rolls back with the work it guards');
    const retry = await post(subEvent('evt_h40', 9_000_040, 'active', 'price_basic'));
    wrapped(retry.statusCode === 200 && retry.json?.replay !== true,
      'so the redelivery is processed for real, not swallowed as a replay');
  }

  console.log('\n--- the portal -------------------------------------------------');
  {
    await asOwner(db);
    const noCustomer = await makeUser(db, 'free', 'never-subscribed@example.test');
    const res = mockRes();
    await handlePortal(mockReq({ headers: userAuth(noCustomer), body: {} }), res, { fetchImpl });
    wrapped(res.statusCode === 409 && res.json?.error === 'no_stripe_customer',
      'an account that never subscribed is told so, rather than redirected into a Stripe 404');

    const res2 = mockRes();
    await handlePortal(mockReq({ headers: userAuth(customer), body: {} }), res2, { fetchImpl });
    wrapped(res2.statusCode === 200 && /billing\.stripe\.test/.test(res2.json?.url || ''),
      'a subscriber gets a Customer Portal URL — where cancelling, changing plan and invoices live');

    stripeState.failNext = true;
    const res3 = mockRes();
    await handlePortal(mockReq({ headers: userAuth(customer), body: {} }), res3, { fetchImpl });
    wrapped(res3.statusCode === 502 && /Customer Portal must be enabled/i.test(res3.json?.detail || ''),
      'and a Stripe failure names the likeliest cause instead of a bare 502');

    const cfg = mockRes();
    await handleConfig(mockReq({ method: 'GET', headers: userAuth(customer) }), cfg, { fetchImpl });
    wrapped(cfg.json?.configured === true && cfg.json?.mode === 'test',
      'billing-config reports test mode from the key prefix, and never the key', JSON.stringify(cfg.json));
  }

  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  return localFailures;
}

const tierOfUser = async (db, id) => {
  await db.exec('reset role');
  return (await db.query(`select pricing_tier from public.profiles where id = $1`, [id])).rows[0]?.pricing_tier;
};
const balanceOfUser = async (db, id) => {
  await db.exec('reset role');
  return Number((await db.query(
    `select coalesce(cents_available, 0) as c from public.usage_credit_balance where user_id = $1`,
    [id])).rows[0]?.c ?? 0);
};
