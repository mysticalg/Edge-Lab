import test from 'node:test';
import assert from 'node:assert/strict';
import { KrakenPaper, newAccount, settings, DEFAULTS, validateAccount } from '../kraken-paper.mjs';
const at = Date.UTC(2026, 8, 25, 10);
function fixture() {
  const e = new KrakenPaper();
  e.connected = e.online = true;
  for (const symbol of ['BTC/GBP', 'ETH/GBP', 'SOL/GBP']) e.metadata[symbol] = { orderMin: .00001, costMin: .43, lotDecimals: 8, status: 'online', at };
  quote(e, at); return e;
}
function quote(e, now, { ask = 100, bid = 99.9, askQty = 100, bidQty = 100 } = {}) {
  e.healthAt = now;
  e.receive({ channel: 'ticker', type: 'update', data: [{ symbol: 'BTC/GBP', ask, bid, ask_qty: askQty, bid_qty: bidQty, timestamp: new Date(now).toISOString() }] }, now);
}
function buy(e, now = at) { e.request('BTC/GBP', 'manual', now); e.step(now + 250); return e.account.trades[0]; }
test('Kraken buy waits for latency, reprices at execution and reconciles cash after both fees', () => {
  const e = fixture(); e.request('BTC/GBP', 'manual', at); e.step(at + 249);
  assert.equal(e.account.trades.length, 0);
  quote(e, at + 250, { ask: 102, bid: 101.9 }); e.step(at + 250);
  const t = e.account.trades[0];
  assert.equal(t.entryPrice, 102 * 1.0005); assert.ok(t.entryFee > .19);
  assert.ok(t.totalCost <= 25); assert.equal(e.account.cash, 1000 - t.totalCost);
  e.close(t.id); e.step(at + 300); assert.equal(t.status, 'open');
  quote(e, at + 550, { ask: 102, bid: 101.9 }); e.step(at + 550);
  assert.equal(t.status, 'closed'); assert.ok(t.realizedNet < -.39);
  assert.ok(Math.abs(e.account.cash - (1000 + t.realizedNet)) < 1e-9);
  validateAccount(JSON.parse(JSON.stringify(e.account)));
});
test('Kraken rejects full-size buys that no longer fit best ask after latency', () => {
  const e = fixture(); e.request('BTC/GBP', 'manual', at);
  quote(e, at + 250, { askQty: .001 }); e.step(at + 250);
  assert.equal(e.account.trades.length, 0); assert.equal(e.account.cash, 1000);
  assert.match(e.account.lastAction, /Insufficient displayed/);
});
test('Stale or thin exits stay open with unavailable equity; fresh depth allows exit', () => {
  const e = fixture(), t = buy(e);
  e.close(t.id); e.step(at + 300);
  quote(e, at + 550, { bidQty: .0001 }); e.step(at + 550);
  assert.equal(t.status, 'open'); assert.match(t.exitBlocked, /Exit blocked/); assert.equal(e.view(at + 550).equity, null);
  quote(e, at + 11000); e.healthAt = at; e.step(at + 11000);
  assert.equal(t.status, 'open');
  quote(e, at + 12000); e.step(at + 12000);
  assert.equal(t.status, 'closed'); assert.equal(t.exitBlocked, null);
});
test('Profit target uses net bid after sell fees and buffers', () => {
  const e = fixture(), t = buy(e);
  quote(e, at + 1000, { bid: 104, ask: 104.1 }); e.step(at + 1000);
  assert.equal(t.exitReason, 'Net profit target'); assert.equal(t.status, 'open');
  e.step(at + 1250); assert.equal(t.status, 'closed'); assert.ok(t.realizedNet >= .5);
});
test('Restart preserves open position and cash; pending entries cannot survive restart', () => {
  const e = fixture(), t = buy(e), cash = e.account.cash;
  e.account.pending = { symbol: 'ETH/GBP', dueAt: at };
  const restored = new KrakenPaper(JSON.parse(JSON.stringify(e.account)));
  assert.equal(restored.account.pending, null); assert.equal(restored.account.cash, cash);
  assert.equal(restored.account.trades[0].id, t.id); assert.equal(restored.view(at).equity, null);
  restored.step(at + 1000000); assert.equal(restored.account.trades[0].status, 'open');
});
test('Disconnect invalidates quotes and cancels a queued buy', () => {
  const e = fixture(); e.request('BTC/GBP', 'manual', at); e.disconnect(); e.step(at + 300);
  assert.equal(e.account.pending, null); assert.equal(e.account.trades.length, 0);
  assert.throws(() => e.request('BTC/GBP', 'manual', at + 1000), /fresh/);
});
test('Trend entries require complete history and short-term confirmation; execute after latency', () => {
  const e = fixture(); Object.assign(e.account.settings, { autoEnabled: true, lookbackSec: 900, momentumBps: 50 });
  for (let i = 0; i < 900; i++) {
    quote(e, at + i * 1000, { ask: 100 + i / 1000, bid: 99.9 + i / 1000 }); e.step(at + i * 1000);
  }
  assert.equal(e.account.pending, null);
  quote(e, at + 900000, { ask: 100.9, bid: 100.8 }); e.step(at + 900000);
  assert.equal(e.account.pending.mode, 'auto trend');
  e.step(at + 900250); assert.equal(e.account.trades[0].mode, 'auto trend');
});
test('A fading trend, excessive spread, and fee-sized stop each block auto entry', () => {
  const e = fixture(); e.account.settings.lookbackSec = 60;
  e.history['BTC/GBP'] = Array.from({length:61}, (_, i) => ({ at: at + i * 1000, price: 100 }));
  quote(e, at + 60000, { ask: 99.9, bid: 99.8 });
  assert.equal(e.scan(at + 60000)[0].eligible, false);
  quote(e, at + 60000, { ask: 103, bid: 102 });
  assert.match(e.scan(at + 60000)[0].reason, /Spread/);
  quote(e, at + 60000, { ask: 103, bid: 102.99 }); e.account.settings.stopLoss = .1;
  assert.match(e.scan(at + 60000)[0].reason, /Fees/);
});
test('Sparse history does not create an automatic signal and target includes all costs', () => {
  const e = fixture(); e.account.settings.lookbackSec = 60;
  e.history['BTC/GBP'] = [{ at, price: 100 }];
  quote(e, at + 60000, { ask: 101, bid: 100.99 });
  const row = e.scan(at + 60000)[0];
  assert.match(row.reason, /coverage/); assert.equal(row.eligible, false);
  assert.ok(row.targetRiseBps > row.breakEvenBps); assert.ok(row.initialLoss > .39);
});
test('Metadata restrictions, bad input and inconsistent ledgers fail closed', () => {
  const e = fixture(); e.metadata['BTC/GBP'].status = 'cancel_only';
  assert.throws(() => e.request('BTC/GBP', 'manual', at), /metadata/);
  assert.throws(() => settings({ ...DEFAULTS, feePct: -1 }), /feePct/);
  assert.throws(() => settings({ ...DEFAULTS, spend: '25' }), /spend/);
  const account = newAccount(); account.cash = 900; assert.throws(() => validateAccount(account), /reconciliation/);
  assert.throws(() => quote(e, at + 1000, { ask: 90, bid: 100 }), /Invalid/);
  assert.throws(() => e.receive({ method: 'subscribe', success: false, error: 'Unknown pair' }, at), /Unknown pair/);
});
test('Older full ticker frames are ignored without reconnecting or refreshing quote age', () => {
  const e = fixture(); quote(e, at + 500);
  const accepted = e.quotes['BTC/GBP'];
  e.receive({ channel: 'ticker', type: 'update', data: [{ symbol: 'BTC/GBP', bid: 90, ask: 91, bid_qty: 100, ask_qty: 100, timestamp: new Date(at + 100).toISOString() }] }, at + 1000);
  assert.equal(e.quotes['BTC/GBP'], accepted); assert.equal(e.connected, true);
  e.healthAt = at + 12000; assert.equal(e.fresh('BTC/GBP', at + 12000), false);
});
