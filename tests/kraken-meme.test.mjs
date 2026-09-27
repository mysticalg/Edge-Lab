import test from 'node:test';
import assert from 'node:assert/strict';
import { KrakenPaper, MEME_SYMBOLS } from '../kraken-paper.mjs';
test('Meme paper fills respect minimum quantity, pair fee and restart reconciliation', () => {
 const now = Date.now(), e = new KrakenPaper(); e.connected = e.online = true; e.healthAt = now;
 const symbol = 'PEPE/GBP'; assert.ok(MEME_SYMBOLS.includes(symbol));
 e.metadata[symbol] = { orderMin: 1500000, costMin: .43, lotDecimals: 0, status: 'online', at: now };
 e.receive({channel:'ticker',data:[{symbol,bid:.000003,ask:.00000301,bid_qty:50000000,ask_qty:50000000,timestamp:new Date(now).toISOString()}]}, now);
 e.accountFees[symbol] = .4; e.feesCheckedAt = now;
 e.request(symbol, 'auto trend', now); e.step(now+250);
 const t = e.account.trades[0]; assert.equal(t.rules.feePct,.4); assert.ok(t.quantity >= 1500000);
 assert.equal(e.view(now+250).comparison.find(x => x.category === 'Meme').open,1);
 new KrakenPaper(JSON.parse(JSON.stringify(e.account)));
 assert.equal(e.rulesFor(symbol, now+3600001).feePct,.8);
});
