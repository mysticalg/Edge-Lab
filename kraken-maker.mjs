// Paper only. This module has no credential reader or order-submission capability.
export const MAKER_DEFAULTS = Object.freeze({ autoEnabled: false, spend: 25, minNet: 0.10,
  bufferBps: 5, latencyMs: 250, orderSeconds: 30, hedgeSeconds: 5, lossLimit: 0.75 });
export const MAKER_BOUNDS = { spend: [5, 100], minNet: [0.01, 10], bufferBps: [0, 100],
  latencyMs: [100, 5000], orderSeconds: [5, 120], hedgeSeconds: [1, 60], lossLimit: [0.1, 10] };
export const MAKER_SYMBOLS = ['BTC/GBP', 'ETH/GBP', 'SOL/GBP'];
const ROUTES = ['ETH', 'SOL'].flatMap(coin => [
  ['GBP', 'BTC', coin, 'GBP'], ['GBP', coin, 'BTC', 'GBP'],
]);
const liveOrder = o => o && ['pending', 'resting', 'cancelling'].includes(o.status);
const nonnegative = x => Number.isFinite(x) && x >= 0;
const CLOCK_GUARD_MS = 1000;

export function makerSettings(input) {
  if (typeof input?.autoEnabled !== 'boolean') throw Error('Invalid maker paper switch');
  const result = { autoEnabled: input.autoEnabled };
  for (const [key, [min, max]] of Object.entries(MAKER_BOUNDS)) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw Error(`Invalid ${key}: use ${min}–${max}`);
    result[key] = value;
  }
  return result;
}
export function newMakerAccount() {
  return { version: 1, currency: 'GBP', startingCash: 1000, cash: 1000, settings: { ...MAKER_DEFAULTS },
    cycles: [], orders: [], dust: {}, lastEntryAt: 0, peakEquity: 1000, maxDrawdown: 0,
    lastAction: 'Paper experiment stopped. Check account fees, then start when ready.' };
}
export function validateMakerAccount(a) {
  if (a?.version !== 1 || a.currency !== 'GBP' || a.startingCash !== 1000 || !nonnegative(a.cash) ||
      !Array.isArray(a.cycles) || !Array.isArray(a.orders) || !a.dust || !nonnegative(a.peakEquity) || !nonnegative(a.maxDrawdown)) throw Error('Invalid maker paper ledger');
  a.settings = makerSettings(a.settings);
  let expected = 1000;
  for (const c of a.cycles) {
    if (!['open', 'closed'].includes(c.status) || !ROUTES.some(r => r.join('/') === c.assets?.join('/')) ||
        !nonnegative(c.spent) || !nonnegative(c.quantity) || !nonnegative(c.returnedGbp) ||
        !['GBP', 'BTC', 'ETH', 'SOL'].includes(c.asset) || !Array.isArray(c.legs) || !c.dust) throw Error('Invalid maker inventory');
    makerSettings(c.rules);
    if (!['entry', 'hedging', 'unwinding'].includes(c.phase) || !Number.isFinite(c.openedAt) ||
        Object.values(c.dust).some(q => !nonnegative(q)) ||
        c.legs.some(l => !nonnegative(l.fee) || !(l.quantity > 0) || !Number.isFinite(l.quantity) || !(l.price > 0) || !Number.isFinite(l.price))) throw Error('Invalid maker fill history');
    const entrySpent = c.legs.filter(l => l.liquidity === 'maker').reduce((n, l) => n + l.quantity * l.price + l.fee, 0);
    if (Math.abs(entrySpent - c.spent) > 1e-6) throw Error('Maker entry cost reconciliation failed');
    expected -= c.spent;
    expected += c.returnedGbp;
    if (c.status === 'closed' && (!Number.isFinite(c.realizedNet) || Math.abs(c.realizedNet - c.returnedGbp + c.spent) > 1e-7)) throw Error('Invalid maker P&L');
  }
  const ids = new Set();
  for (const o of a.orders) {
    if (!o.id || ids.has(o.id) || !MAKER_SYMBOLS.includes(o.symbol) ||
        !['pending', 'resting', 'cancelling', 'filled', 'partial', 'cancelled'].includes(o.status) ||
        !Number.isFinite(o.quantity) || o.quantity <= 0 || !Number.isFinite(o.price) || o.price <= 0 ||
        !nonnegative(o.filled) || o.filled > o.quantity + 1e-8 || !nonnegative(o.makerFeePct) || o.makerFeePct > 2 ||
        !Number.isFinite(o.requestedAt) || (o.queueAhead !== null && !nonnegative(o.queueAhead))) throw Error('Invalid maker order history');
    makerSettings(o.rules); ids.add(o.id);
    const filled = a.cycles.filter(c => c.orderId === o.id).flatMap(c => c.legs).filter(l => l.liquidity === 'maker').reduce((n, l) => n + l.quantity, 0);
    if (Math.abs(filled - o.filled) > 1e-8) throw Error('Maker filled quantity reconciliation failed');
  }
  if (a.cycles.some(c => !ids.has(c.orderId))) throw Error('Missing maker entry order');
  if (Math.abs(expected - a.cash) > 1e-6 || a.cycles.filter(c => c.status === 'open').length > 1 ||
      a.orders.filter(liveOrder).length > 1 || Object.values(a.dust).some(q => !nonnegative(q))) throw Error('Maker ledger reconciliation failed');
  return a;
}
function fee(e, symbol, kind, now) {
  const value = (kind === 'maker' ? e.makerFees : e.accountFees)?.[symbol];
  if (!e.feesCheckedAt || now < e.feesCheckedAt || now - e.feesCheckedAt >= 3600000 || !nonnegative(value) || value > 2)
    throw Error(`Fresh verified ${kind} fee required for ${symbol}`);
  return value;
}
function leg(e, from, to, amount, rules, now, maker = false) {
  const buy = from === 'GBP' || (from === 'BTC' && to !== 'GBP');
  const symbol = buy ? `${to}/${from}` : `${from}/${to}`;
  const blocked = e.quoteGuard(symbol, now); if (blocked) throw Error(`${symbol}: ${blocked}`);
  const q = e.quotes[symbol], meta = e.metadata[symbol], feePct = fee(e, symbol, maker ? 'maker' : 'taker', now);
  const buffer = rules.bufferBps / 10000;
  const price = maker ? q.bid : buy ? q.ask * (1 + buffer) : q.bid * (1 - buffer);
  if (!(price > 0) || (maker && !(q.ask > price))) throw Error(`${symbol}: post-only price would cross`);
  const scale = 10 ** meta.lotDecimals;
  const quantity = Math.floor((buy ? amount / (price * (1 + feePct / 100)) : amount) * scale) / scale;
  const notional = quantity * price, feeAmount = notional * feePct / 100;
  if (!(quantity > 0) || quantity < meta.orderMin || notional < meta.costMin) throw Error(`${symbol}: below order minimum`);
  if (!maker && quantity > (buy ? q.askQty : q.bidQty)) throw Error(`${symbol}: insufficient best-level liquidity`);
  const spent = buy ? notional + feeAmount : quantity;
  return { symbol, from, to, side: buy ? 'buy' : 'sell', quantity, price, feePct, fee: feeAmount,
    feeCurrency: symbol.split('/')[1], spent, output: buy ? quantity : notional - feeAmount,
    dust: Math.max(0, amount - spent), liquidity: maker ? 'maker' : 'taker', quoteAt: q.at };
}
export function makerCandidates(e, rules, now = Date.now()) {
  return ROUTES.map(assets => {
    const row = { route: assets.join(' → '), assets, budget: rules.spend, net: null, legs: [] };
    try {
      let amount = rules.spend, gbpDust = 0;
      for (let i = 0; i < 3; i++) {
        const next = leg(e, assets[i], assets[i + 1], amount, rules, now, i === 0);
        row.legs.push(next); amount = next.output;
        if (next.from === 'GBP') gbpDust += next.dust;
      }
      row.returnedGbp = amount + gbpDust; row.net = row.returnedGbp - rules.spend;
      row.status = row.net >= rules.minNet ? 'Conditional estimate meets threshold; maker fill required' : 'Below net threshold';
    } catch (error) { row.status = error.message; }
    return row;
  }).sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity));
}

export class KrakenMaker {
  constructor(engine, account = newMakerAccount()) {
    this.engine = engine; this.account = validateMakerAccount(account); this.tradeCount = 0; this.lastTradeAt = null;
    this.tradeReady = new Set(); this.tradeIds = new Map();
    // Orders cannot survive an observation gap. Inventory and locked trade rules do.
    this.reset('Server restarted; old paper quotes cancelled', Date.now());
    this.account.settings.autoEnabled = false;
  }
  openCycle() { return this.account.cycles.find(c => c.status === 'open'); }
  order() { return this.account.orders.find(liveOrder); }
  finishOrder(o, reason, now) {
    o.status = o.filled > 0 ? 'partial' : 'cancelled'; o.reason = reason; o.closedAt = now;
    const c = this.openCycle();
    if (c) { c.phase = 'hedging'; c.hedgeStartedAt ||= now; c.dueAt = now + c.rules.latencyMs; }
    this.account.lastAction = reason;
  }
  reset(reason, now = Date.now()) {
    this.tradeReady.clear(); this.tradeIds.clear();
    const o = this.order(); if (o) this.finishOrder(o, reason, now);
    const c = this.openCycle();
    if (c) { c.phase = 'unwinding'; c.dueAt = now + c.rules.latencyMs; c.reason = reason; }
    return Boolean(o || c);
  }
  cancel(reason, now = Date.now()) {
    const o = this.order(); if (!o) return false;
    if (o.status === 'pending') this.finishOrder(o, reason, now);
    else if (o.status !== 'cancelling') { o.status = 'cancelling'; o.cancelAt = now + o.rules.latencyMs; o.reason = reason; }
    return true;
  }
  unwind(now = Date.now()) {
    this.cancel('Stop requested; cancel remainder before unwind', now);
    const c = this.openCycle();
    if (c) { c.forceUnwind = true; c.reason = 'Manual unwind'; c.dueAt = now + c.rules.latencyMs; }
  }
  entryBlock(now) {
    if (this.order() || this.openCycle()) return 'One paper route at a time; existing inventory is being managed';
    if (now - this.account.lastEntryAt < 60000) return '60-second entry cooldown';
    const midnight = new Date(now).setUTCHours(0, 0, 0);
    const dayNet = this.account.cycles.filter(c => c.status === 'closed' && c.closedAt >= midnight).reduce((n, c) => n + c.realizedNet, 0);
    if (dayNet <= -10) return '£10 daily realized loss threshold reached (UTC)';
    if (this.account.cash < this.account.settings.spend) return 'Insufficient unreserved paper GBP';
    return null;
  }
  request(route, now = Date.now()) {
    const blocked = this.entryBlock(now); if (blocked) throw Error(blocked);
    const row = makerCandidates(this.engine, this.account.settings, now).find(r => r.route === route);
    if (!row || row.net === null || row.net < this.account.settings.minNet) throw Error(row?.status || 'Unknown route');
    const first = row.legs[0];
    if (!this.tradeReady.has(first.symbol)) throw Error('Waiting for Kraken trade subscription acknowledgement');
    const o = { id: crypto.randomUUID(), assets: row.assets, route, status: 'pending', requestedAt: now,
      dueAt: now + this.account.settings.latencyMs, rules: { ...this.account.settings },
      symbol: first.symbol, price: first.price, quantity: first.quantity, makerFeePct: first.feePct,
      filled: 0, queueAhead: null, estimatedNet: row.net, lastTradeId: 0 };
    this.account.orders.unshift(o); this.account.lastEntryAt = now;
    this.account.lastAction = 'Paper limit order waiting for modeled latency';
    return o;
  }
  activate(o, now) {
    try {
      const row = makerCandidates(this.engine, o.rules, now).find(r => r.route === o.route);
      const q = this.engine.quotes[o.symbol];
      if (!row || row.net === null || row.net < o.rules.minNet || !q || q.bid !== o.price || q.ask <= o.price ||
          !this.tradeReady.has(o.symbol) || row.legs[0].feePct !== o.makerFeePct) throw Error('Quote or fees changed during entry delay');
      o.status = 'resting'; o.activeAt = now; o.expiresAt = now + o.rules.orderSeconds * 1000;
      o.queueAhead = q.bidQty * 2; // Full visible queue plus a 100% uncertainty allowance.
      o.initialQueue = o.queueAhead;
      this.account.lastAction = 'Waiting for sell trades at the limit price to consume the queue';
    } catch (error) { this.finishOrder(o, error.message, now); }
  }
  receive(message, now = Date.now()) {
    if (message.method === 'subscribe' && message.result?.channel === 'trade') {
      if (message.success) this.tradeReady.add(message.result.symbol);
      return false;
    }
    // Snapshots are historical, not evidence of fills after our order arrived.
    if (message.channel !== 'trade' || message.type !== 'update') return false;
    let changed = false;
    for (const t of message.data || []) {
      const at = Date.parse(t.timestamp), id = t.trade_id;
      if (!MAKER_SYMBOLS.includes(t.symbol) || !Number.isSafeInteger(id) || id <= (this.tradeIds.get(t.symbol) || 0) ||
          !Number.isFinite(at) || now - at > 2000 || at > now + CLOCK_GUARD_MS || !(t.qty > 0) || !Number.isFinite(t.qty) || !(t.price > 0) || !Number.isFinite(t.price)) continue;
      this.tradeIds.set(t.symbol, id); this.tradeCount++; this.lastTradeAt = now;
      const o = this.order();
      // Timer scheduling cannot extend an expired order's fill window.
      if (o?.status === 'resting' && now >= o.expiresAt) {
        o.status = 'cancelling'; o.cancelAt = o.expiresAt + o.rules.latencyMs; o.reason = 'Limit order expired'; changed = true;
      }
      if (!o || !['resting', 'cancelling'].includes(o.status) || t.symbol !== o.symbol || t.side !== 'sell' ||
          at <= o.activeAt + CLOCK_GUARD_MS || now < o.activeAt + CLOCK_GUARD_MS ||
          (o.cancelAt && now >= o.cancelAt) || t.price !== o.price ||
          this.engine.quoteGuard(t.symbol, now)) continue;
      const used = Math.min(o.queueAhead, t.qty); o.queueAhead -= used; changed = true;
      const quantity = Math.min(o.quantity - o.filled, t.qty - used);
      o.lastTradeId = id;
      if (quantity <= 0) continue;
      const cost = quantity * o.price, entryFee = cost * o.makerFeePct / 100;
      if (cost + entryFee > this.account.cash + 1e-8) throw Error('Maker paper reserve invariant failed');
      let c = this.openCycle();
      if (!c) {
        c = { id: crypto.randomUUID(), orderId: o.id, assets: o.assets, route: o.route, status: 'open', phase: 'entry',
          openedAt: now, asset: o.assets[1], quantity: 0, spent: 0, returnedGbp: 0, nextLeg: 1,
          rules: { ...o.rules }, legs: [], dust: {}, reason: null, rebates: 0 };
        this.account.cycles.unshift(c);
      }
      o.filled += quantity; c.quantity += quantity; c.spent += cost + entryFee; this.account.cash -= cost + entryFee;
      c.legs.push({ at: now, symbol: o.symbol, side: 'buy', liquidity: 'maker', quantity, price: o.price,
        fee: entryFee, feePct: o.makerFeePct, feeCurrency: 'GBP', sourceTradeId: id });
      if (o.quantity - o.filled < 1e-12) {
        o.status = 'filled'; o.closedAt = now; c.phase = 'hedging'; c.hedgeStartedAt = now; c.dueAt = now + c.rules.latencyMs;
      } else this.cancel('Partial fill; cancelling remainder before hedging', now);
    }
    return changed;
  }
  mark(c, now) {
    if (!c) return { value: 0, net: 0 };
    try {
      const sale = leg(this.engine, c.asset, 'GBP', c.quantity, c.rules, now);
      return { value: sale.output, net: sale.output + c.returnedGbp - c.spent };
    } catch { return null; }
  }
  hedge(c, now) {
    if (now < c.dueAt) return false;
    const mark = this.mark(c, now), previousPhase = c.phase;
    if (c.forceUnwind || now - c.hedgeStartedAt >= c.rules.hedgeSeconds * 1000 || (mark && mark.net <= -c.rules.lossLimit)) {
      c.phase = 'unwinding'; c.reason ||= 'Hedge timeout or loss trigger';
    }
    try {
      const to = c.phase === 'unwinding' ? 'GBP' : c.assets[c.nextLeg + 1];
      const next = leg(this.engine, c.asset, to, c.quantity, c.rules, now);
      c.legs.push({ ...next, at: now });
      if (next.dust > 0) c.dust[c.asset] = (c.dust[c.asset] || 0) + next.dust;
      c.asset = to; c.quantity = next.output; c.nextLeg++; c.blocked = null;
      c.dueAt = now + c.rules.latencyMs;
      if (to === 'GBP') {
        c.returnedGbp += c.quantity; this.account.cash += c.quantity; c.quantity = 0;
        c.status = 'closed'; c.closedAt = now; c.realizedNet = c.returnedGbp - c.spent;
        for (const [asset, amount] of Object.entries(c.dust)) this.account.dust[asset] = (this.account.dust[asset] || 0) + amount;
        c.reason ||= 'Three-leg route completed';
        this.account.lastAction = `${c.reason}; net GBP ${c.realizedNet.toFixed(4)}. Residual crypto valued at zero.`;
      }
      return true;
    } catch (error) {
      const changed = c.blocked !== error.message || previousPhase !== c.phase; c.blocked = error.message;
      this.account.lastAction = `Inventory remains at risk: ${error.message}`;
      return changed;
    }
  }
  step(now = Date.now()) {
    let changed = false;
    const o = this.order();
    if (o) {
      if (o.status === 'pending' && now >= o.dueAt) { this.activate(o, now); changed = true; }
      else if (o.status === 'cancelling' && now >= o.cancelAt) { this.finishOrder(o, o.reason, now); changed = true; }
      else if (o.status === 'resting') {
        const e = this.engine, q = e.quotes[o.symbol];
        const current = makerCandidates(e, o.rules, now).find(r => r.route === o.route);
        if (!this.account.settings.autoEnabled || now >= o.expiresAt || e.quoteGuard(o.symbol, now) || q?.bid !== o.price ||
            current?.net == null || current.net < o.rules.minNet) {
          changed = this.cancel('Order stopped, expired or route changed', now) || changed;
        }
      }
    }
    const c = this.openCycle();
    if (c && !this.order()) changed = this.hedge(c, now) || changed;
    const mark = this.mark(this.openCycle(), now);
    if (mark) {
      const equity = this.account.cash + mark.value;
      const peak = Math.max(this.account.peakEquity, equity), drawdown = Math.max(this.account.maxDrawdown, peak - equity);
      if (peak !== this.account.peakEquity || drawdown !== this.account.maxDrawdown) { this.account.peakEquity = peak; this.account.maxDrawdown = drawdown; changed = true; }
    }
    if (this.account.settings.autoEnabled && !this.entryBlock(now)) {
      const row = makerCandidates(this.engine, this.account.settings, now).find(r => r.net !== null && r.net >= this.account.settings.minNet && this.tradeReady.has(r.legs[0]?.symbol));
      if (row) { this.request(row.route, now); changed = true; }
    }
    return changed;
  }
  view(now = Date.now()) {
    const c = this.openCycle(), o = this.order(), mark = this.mark(c, now);
    const reserved = o ? (o.quantity - o.filled) * o.price * (1 + o.makerFeePct / 100) : 0;
    return { ...this.account, cycles: this.account.cycles.slice(0, 100), orders: this.account.orders.slice(0, 50),
      cycleCount: this.account.cycles.length, orderCount: this.account.orders.length,
      realizedNet: this.account.cycles.filter(c => c.status === 'closed').reduce((n, c) => n + c.realizedNet, 0),
      reserved, availableCash: this.account.cash - reserved, equity: mark ? this.account.cash + mark.value : null,
      openNet: mark?.net ?? null, exposureValue: mark?.value ?? null,
      candidates: makerCandidates(this.engine, this.account.settings, now),
      block: this.entryBlock(now), tradeCount: this.tradeCount, lastTradeAt: this.lastTradeAt,
      tradeSubscriptions: [...this.tradeReady], persistenceError: this.persistenceError || null };
  }
}
