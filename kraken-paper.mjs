export const MEME_SYMBOLS = ['DOGE/GBP', 'PEPE/GBP', 'WIF/GBP'];
export const SYMBOLS = ['BTC/GBP', 'ETH/GBP', 'SOL/GBP', ...MEME_SYMBOLS];
export const STREAM_SYMBOLS = [...SYMBOLS, 'ETH/BTC', 'SOL/BTC'];
export const DEFAULTS = Object.freeze({ autoEnabled: false, spend: 25, feePct: 0.8, bufferBps: 5, momentumBps: 50, lookbackSec: 900, confirmBps: 5, maxSpreadBps: 20, takeProfit: 0.5, stopLoss: 0.75, maxHoldSec: 14400 });
export function settings(input) {
  input = { lookbackSec: 60, confirmBps: 5, maxSpreadBps: 20, ...input };
  const bounds = { lookbackSec: [60, 3600], confirmBps: [0, 100], maxSpreadBps: [1, 100], spend: [5, 100], feePct: [0, 2], bufferBps: [0, 100], momentumBps: [10, 2000], takeProfit: [0.1, 100], stopLoss: [0.1, 10], maxHoldSec: [60, 86400] };
  if (!input || typeof input.autoEnabled !== 'boolean') throw Error('Invalid auto paper setting');
  const result = { autoEnabled: input.autoEnabled };
  for (const [key, [lo, hi]] of Object.entries(bounds)) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < lo || input[key] > hi) throw Error(`Invalid ${key}: use ${lo}–${hi}`);
    result[key] = input[key];
  }
  return result;
}
export function newAccount() { return { version: 1, currency: 'GBP', startingCash: 1000, cash: 1000, settings: { ...DEFAULTS }, trades: [], pending: null, lastEntryAt: 0, lastAction: 'Waiting for live Kraken quotes' }; }
export function validateAccount(a) {
  if (a?.version !== 1 || a.currency !== 'GBP' || a.startingCash !== 1000 || !Number.isFinite(a.cash) || a.cash < 0 || !Array.isArray(a.trades)) throw Error('Invalid Kraken paper ledger');
  a.settings = settings(a.settings);
  let expected = a.startingCash;
  for (const t of a.trades) {
    if (!SYMBOLS.includes(t.symbol) || !['open', 'closed'].includes(t.status) || !Number.isFinite(t.quantity) || t.quantity <= 0 || !Number.isFinite(t.totalCost) || t.totalCost <= 0 || !Number.isFinite(t.openedAt)) throw Error('Invalid Kraken paper trade');
    settings(t.rules);
    expected -= t.totalCost;
    if (t.status === 'closed') {
      if (!Number.isFinite(t.proceeds) || !Number.isFinite(t.realizedNet) || Math.abs(t.realizedNet - (t.proceeds - t.totalCost)) > 1e-6) throw Error('Invalid Kraken paper proceeds');
      expected += t.proceeds;
    }
  }
  if (Math.abs(expected - a.cash) > 1e-6 || a.trades.filter(t => t.status === 'open').length > 1) throw Error('Kraken paper balance reconciliation failed');
  return a;
}
export class KrakenPaper {
  constructor(account = newAccount()) {
    this.account = validateAccount(account);
    this.quotes = {}; this.history = {}; this.metadata = {}; this.accountFees = {}; this.feesCheckedAt = 0; this.healthAt = 0; this.connected = false; this.online = false; this.updates = 0;
    account.pending = null; // A restart cannot execute an old signal.
    for (const t of account.trades) if (t.status === 'open') t.exitDueAt = null;
  }
  disconnect() {
    this.connected = false; this.online = false; this.healthAt = 0; this.quotes = {}; this.history = {};
    const changed = Boolean(this.account.pending);
    this.account.pending = null;
    if (changed) this.account.lastAction = 'Pending paper entry cancelled: stream disconnected';
    return changed;
  }
  receive(message, at = Date.now()) {
    if (message.method === 'subscribe' && !message.success) throw Error(message.error || 'Kraken subscription rejected');
    if (message.channel === 'status') this.online = message.data?.[0]?.system === 'online';
    if (message.channel !== 'ticker') return;
    for (const row of message.data || []) {
      if (!STREAM_SYMBOLS.includes(row.symbol)) continue;
      const values = [row.bid, row.ask, row.bid_qty, row.ask_qty];
      if (!values.every(x => typeof x === 'number' && Number.isFinite(x) && x > 0) || row.ask < row.bid) throw Error('Invalid Kraken best bid/ask');
      const sourceAt = Date.parse(row.timestamp);
      if (!Number.isFinite(sourceAt) || sourceAt > at + 5000) throw Error('Invalid Kraken timestamp or clock mismatch');
      // Ticker messages are complete quotes, not incremental book deltas. Live
      // feeds can deliver older ticker timestamps: skip them without a resync
      // loop, and let the accepted quote expire if fresh data stops arriving.
      if (at - sourceAt > 10000 || this.quotes[row.symbol]?.sourceAt > sourceAt) continue;
      this.quotes[row.symbol] = { symbol: row.symbol, bid: row.bid, ask: row.ask, bidQty: row.bid_qty, askQty: row.ask_qty, at, sourceAt };
      this.updates++;
    }
  }
  fresh(symbol, now) {
    // Ticker BBO subscriptions can be silent while prices are unchanged. Require
    // recent delivery as well as heartbeat; old depth is deliberately rejected.
    return this.connected && this.online && now - this.healthAt < 5000 && this.quotes[symbol] && now - this.quotes[symbol].at < 10000;
  }
  quoteGuard(symbol, now) {
    if (!this.fresh(symbol, now)) return 'Waiting for fresh bid/ask and an online Kraken stream';
    const meta = this.metadata[symbol];
    if (!meta || meta.status !== 'online' || now - meta.at > 3600000) return 'Pair metadata unavailable, outdated or trading restricted';
    return null;
  }
  entryQuote(symbol, rules, now) {
    const error = this.quoteGuard(symbol, now); if (error) return { error };
    const q = this.quotes[symbol], m = this.metadata[symbol];
    const price = q.ask * (1 + rules.bufferBps / 10000);
    const scale = 10 ** m.lotDecimals;
    const quantity = Math.floor(rules.spend / (price * (1 + rules.feePct / 100)) * scale) / scale;
    const cost = quantity * price, fee = cost * rules.feePct / 100;
    if (quantity < m.orderMin || cost < m.costMin) return { error: 'Below Kraken minimum order size' };
    if (quantity > q.askQty) return { error: 'Insufficient displayed best-ask quantity; no deeper fills assumed' };
    return { quantity, entryPrice: price, entryFee: fee, totalCost: cost + fee, quotedAsk: q.ask, quoteAt: q.at };
  }
  mark(t, now) {
    if (this.quoteGuard(t.symbol, now)) return null;
    const q = this.quotes[t.symbol];
    if (q.bidQty < t.quantity) return null;
    const price = q.bid * (1 - t.rules.bufferBps / 10000), gross = price * t.quantity;
    return { exitPrice: price, exitFee: gross * t.rules.feePct / 100, proceeds: gross * (1 - t.rules.feePct / 100), quotedBid: q.bid, quoteAt: q.at };
  }
  entryGuard(now) {
    const a = this.account;
    if (a.trades.some(t => t.status === 'open')) return 'One open paper position already exists';
    if (now - a.lastEntryAt < 60000) return '60-second entry cooldown';
    const midnight = new Date(now).setUTCHours(0, 0, 0);
    if (a.trades.filter(t => t.closedAt >= midnight).reduce((n, t) => n + t.realizedNet, 0) <= -10) return '£10 daily realized loss limit reached (UTC)';
    return null;
  }
  rulesFor(symbol, now = Date.now()) {
    const fee = this.accountFees[symbol];
    const verified = Number.isFinite(fee) && fee >= 0 && fee <= 2 && now - this.feesCheckedAt < 3600000;
    return { ...this.account.settings, feePct: verified ? fee : this.account.settings.feePct,
      feeSource: verified ? 'Verified account taker fee' : 'Configured fee assumption' };
  }
  request(symbol, mode = 'manual', now = Date.now()) {
    if (!SYMBOLS.includes(symbol)) throw Error('Unsupported Kraken pair');
    if (this.account.pending) throw Error('A paper entry is already queued');
    const error = this.entryGuard(now), quote = this.entryQuote(symbol, this.rulesFor(symbol, now), now);
    if (error || quote.error) throw Error(error || quote.error);
    if (quote.totalCost > this.account.cash) throw Error('Insufficient paper GBP');
    this.account.pending = { symbol, mode, signalAt: now, dueAt: now + 250, rules: this.rulesFor(symbol, now) };
    this.account.lastAction = `${symbol}: paper entry queued with 250 ms modeled latency`;
  }
  close(id) {
    const t = this.account.trades.find(t => t.id === id && t.status === 'open');
    if (!t) throw Error('Open Kraken paper position not found');
    t.exitReason = 'Manual close';
  }
  step(now = Date.now()) {
    const a = this.account; let changed = false;
    for (const symbol of SYMBOLS) if (this.fresh(symbol, now)) {
      const history = this.history[symbol] ||= [];
      if (!history.length || now - history.at(-1).at >= 1000) history.push({ at: now, price: (this.quotes[symbol].bid + this.quotes[symbol].ask) / 2 });
      while (history.length && now - history[0].at > (this.account.settings.lookbackSec * 1000 + 5000)) history.shift();
    }
    for (const t of a.trades.filter(t => t.status === 'open')) {
      const mark = this.mark(t, now), net = mark ? mark.proceeds - t.totalCost : null;
      const reason = t.exitReason || (net !== null && net >= t.rules.takeProfit ? 'Net profit target' : net !== null && net <= -t.rules.stopLoss ? 'Net loss limit' : now - t.openedAt >= t.rules.maxHoldSec * 1000 ? 'Maximum hold time' : null);
      if (!reason) continue;
      if (!t.exitReason || !t.exitDueAt) { t.exitReason = reason; t.exitDueAt = now + 250; changed = true; }
      if (now < t.exitDueAt) continue;
      if (!mark) {
        const blocked = 'Exit blocked: fresh full best-bid quantity unavailable';
        if (t.exitBlocked !== blocked) { t.exitBlocked = blocked; changed = true; }
        continue;
      }
      Object.assign(t, mark, { status: 'closed', closedAt: now, realizedNet: net, exitBlocked: null });
      a.cash += mark.proceeds; a.lastAction = `${t.symbol}: paper exit filled (${reason})`; changed = true;
    }
    const p = a.pending;
    if (p && now >= p.dueAt) {
      const error = this.entryGuard(now), quote = this.entryQuote(p.symbol, p.rules, now);
      a.pending = null; changed = true;
      if (error || quote.error || quote.totalCost > a.cash) a.lastAction = `Paper entry rejected: ${error || quote.error || 'Insufficient cash'}`;
      else {
        a.trades.unshift({ id: crypto.randomUUID(), ...quote, symbol: p.symbol, mode: p.mode, signalAt: p.signalAt, openedAt: now, status: 'open', rules: p.rules, fillAssumption: 'Full quantity at latest best ask/bid after 250 ms, with fee and adverse buffer. No guaranteed execution.' });
        a.cash -= quote.totalCost; a.lastEntryAt = now; a.lastAction = `${p.symbol}: assumed paper buy filled`;
      }
    }
    if (a.settings.autoEnabled && !a.pending && !this.entryGuard(now)) {
      const candidate = this.scan(now).filter(x => x.eligible).sort((a, b) => b.moveBps - a.moveBps)[0];
      if (candidate) { this.request(candidate.symbol, 'auto trend', now); changed = true; }
    }
    return changed;
  }
  scan(now = Date.now()) {
    return SYMBOLS.map(symbol => {
      const r = this.rulesFor(symbol, now), q = this.quotes[symbol], h = this.history[symbol] || [];
      const base = h.findLast(x => now - x.at >= r.lookbackSec * 1000);
      const shortBase = h.findLast(x => now - x.at >= 60000);
      const mid = q ? (q.bid + q.ask) / 2 : null;
      const moveBps = base && mid ? (mid / base.price - 1) * 10000 : null;
      const confirmBps = shortBase && mid ? (mid / shortBase.price - 1) * 10000 : null;
      const historySec = h.length ? Math.min(r.lookbackSec, Math.floor((now - h[0].at) / 1000)) : 0;
      const sample = base ? h.filter(x => x.at >= base.at) : h;
      const coverage = Math.min(1, sample.length / r.lookbackSec);
      const f = r.feePct / 100, b = r.bufferBps / 10000;
      const spreadBps = q ? (q.ask / q.bid - 1) * 10000 : null;
      const breakEvenBps = q ? ((q.ask * (1 + b) * (1 + f)) / (q.bid * (1 - b) * (1 - f)) - 1) * 10000 : null;
      const threshold = r.momentumBps;
      const entry = this.entryQuote(symbol, r, now);
      const immediateProceeds = entry.quantity && q ? entry.quantity * q.bid * (1 - b) * (1 - f) : null;
      const initialLoss = immediateProceeds !== null ? entry.totalCost - immediateProceeds : null;
      const targetRiseBps = immediateProceeds > 0 ? ((entry.totalCost + r.takeProfit) / immediateProceeds - 1) * 10000 : null;
      const executionBlock = entry.error || this.entryGuard(now) || (this.account.pending ? 'Paper entry pending' : null) || (entry.totalCost > this.account.cash ? 'Insufficient paper GBP' : null);
      const signalBlock = moveBps === null ? `Building trend history: ${historySec}/${r.lookbackSec}s` : coverage < 0.8 ? 'Insufficient fresh history coverage (need 80%)' : spreadBps > r.maxSpreadBps ? 'Spread exceeds configured limit' : initialLoss >= r.stopLoss ? 'Fees and spread already exceed the loss trigger' : moveBps < threshold ? `Waiting for +${(threshold / 100).toFixed(2)}% / ${r.lookbackSec / 60}m trend` : confirmBps === null || confirmBps < r.confirmBps ? 'Waiting for positive 60s confirmation' : null;
      const eligible = !executionBlock && !signalBlock;
      const reason = executionBlock || signalBlock || 'Trend and confirmation met; simulated entry ready';
      return { symbol, ...q, category: MEME_SYMBOLS.includes(symbol) ? 'Meme' : 'Major', feePct: r.feePct, feeSource: r.feeSource, fresh: Boolean(this.fresh(symbol, now)), moveBps, confirmBps, historySec, coverage, spreadBps, initialLoss, targetRiseBps, breakEvenBps, threshold, reason, eligible, entryAllowed: !executionBlock };

    });
  }
  view(now = Date.now()) {
    const trades = this.account.trades.map(t => ({ ...t, unrealizedNet: t.status === 'open' ? (this.mark(t, now)?.proceeds ?? NaN) - t.totalCost : null }));
    const open = trades.filter(t => t.status === 'open'), priced = open.every(t => Number.isFinite(t.unrealizedNet));
    return { ...this.account, trades, scan: this.scan(now), updates: this.updates, healthAt: this.healthAt, online: this.online,
      equity: priced ? this.account.cash + open.reduce((n, t) => n + t.totalCost + t.unrealizedNet, 0) : null,
      comparison: ['Meme', 'Major'].map(category => {
        const group = trades.filter(t => (MEME_SYMBOLS.includes(t.symbol) ? 'Meme' : 'Major') === category && t.mode === 'auto trend');
        const closed = group.filter(t => t.status === 'closed');
        return { category, closed: closed.length, open: group.length - closed.length,
          net: closed.reduce((sum, t) => sum + t.realizedNet, 0),
          worstTrade: closed.length ? Math.min(...closed.map(t => t.realizedNet)) : null };
      }),
      realizedNet: trades.filter(t => t.status === 'closed').reduce((n, t) => n + t.realizedNet, 0),
      unrealizedNet: priced ? open.reduce((n, t) => n + t.unrealizedNet, 0) : null };
  }
}
