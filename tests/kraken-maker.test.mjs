import test from 'node:test';
import assert from 'node:assert/strict';
import { KrakenMaker, newMakerAccount, makerCandidates, makerSettings, validateMakerAccount } from '../kraken-maker.mjs';
import { extractKrakenFees } from '../kraken-fees.mjs';

const NOW = 100000;
function fixture() {
  const prices = { 'BTC/GBP': [100, 101], 'ETH/GBP': [10.3, 10.4], 'ETH/BTC': [.0999, .1], 'SOL/GBP': [5, 5.1], 'SOL/BTC': [.0499, .05] };
  const engine = { quotes: {}, metadata: {}, accountFees: {}, makerFees: {}, feesCheckedAt: NOW, quoteGuard: () => null };
  for (const [symbol, [bid, ask]] of Object.entries(prices)) {
    engine.quotes[symbol] = { bid, ask, bidQty: symbol === 'BTC/GBP' ? .01 : 1000, askQty: 1000, at: NOW };
    engine.metadata[symbol] = { lotDecimals: 8, orderMin: .00001, costMin: .001 };
    engine.accountFees[symbol] = .1; engine.makerFees[symbol] = .05;
  }
  const account = newMakerAccount(), maker = new KrakenMaker(engine, account);
  account.settings.autoEnabled = true;
  maker.tradeReady.add('BTC/GBP');
  return { engine, account, maker };
}
function start(f) {
  const row = makerCandidates(f.engine, f.account.settings, NOW).find(r => r.assets[1] === 'BTC' && r.assets[2] === 'ETH');
  assert.ok(row.net > .1);
  const order = f.maker.request(row.route, NOW); f.maker.step(NOW + 250);
  assert.equal(order.status, 'resting'); return order;
}
function trade(f, qty, now = NOW + 1500, extra = {}) {
  return f.maker.receive({ channel: 'trade', type: 'update', data: [{ symbol: 'BTC/GBP', side: 'sell', qty, price: 100, trade_id: now, timestamp: new Date(now).toISOString(), ...extra }] }, now);
}
test('maker and taker fees are parsed separately; missing, empty and negative rates stay unknown', () => {
  const r = extractKrakenFees({ fees: { XXBTZGBP: { fee: '.8' }, SOLGBP: { fee: null } }, fees_maker: { XXBTZGBP: { fee: '.25' }, ETHGBP: { fee: '' }, SOLGBP: { fee: '-.1' } } });
  assert.deepEqual(r, { feePctByPair: { 'BTC/GBP': .8 }, makerFeePctByPair: { 'BTC/GBP': .25 } });
});
test('conditional route scans use maker then two taker fees without modifying cash', () => {
  const f = fixture(), before = JSON.stringify(f.account), rows = makerCandidates(f.engine, f.account.settings, NOW);
  assert.equal(rows.length, 4); assert.deepEqual(rows[0].legs.map(l => l.liquidity), ['maker', 'taker', 'taker']);
  assert.equal(JSON.stringify(f.account), before);
});
test('stale or missing fees, thin conversion depth and order minimums block candidate routes', () => {
  const f = fixture(); f.engine.makerFees = {};
  assert.ok(makerCandidates(f.engine, f.account.settings, NOW).every(r => r.net === null));
  f.engine.makerFees['BTC/GBP'] = .05; f.engine.feesCheckedAt = NOW - 3600001;
  assert.ok(makerCandidates(f.engine, f.account.settings, NOW).every(r => r.net === null));
  f.engine.feesCheckedAt = NOW; f.engine.quotes['ETH/BTC'].askQty = 0;
  assert.match(makerCandidates(f.engine, f.account.settings, NOW).find(r => r.assets[1] === 'BTC' && r.assets[2] === 'ETH').status, /liquidity/);
  f.engine.quotes['ETH/BTC'].askQty = 1000; f.engine.metadata['ETH/BTC'].orderMin = 100;
  assert.match(makerCandidates(f.engine, f.account.settings, NOW).find(r => r.assets[1] === 'BTC' && r.assets[2] === 'ETH').status, /minimum/);
});
test('no maker fill before activation or from a bid touch, historical snapshot, buyer trade or replay', () => {
  const f = fixture(), o = start(f), cash = f.account.cash;
  f.engine.quotes['BTC/GBP'].bidQty = 0; f.maker.step(NOW + 260);
  assert.equal(o.filled, 0); assert.equal(o.queueAhead, .02);
  f.maker.receive({ channel: 'trade', type: 'snapshot', data: [{ symbol: 'BTC/GBP', price: 100, qty: 100, side: 'sell' }] }, NOW + 270);
  trade(f, 100, NOW + 280, { side: 'buy' });
  trade(f, 100, NOW + 290, { timestamp: new Date(NOW + 200).toISOString() });
  assert.equal(f.account.cash, cash);
  trade(f, .01); assert.equal(o.queueAhead, .01); assert.equal(o.filled, 0);
  trade(f, .01); assert.equal(o.queueAhead, .01);
});
test('changed quote or fees during order latency cancels without a fill', () => {
  const f = fixture(), row = makerCandidates(f.engine, f.account.settings, NOW)[0];
  f.maker.request(row.route, NOW); f.engine.quotes['BTC/GBP'].ask = 100;
  f.maker.step(NOW + 250); assert.equal(f.account.orders[0].status, 'cancelled'); assert.equal(f.account.cash, 1000);
});
test('partial maker fill debits actual quantity and accepts further fills during cancellation delay', () => {
  const f = fixture(), o = start(f); trade(f, .07);
  assert.ok(Math.abs(o.filled - .05) < 1e-10); assert.equal(o.status, 'cancelling');
  assert.ok(Math.abs(f.account.cash - (1000 - .05 * 100 * 1.0005)) < 1e-8);
  trade(f, .02, NOW + 1600); assert.ok(Math.abs(o.filled - .07) < 1e-10);
  const before = o.filled; trade(f, 100, NOW + 1750); assert.equal(o.filled, before);
  f.maker.step(NOW + 1750); assert.equal(o.status, 'partial'); assert.equal(f.maker.openCycle().phase, 'hedging');
  assert.ok(f.maker.view(NOW + 1750).reserved === 0);
});
test('full route converts on separate delayed ticks and reconciles net cash, fees and dust', () => {
  const f = fixture(), o = start(f); trade(f, 100);
  const c = f.maker.openCycle(); assert.equal(o.status, 'filled'); assert.equal(c.legs.length, 1);
  f.maker.step(NOW + 1749); assert.equal(c.legs.length, 1);
  f.maker.step(NOW + 1750); assert.equal(c.asset, 'ETH'); assert.equal(c.status, 'open');
  f.maker.step(NOW + 2000); assert.equal(c.status, 'closed'); assert.ok(c.realizedNet > 0);
  assert.ok(Math.abs(f.account.cash - 1000 - c.realizedNet) < 1e-7);
  assert.equal(c.rebates, 0); assert.ok(c.legs.every(l => l.fee > 0));
  assert.ok(Object.values(f.account.dust).every(n => n >= 0));
  validateMakerAccount(f.account);
});
test('disappearing hedge liquidity never fabricates proceeds; holdings block further entries', () => {
  const f = fixture(); start(f); trade(f, 100); f.engine.quotes['ETH/BTC'].askQty = 0;
  const cash = f.account.cash; f.maker.step(NOW + 1750);
  assert.equal(f.account.cash, cash); assert.equal(f.maker.openCycle().asset, 'BTC');
  assert.match(f.maker.openCycle().blocked, /liquidity/); assert.match(f.maker.entryBlock(NOW + 1000), /inventory/);
  assert.equal(f.maker.view(NOW + 1000).equity, null);
});
test('hedge timeout attempts direct GBP unwind and includes losing exits in realized results', () => {
  const f = fixture(); start(f); trade(f, 100); f.engine.quotes['ETH/BTC'].askQty = 0;
  f.maker.step(NOW + 1750); f.engine.quotes['BTC/GBP'].bidQty = 100; f.engine.quotes['BTC/GBP'].bid = 99;
  f.maker.step(NOW + 6600); const c = f.account.cycles[0];
  assert.equal(c.status, 'closed'); assert.equal(c.phase, 'unwinding'); assert.ok(c.realizedNet < 0);
  assert.ok(f.maker.view(NOW + 6600).realizedNet < 0); assert.ok(f.account.maxDrawdown > 0);
  validateMakerAccount(f.account);
});
test('tiny partial fills remain inventory if below conversion and liquidation minimums', () => {
  const f = fixture(); start(f); trade(f, .020001);
  f.maker.step(NOW + 1750); f.maker.step(NOW + 2000); f.maker.step(NOW + 6000);
  const c = f.maker.openCycle(); assert.ok(c.quantity > 0); assert.match(c.blocked, /minimum/);
  assert.equal(c.returnedGbp, 0); assert.equal(f.maker.view(NOW + 6000).equity, null);
});
test('disconnect cancels queue and preserves filled inventory; restart disarms without erasing holdings', () => {
  const f = fixture(); start(f); trade(f, .07); f.maker.reset('disconnect', NOW + 1510);
  assert.equal(f.maker.order(), undefined); assert.equal(f.maker.openCycle().phase, 'unwinding');
  const cash = f.account.cash;
  const restarted = new KrakenMaker(f.engine, JSON.parse(JSON.stringify(f.account)));
  assert.equal(restarted.account.cash, cash); assert.equal(restarted.account.settings.autoEnabled, false);
  assert.ok(restarted.openCycle().quantity > 0); validateMakerAccount(restarted.account);
});
test('stop retains cancellation latency; manual unwind closes only with fresh fees and bids', () => {
  const f = fixture(), o = start(f); trade(f, .07); f.account.settings.autoEnabled = false; f.maker.unwind(NOW + 1550);
  assert.equal(o.status, 'cancelling'); f.maker.step(NOW + 1750);
  f.engine.quotes['BTC/GBP'].bidQty = 100; f.engine.feesCheckedAt = NOW - 3600001;
  f.maker.step(NOW + 2000); assert.match(f.maker.openCycle().blocked, /fee/);
  f.engine.feesCheckedAt = NOW; f.maker.step(NOW + 2100);
  assert.equal(f.account.cycles[0].status, 'closed'); assert.ok(f.account.cycles[0].realizedNet < 0);
});
test('invalid settings, unknown subscriptions and insufficient cash cannot create a paper order', () => {
  const f = fixture(); assert.throws(() => makerSettings({ ...f.account.settings, latencyMs: 0 }));
  const row = makerCandidates(f.engine, f.account.settings, NOW)[0];
  f.maker.tradeReady.clear(); assert.throws(() => f.maker.request(row.route, NOW), /subscription/);
  f.maker.tradeReady.add('BTC/GBP'); f.account.cash = 1; assert.throws(() => f.maker.request(row.route, NOW), /GBP/);
});
test('corrupt ledger reconciliation fails instead of replacing existing paper history', () => {
  const a = newMakerAccount(); a.cash = 999; assert.throws(() => validateMakerAccount(a), /reconciliation/);
});
test('stale or out-of-order trade prints never consume queue', () => {
  const f = fixture(), o = start(f);
  trade(f, 100, NOW + 1500, { timestamp: new Date(NOW - 5000).toISOString() });
  trade(f, 100, NOW + 1500, { timestamp: new Date(NOW + 2501).toISOString() });
  assert.equal(o.queueAhead, .02); assert.equal(o.filled, 0);
  trade(f, .005, NOW + 1600); trade(f, 100, NOW + 1700, { trade_id: NOW + 1599 });
  assert.ok(Math.abs(o.queueAhead - .015) < 1e-10); assert.equal(o.filled, 0);
});
test('a delayed timer does not allow trades after the expiry cancellation window', () => {
  const f = fixture(), o = start(f);
  trade(f, 100, o.expiresAt + o.rules.latencyMs + 1);
  assert.equal(o.filled, 0); assert.equal(f.account.cash, 1000);
});
test('daily realized losses stop new routes; existing inventory remains accounted for', () => {
  const f = fixture();
  f.account.cycles.push({ status: 'closed', closedAt: NOW, realizedNet: -10 });
  assert.match(f.maker.entryBlock(NOW + 1000), /daily/);
});
test('clock uncertainty excludes early trades while allowing a small exchange clock lead later', () => {
  const f = fixture(), o = start(f);
  trade(f, 100, NOW + 1000, { timestamp: new Date(NOW + 1200).toISOString() });
  assert.equal(o.filled, 0);
  trade(f, .07, NOW + 1500, { timestamp: new Date(NOW + 1700).toISOString() });
  assert.ok(Math.abs(o.filled - .05) < 1e-10);
});
test('corrupt maker order quantities and fabricated entry costs fail ledger validation', () => {
  const f = fixture(); start(f); trade(f, .07);
  const badOrder = structuredClone(f.account); badOrder.orders[0].quantity = NaN;
  assert.throws(() => validateMakerAccount(badOrder), /order history/);
  const badCost = structuredClone(f.account); badCost.cycles[0].spent += 1; badCost.cash -= 1;
  assert.throws(() => validateMakerAccount(badCost), /entry cost/);
});
