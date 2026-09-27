import test from 'node:test';
import assert from 'node:assert/strict';
import { KrakenLive, liveQuote, REQUIRED_PERMISSIONS } from '../kraken-live.mjs';
const at = Date.UTC(2026, 8, 25, 10);
function fixture(options = {}) {
  let clock = at; const calls = [], snapshots = [];
  const engine = { quoteGuard: () => null, quotes: { 'BTC/GBP': { bid: 100, ask: 100.1, bidQty: 100, askQty: 100, at } }, metadata: { 'BTC/GBP': { tickSize: .1, pairDecimals: 1, lotDecimals: 8, orderMin: .00005, costMin: .43 } } };
  const reader = { status: { connected: true, checkedAt: at, permissions: REQUIRED_PERMISSIONS, available: { GBP: 100, BTC: 1 }, feePctByPair: { 'BTC/GBP': .8 } },
    async refresh() { this.status.checkedAt = clock; engine.quotes['BTC/GBP'].at = clock; return this.status; },
    async call(method, params) { calls.push({ method, params }); return options.call ? options.call(method, params) : params?.validate === 'true' ? {} : { txid: ['KRAKEN-TEST-ID'] }; } };
  const live = new KrakenLive({ reader, engine, now: () => clock, save: async journal => { snapshots.push(structuredClone(journal)); if (options.save) await options.save(journal); } });
  live.arm(true);
  return { live, reader, engine, calls, snapshots, advance: n => { clock += n; } };
}
const input = { symbol: 'BTC/GBP', side: 'buy', budget: 5 };
test('live quote enforces funds, authenticated fees, permissions, freshness, precision and cap', () => {
  const f = fixture(); const p = liveQuote(input, f.engine, f.reader.status, at);
  assert.ok(p.maxDebit <= 5); assert.equal(p.payload.timeinforce, 'IOC'); assert.equal(p.payload.ordertype, 'limit'); assert.equal(p.payload.oflags, 'fciq'); assert.ok(p.limitPrice >= 100.1); assert.equal(p.payload.leverage, undefined);
  assert.throws(() => liveQuote({ ...input, budget: 26 }, f.engine, f.reader.status, at), /£5/);
  f.reader.status.available.GBP = 0; assert.throws(() => liveQuote(input, f.engine, f.reader.status, at), /Insufficient available GBP/);
  f.reader.status.available.GBP = 100; f.reader.status.permissions = []; assert.throws(() => liveQuote(input, f.engine, f.reader.status, at), /API key needs/);
  f.reader.status.permissions = REQUIRED_PERMISSIONS; f.reader.status.feePctByPair = {}; assert.throws(() => liveQuote(input, f.engine, f.reader.status, at), /verified fee/);
});
test('sell only uses owned available crypto with fee reserve', () => {
  const f = fixture(); f.reader.status.available.BTC = 0;
  assert.throws(() => liveQuote({ ...input, side: 'sell' }, f.engine, f.reader.status, at), /Insufficient available crypto/);
  f.reader.status.available.BTC = 1; const p = liveQuote({ ...input, side: 'sell' }, f.engine, f.reader.status, at);
  assert.equal(p.maxDebit, null); assert.ok(p.estimatedNetProceeds < 5); assert.ok(p.limitPrice <= 100);
});
test('preview validates only; submit requires typed confirmation, durable intent, and is idempotent', async () => {
  const f = fixture(); const p = await f.live.preview(input);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].params.validate, 'true'); assert.equal(f.live.journal.orders.length, 0);
  await assert.rejects(f.live.submit(p.id, 'yes'), /exact confirmation/); assert.equal(f.calls.length, 1);
  const order = await f.live.submit(p.id, 'BUY BTC/GBP');
  assert.equal(f.snapshots[0].orders[0].status, 'submitting'); assert.equal(order.status, 'submitted'); assert.equal(order.filledQuantity, undefined);
  assert.equal(f.calls[1].params.validate, undefined); assert.ok(f.calls[1].params.cl_ord_id);
  assert.equal(await f.live.submit(p.id, 'BUY BTC/GBP'), order); assert.equal(f.calls.length, 2);
});
test('uncertain AddOrder response blocks further orders and cannot retry on restart', async () => {
  const f = fixture({ call: async (_method, params) => { if (params.validate === 'true') return {}; throw Error('timeout'); } });
  const p = await f.live.preview(input), order = await f.live.submit(p.id, 'BUY BTC/GBP');
  assert.equal(order.status, 'unknown'); await assert.rejects(f.live.preview(input), /unresolved/);
  const restored = new KrakenLive({ reader: f.reader, engine: f.engine, journal: structuredClone(f.live.journal), save: async () => {}, now: () => at });
  assert.equal(restored.view().armed, false); await restored.submit(p.id, 'BUY BTC/GBP'); assert.equal(f.calls.length, 2);
});
test('expired preview, disarmed mode, changed fees or balance cannot submit', async () => {
  let f = fixture(), p = await f.live.preview(input); f.advance(30001);
  await assert.rejects(f.live.submit(p.id, 'BUY BTC/GBP'), /expired/); assert.equal(f.calls.length, 1);
  f = fixture(); p = await f.live.preview(input); f.live.arm(false);
  await assert.rejects(f.live.submit(p.id, 'BUY BTC/GBP'), /Enable manual/);
  f = fixture(); p = await f.live.preview(input); f.reader.status.feePctByPair['BTC/GBP'] = 1;
  await assert.rejects(f.live.submit(p.id, 'BUY BTC/GBP'), /fee changed/); assert.equal(f.calls.length, 1);
  f = fixture(); p = await f.live.preview(input); f.reader.status.available.GBP = 0;
  await assert.rejects(f.live.submit(p.id, 'BUY BTC/GBP'), /Insufficient/); assert.equal(f.calls.length, 1);
});
test('journal write failure blocks dispatch; disables live control', async () => {
  const f = fixture({ save: async () => { throw Error('disk full'); } }), p = await f.live.preview(input);
  await assert.rejects(f.live.submit(p.id, 'BUY BTC/GBP'), /journal could not/);
  assert.equal(f.calls.length, 1); assert.equal(f.live.view().armed, false);
});
test('reconcile uses exchange-reported partial fills and verifies client identity', async () => {
  const f = fixture(); const p = await f.live.preview(input), order = await f.live.submit(p.id, 'BUY BTC/GBP');
  f.reader.call = async method => { assert.equal(method, 'QueryOrders'); return { [order.txid]: { cl_ord_id: order.clientId, status: 'canceled', vol_exec: '.01', cost: '1', fee: '.008' } }; };
  await f.live.reconcile(); assert.equal(order.status, 'canceled'); assert.equal(order.filledQuantity, .01); assert.equal(order.executedCost, 1);
  assert.throws(() => f.live.apply(order, order.txid, { cl_ord_id: 'wrong', status: 'closed' }), /identity/);
});
test('daily cap counts buy attempts conservatively; a sell can reduce holdings', async () => {
  const f = fixture(); const p = await f.live.preview({ ...input, budget: 25 }), order = await f.live.submit(p.id, 'BUY BTC/GBP');
  order.status = 'canceled'; await assert.rejects(f.live.preview(input), /daily buy/);
  const sell = await f.live.preview({ ...input, side: 'sell' }); assert.equal(sell.side, 'sell');
});
test('disarming while pre-dispatch persistence runs prevents network submission', async () => {
  let live; const f = fixture({ save: async () => { live.arm(false); } }); live = f.live;
  const p = await live.preview(input), order = await live.submit(p.id, 'BUY BTC/GBP');
  assert.equal(order.status, 'rejected'); assert.equal(f.calls.length, 1);
});
test('validation-only preview works with live submission off', async () => {
  const f = fixture(); f.live.arm(false); const p = await f.live.preview(input);
  assert.equal(f.calls[0].params.validate, 'true'); assert.equal(f.live.view().armed, false);
  await assert.rejects(f.live.submit(p.id, 'BUY BTC/GBP'), /Enable manual/);
});
test('known Kraken transaction ID can reconcile when client ID is omitted, only with matching order details', async () => {
  const f = fixture(), p = await f.live.preview(input), order = await f.live.submit(p.id, 'BUY BTC/GBP');
  const response = { status: 'closed', descr: { pair: 'XBTGBP', type: 'buy' }, vol: String(order.quantity), vol_exec: String(order.quantity), cost: '4.9', fee: '.04' };
  f.live.apply(order, order.txid, response); assert.equal(order.status, 'closed');
  assert.throws(() => f.live.apply(order, order.txid, { ...response, descr: { pair: 'ETHGBP', type: 'buy' } }), /identity/);
});
