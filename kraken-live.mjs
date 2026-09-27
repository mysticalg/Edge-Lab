import { randomUUID } from 'node:crypto';

export const LIVE_LIMITS = Object.freeze({ perOrderGbp: 25, dailyBuyGbp: 25, priceBufferBps: 10 });
export const REQUIRED_PERMISSIONS = ['query-funds', 'query-open-trades', 'query-closed-trades', 'modify-trades'];
const PAIRS = { 'BTC/GBP': 'XBTGBP', 'ETH/GBP': 'ETHGBP', 'SOL/GBP': 'SOLGBP' };
const FINAL = new Set(['closed', 'canceled', 'expired', 'rejected']);
export function liveQuote({ symbol, side, budget }, engine, account, now = Date.now()) {
  if (!PAIRS[symbol] || !['buy', 'sell'].includes(side) || typeof budget !== 'number' || !Number.isFinite(budget) || budget < 5 || budget > LIVE_LIMITS.perOrderGbp) throw Error('Choose a supported pair, buy/sell, and a £5–£25 budget');
  if (!account.connected || !account.checkedAt || now - account.checkedAt > 15000) throw Error('Refresh Kraken account access first');
  if (!REQUIRED_PERMISSIONS.every(p => account.permissions?.includes(p))) throw Error('API key needs Query funds, Query open/closed orders, and Create & modify orders');
  const guard = engine.quoteGuard(symbol, now); if (guard) throw Error(guard);
  const q = engine.quotes[symbol], meta = engine.metadata[symbol], feePct = account.feePctByPair[symbol];
  if (now - q.at > 2000 || !Number.isFinite(feePct) || feePct < 0 || feePct > 2) throw Error('Fresh quote and verified fee rate required');
  if (!(meta.tickSize > 0) || !Number.isInteger(meta.pairDecimals)) throw Error('Price precision metadata unavailable');
  const rawPrice = (side === 'buy' ? q.ask * 1.001 : q.bid * .999) / meta.tickSize;
  const limitPrice = Number(((side === 'buy' ? Math.ceil(rawPrice) : Math.floor(rawPrice)) * meta.tickSize).toFixed(meta.pairDecimals));
  const feeRate = feePct / 100, scale = 10 ** meta.lotDecimals;
  // Reserve a penny for exchange fee rounding in addition to the verified fee.
  const quantity = Math.floor((side === 'buy' ? (budget - .01) / (limitPrice * (1 + feeRate)) : budget / limitPrice) * scale) / scale;
  const notional = quantity * limitPrice, feeEstimate = notional * feeRate;
  if (quantity < meta.orderMin || notional < meta.costMin) throw Error('Amount is below Kraken order minimums');
  if (quantity > (side === 'buy' ? q.askQty : q.bidQty)) throw Error('Insufficient displayed best-level quantity for this order');
  const maxDebit = notional + feeEstimate + .01;
  if (side === 'buy' && !(account.available?.GBP >= maxDebit)) throw Error('Insufficient available GBP in Kraken for this buy');
  if (side === 'sell' && !(account.available?.[symbol.split('/')[0]] >= quantity * (1 + feeRate))) throw Error('Insufficient available crypto, including a reserve if fees are charged in crypto');
  return { symbol, side, budget, quantity, limitPrice, feePct, feeEstimate, maxDebit: side === 'buy' ? maxDebit : null, estimatedNetProceeds: side === 'sell' ? notional - feeEstimate : null, quotedBid: q.bid, quotedAsk: q.ask, quoteAt: q.at,
    payload: { pair: PAIRS[symbol], type: side, ordertype: 'limit', timeinforce: 'IOC', oflags: 'fciq', volume: quantity.toFixed(meta.lotDecimals), price: limitPrice.toFixed(meta.pairDecimals) } };
}
export class KrakenLive {
  constructor({ reader, engine, journal = { version: 1, orders: [] }, save, now = Date.now }) {
    if (journal.version !== 1 || !Array.isArray(journal.orders) || journal.orders.some(o => !o.id || !PAIRS[o.symbol] || !['buy', 'sell'].includes(o.side) || !Number.isFinite(o.budget) || o.budget < 5 || o.budget > 25 || !['submitting', 'unknown', 'submitted', 'pending', 'open', ...FINAL].includes(o.status))) throw Error('Invalid Kraken live journal; refusing to reset it');
    Object.assign(this, { reader, engine, journal, save, now });
    this.previews = new Map(); this.armedUntil = 0; this.busy = false; this.persistenceError = null; this.error = null;
    for (const o of journal.orders) if (o.status === 'submitting') { o.status = 'unknown'; o.error = 'Restart during submission; reconcile before continuing'; }
  }
  async persist() {
    try { await this.save(this.journal); }
    catch { this.persistenceError = 'Live journal could not be saved. New orders are blocked; use Kraken to manage existing orders.'; this.armedUntil = 0; throw Error(this.persistenceError); }
  }
  view() { return { limits: LIVE_LIMITS, armed: this.armedUntil > this.now(), armedUntil: this.armedUntil, busy: this.busy, error: this.persistenceError || this.error, orders: this.journal.orders }; }
  arm(enabled) { this.armedUntil = enabled ? this.now() + 600000 : 0; if (!enabled) this.previews.clear(); }
  guard(requireArmed = true) {
    if (this.persistenceError) throw Error(this.persistenceError);
    if (requireArmed && this.armedUntil <= this.now()) throw Error('Enable manual live orders first; the switch expires after 10 minutes');
    if (this.journal.orders.some(o => !FINAL.has(o.status))) throw Error('An order is unresolved. Refresh order status before submitting another');
  }
  dailyGuard(p) {
    const midnight = new Date(this.now()).setUTCHours(0, 0, 0);
    const used = this.journal.orders.filter(o => o.side === 'buy' && o.submittedAt >= midnight && o.status !== 'rejected').reduce((n, o) => n + o.budget, 0);
    if (p.side === 'buy' && used + p.budget > LIVE_LIMITS.dailyBuyGbp + 1e-8) throw Error('Initial £25 daily buy-submission limit reached (UTC), including canceled and uncertain submissions');
  }
  async exclusive(fn) {
    if (this.busy) throw Error('A live account operation is already in progress');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  async preview(input) {
    return this.exclusive(async () => {
      this.guard(false); await this.reader.refresh(true);
      const p = liveQuote(input, this.engine, this.reader.status, this.now()); this.dailyGuard(p);
      // Validation only: this request cannot enter the matching engine.
      await this.reader.call('AddOrder', { ...p.payload, validate: 'true' });
      this.guard(false);
      p.id = randomUUID(); p.expiresAt = this.now() + 30000;
      this.previews.clear(); this.previews.set(p.id, p);
      const { payload, ...view } = p; return view;
    });
  }
  async submit(id, confirmation) {
    return this.exclusive(async () => {
      // A repeated request for the same preview never sends a second AddOrder.
      const existing = this.journal.orders.find(o => o.id === id); if (existing) return existing;
      this.guard();
      const p = this.previews.get(id);
      if (!p || p.expiresAt < this.now()) throw Error('Preview expired; request a new preview');
      if (confirmation !== `${p.side.toUpperCase()} ${p.symbol}`) throw Error('Type the exact confirmation shown in the order preview');
      await this.reader.refresh(true); this.guard(); this.dailyGuard(p);
      const current = liveQuote(p, this.engine, this.reader.status, this.now());
      if (p.expiresAt < this.now() || current.feePct > p.feePct || (p.side === 'buy' ? current.quotedAsk > p.limitPrice : current.quotedBid < p.limitPrice)) throw Error('Quote or fee changed; request a new preview');
      const q = this.engine.quotes[p.symbol];
      if (p.quantity > (p.side === 'buy' ? q.askQty : q.bidQty)) throw Error('Depth changed; request a new preview');
      if (p.side === 'buy' ? this.reader.status.available.GBP < p.maxDebit : this.reader.status.available[p.symbol.split('/')[0]] < p.quantity * (1 + p.feePct / 100)) throw Error('Available balance changed; request a new preview');
      const { payload, ...quote } = p;
      const order = { ...quote, clientId: randomUUID(), submittedAt: this.now(), status: 'submitting' };
      this.journal.orders.unshift(order); this.previews.delete(id);
      await this.persist(); // Durable intent precedes the network side effect.
      if (this.armedUntil <= this.now()) {
        order.status = 'rejected'; order.error = 'Live controls disabled before dispatch; no order sent'; await this.persist(); return order;
      }
      try {
        const result = await this.reader.call('AddOrder', { ...payload, cl_ord_id: order.clientId, deadline: new Date(this.now() + 10000).toISOString() });
        if (!Array.isArray(result?.txid) || result.txid.length !== 1) throw Error('No unambiguous order ID returned');
        order.txid = result.txid[0]; order.status = 'submitted';
      } catch (error) {
        order.status = error.rejected ? 'rejected' : 'unknown';
        order.error = error.rejected ? error.message : 'Submission result unknown. Never retry automatically; reconcile with Kraken.';
      }
      await this.persist(); return order;
    });
  }
  apply(order, txid, result) {
    const pair = result?.descr?.pair?.replace('/', '').replace('XBT', 'BTC');
    const identityMatches = result?.cl_ord_id ? result.cl_ord_id === order.clientId : txid === order.txid && pair === order.symbol.replace('/', '') && result?.descr?.type === order.side && Math.abs(Number(result?.vol) - order.quantity) < 1e-8;
    if (!result || !identityMatches || !['pending', 'open', 'closed', 'canceled', 'expired'].includes(result.status)) throw Error('Kraken order identity or status could not be verified');
    const quantity = Number(result.vol_exec), cost = Number(result.cost), fee = Number(result.fee);
    if (![quantity, cost, fee].every(n => Number.isFinite(n) && n >= 0) || quantity > order.quantity + 1e-8) throw Error('Invalid executed quantity or order totals');
    Object.assign(order, { txid, status: result.status, filledQuantity: quantity, executedCost: cost, reportedFee: fee, checkedAt: this.now(), error: null });
  }
  async reconcile() {
    return this.exclusive(async () => {
      this.error = null;
      for (const order of this.journal.orders.filter(o => !FINAL.has(o.status))) {
        try {
          if (order.txid) {
            const result = await this.reader.call('QueryOrders', { txid: order.txid }); this.apply(order, order.txid, result?.[order.txid]);
          } else {
            const open = await this.reader.call('OpenOrders');
            const closed = await this.reader.call('ClosedOrders', { start: Math.floor(order.submittedAt / 1000) - 60, closetime: 'close' });
            const match = Object.entries({ ...open?.open, ...closed?.closed }).filter(([, value]) => value.cl_ord_id === order.clientId);
            if (match.length !== 1) throw Error('Uncertain submission is not uniquely found in recent Kraken order history. Check Kraken directly; new orders remain blocked.');
            this.apply(order, ...match[0]);
          }
          await this.persist();
        } catch (error) { order.error = error.message; this.error = error.message; }
      }
      return this.view();
    });
  }
}
