// The product sheet's arithmetic (src/lib/merch-sheet.ts): the valid
// colour/size pair, print sizes by the picture's orientation, prices and
// shipping, which mockup shows, order wording, the way back from Stripe.
//
//   node scripts/_test-merch-sheet.mjs
//
// Offline. The print sizes are Printify's own titles for blueprint 804 /
// provider 99, read 2026-10-14 (both inch marks occur in them).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const out = ts.transpileModule(readFileSync('src/lib/merch-sheet.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(out, { exports: mod.exports, module: mod, require: () => ({}), URLSearchParams });
const {
  parsePrintSize, pictureOrientation, sortSizes, coloursOf, sizesFor, pickVariant, reconcile,
  formatMoney, fromCents, shippingCents, clampQuantity, mockupFor, reusableByKey, productNoun,
  orderStatusSentence, orderStillMoving, readMerchReturn, stripMerchReturn,
} = mod.exports;

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok', name); };
// Objects made inside the vm have another realm's prototypes; compare by value.
const eq = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

// A tee like Printify's Next Level 3600 (prices differ by size).
let id = 1;
const tee = [];
for (const [color, hex] of [['Black', '#000000'], ['Heather Grey', '#9a9a9a'], ['Navy', '#1f2a44']]) {
  for (const size of ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL']) {
    tee.push({ id: id++, title: `${color} / ${size}`, color, color_hex: hex, size, paper: null,
      cost_cents: size === '2XL' || size === '3XL' ? 1500 : 1200, price_cents: size === '2XL' || size === '3XL' ? 2199 : 1799,
      available: !(color === 'Navy' && size === 'XS') });
  }
}
const tote = ['Black', 'Natural', 'Navy'].map((c, i) => ({ id: 900 + i, title: `One size / ${c}`, color: c, color_hex: null, size: 'One size', paper: null, cost_cents: 1300, price_cents: 1899, available: true }));
const PRINT_SIZES = [
  '8" x 12" (Vertical)', '12″ x 16″ (Vertical)', '24″ x 24″', '10″ x 8″ (Horizontal)', '12" x 8" (Horizontal)',
  '16″ x 16″', '18″ x 24″ (Vertical)', '36" x 24" (Horizontal)', '11″ x 14″ (Vertical)', '14″ x 11″ (Horizontal)',
];
const print = PRINT_SIZES.map((s, i) => ({ id: 500 + i, title: `${s} / Matte`, color: null, color_hex: null, size: s, paper: 'Matte', cost_cents: 800 + i * 100, price_cents: 1299 + i * 100, available: true }));

test('parsePrintSize reads both inch marks and the orientation word', () => {
  eq(parsePrintSize('8" x 12" (Vertical)'), { w: 8, h: 12, orientation: 'vertical' });
  eq(parsePrintSize('10″ x 8″ (Horizontal)'), { w: 10, h: 8, orientation: 'horizontal' });
  eq(parsePrintSize('24″ x 24″'), { w: 24, h: 24, orientation: 'square' });
  assert.equal(parsePrintSize('One size'), null);
  assert.equal(parsePrintSize(null), null);
});

test('pictureOrientation: a map wider than tall is horizontal; near-square is square', () => {
  assert.equal(pictureOrientation(2000, 1000), 'horizontal');
  assert.equal(pictureOrientation(600, 1200), 'vertical');
  assert.equal(pictureOrientation(1000, 980), 'square');
});

test('clothes sizes sort XS…3XL whatever order Printify sent them', () => {
  eq(sortSizes(['L', '3XL', 'XS', 'M', 'S', '2XL', 'XL'], 'tee'), ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL']);
  eq(sortSizes(['One size', 'One size'], 'tote'), ['One size']);
});

test('print sizes: the picture\'s own orientation first, square next, the other way last; smallest first within', () => {
  const forWideMap = sortSizes(PRINT_SIZES, 'print', 'horizontal');
  eq(forWideMap.slice(0, 4), ['10″ x 8″ (Horizontal)', '12" x 8" (Horizontal)', '14″ x 11″ (Horizontal)', '36" x 24" (Horizontal)']);
  eq(forWideMap.slice(4, 6), ['16″ x 16″', '24″ x 24″']);
  assert.equal(forWideMap[6], '8" x 12" (Vertical)');
  const forPlate = sortSizes(PRINT_SIZES, 'print', 'vertical');
  assert.equal(forPlate[0], '8" x 12" (Vertical)');
  assert.equal(forPlate.at(-1), '36" x 24" (Horizontal)');
  const unknown = sortSizes(PRINT_SIZES, 'print', null);
  assert.equal(unknown[0], '16″ x 16″', 'no picture: square first');
});

test('coloursOf keeps Printify\'s order and only colours that can be bought', () => {
  eq(coloursOf(tee).map((c) => c.name), ['Black', 'Heather Grey', 'Navy']);
  assert.equal(coloursOf(tee)[0].hex, '#000000');
  eq(coloursOf(print), []);
});

test('sizesFor a colour leaves out what that colour does not come in', () => {
  eq(sizesFor(tee, 'Navy', 'tee'), ['S', 'M', 'L', 'XL', '2XL', '3XL']);
  eq(sizesFor(tee, 'Black', 'tee'), ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL']);
  eq(sizesFor(print, null, 'print', 'vertical').slice(0, 2), ['8" x 12" (Vertical)', '11″ x 14″ (Vertical)']);
});

test('reconcile: nothing chosen gives the first colour and a medium', () => {
  const c = reconcile(tee, {}, 'tee');
  assert.equal(c.color, 'Black');
  assert.equal(c.size, 'M');
  assert.equal(c.variant?.title, 'Black / M');
});

test('reconcile: a size the new colour lacks falls to the usual size, never an invalid pair', () => {
  const c = reconcile(tee, { color: 'Navy', size: 'XS' }, 'tee');
  assert.equal(c.color, 'Navy');
  assert.equal(c.size, 'M');
  assert.ok(c.variant && c.variant.available);
  assert.equal(pickVariant(tee, 'Navy', 'XS'), null);
});

test('reconcile: a kept pair stays; the tote has one size; a print has no colour and takes the orientation\'s first size', () => {
  assert.equal(reconcile(tee, { color: 'Heather Grey', size: '2XL' }, 'tee').variant?.title, 'Heather Grey / 2XL');
  const t = reconcile(tote, { color: 'Natural' }, 'tote');
  assert.equal(t.size, 'One size');
  assert.equal(t.variant?.id, 901);
  const p = reconcile(print, {}, 'print', 'horizontal');
  assert.equal(p.color, null);
  assert.equal(p.size, '10″ x 8″ (Horizontal)');
});

test('money: the price follows the variant; "from" is the lowest buyable; shipping is first + additional', () => {
  assert.equal(formatMoney(1799), '$17.99');
  assert.equal(formatMoney(null), '$0.00');
  assert.equal(fromCents(tee), 1799);
  assert.equal(fromCents([]), null);
  assert.equal(shippingCents({ shipping_first_cents: 495, shipping_additional_cents: 240 }, 1), 495);
  assert.equal(shippingCents({ shipping_first_cents: 495, shipping_additional_cents: 240 }, 3), 975);
  assert.equal(shippingCents({ shipping_first_cents: 495, shipping_additional_cents: 240 }, 99), 495 + 240 * 9);
  assert.equal(clampQuantity(0), 1);
  assert.equal(clampQuantity(12), 10);
  assert.equal(clampQuantity(2.7), 2);
});

test('mockupFor: the variant\'s own front, else the default, else the first; none before Printify has drawn', () => {
  const mockups = [
    { src: 'a-back', variant_ids: [1, 2], position: 'back', is_default: false },
    { src: 'a-front', variant_ids: [1, 2], position: 'front', is_default: false },
    { src: 'default', variant_ids: [9], position: 'front', is_default: true },
  ];
  assert.equal(mockupFor(mockups, 1), 'a-front');
  assert.equal(mockupFor(mockups, 77), 'default');
  assert.equal(mockupFor([{ src: 'only', variant_ids: [], position: 'front', is_default: false }], 1), 'only');
  assert.equal(mockupFor([], 1), null);
  assert.equal(mockupFor(null, null), null);
});

test('reusableByKey: the newest product per blueprint made since the bench item last changed; failed ones never', () => {
  const products = [
    { id: 'old', blueprint_key: 'tee', status: 'ready', created_at: '2026-10-10T10:00:00Z' },
    { id: 'new', blueprint_key: 'tee', status: 'ready', created_at: '2026-10-14T10:00:00Z' },
    { id: 'bad', blueprint_key: 'tote', status: 'failed', created_at: '2026-10-14T11:00:00Z' },
    { id: 'rendering', blueprint_key: 'print', status: 'rendering', created_at: '2026-10-14T12:00:00Z' },
  ];
  const m = reusableByKey(products, '2026-10-12T00:00:00Z');
  assert.equal(m.get('tee')?.id, 'new');
  assert.equal(m.has('tote'), false);
  assert.equal(m.get('print')?.id, 'rendering');
  assert.equal(reusableByKey(products, '2026-10-15T00:00:00Z').size, 0, 'the item changed after every make');
  assert.equal(reusableByKey(products, null).get('tee')?.id, 'new');
});

test('wording', () => {
  assert.equal(productNoun('tee'), 'A tee');
  assert.equal(productNoun('mug', 'Mug'), 'A mug');
  assert.match(orderStatusSentence({ status: 'placed', tracking: [] }), /on hold/);
  assert.equal(orderStatusSentence({ status: 'shipped', tracking: [{ carrier: 'USPS', number: '9400' }] }), 'Shipped with USPS, tracking 9400.');
  assert.equal(orderStatusSentence({ status: 'shipped', tracking: [] }), 'Shipped.');
  assert.match(orderStatusSentence({ status: 'pending', tracking: [] }), /Nothing was charged/);
  assert.equal(orderStillMoving('paid'), true);
  assert.equal(orderStillMoving('placed'), false);
});

test('the way back from Stripe: read and strip the two parameters, keep the rest', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  eq(readMerchReturn(`?page=29&merch=paid&order=${id}`), { kind: 'paid', orderId: id });
  eq(readMerchReturn('?merch=cancel&order=nonsense'), { kind: 'cancel', orderId: null });
  assert.equal(readMerchReturn('?merch=other'), null);
  assert.equal(readMerchReturn(''), null);
  assert.equal(stripMerchReturn(`?page=29&merch=paid&order=${id}`), '?page=29');
  assert.equal(stripMerchReturn(`?merch=paid&order=${id}`), '');
});

console.log(`merch-sheet: ${n} tests passed`);
