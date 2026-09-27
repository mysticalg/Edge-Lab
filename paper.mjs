import { quotePair } from './edge.mjs';
import { freshBook } from './order-book.mjs';

export const DEFAULT_PAPER_SETTINGS = Object.freeze({
  autoEnabled: false,
  shares: 10,
  bufferBps: 25,
  minNetUsd: 0.10,
  maxOpen: 2,
});

export function paperQuote(market, shares, bufferBps, now = Date.now()) {
  if (!market?.books || market.feeType !== 'crypto_fees_v2') return { available: false, reason: 'Supported order books unavailable.' };
  if (!freshBook(market, now) ||
      Date.parse(market.endDate) - now < 10000) return { available: false, reason: 'Market or book is too close to expiry or stale.' };
  return quotePair(market.books.up.asks, market.books.down.asks, shares, bufferBps);
}

export function enterPaperPair(account, market, shares, bufferBps, mode, now = Date.now()) {
  const quote = paperQuote(market, shares, bufferBps, now);
  if (!quote.available) return { error: quote.reason };
  if (account.trades.some(t => t.marketId === market.id)) return { error: 'This market already has a paper pair.' };
  if (account.trades.filter(t => t.status === 'open').length >= account.settings.maxOpen) return { error: 'Maximum open paper pairs reached.' };
  if (account.cash + 1e-8 < quote.totalCost) return { error: 'Insufficient paper cash.' };
  if (mode === 'auto' && quote.net < account.settings.minNetUsd) return { error: 'Estimated net is below the auto-entry threshold.' };
  const trade = {
    id: crypto.randomUUID(), marketId: market.id, slug: market.slug, title: market.title,
    endDate: market.endDate, resolutionSource: market.resolutionSource,
    openedAt: now, mode, status: 'open', shares, bufferBps,
    upCost: quote.up.cost, downCost: quote.down.cost, fees: quote.fees,
    executionBuffer: quote.executionBuffer, totalCost: quote.totalCost,
    projectedNet: quote.net, bookSourceAt: market.bookSourceAt,
    fillAssumption: 'Both ask books had displayed depth at the observed snapshot; no real fill occurred.',
  };
  account.cash -= quote.totalCost;
  account.trades.unshift(trade);
  return { trade };
}

export function settlementWinner(event) {
  const m = event?.markets?.[0];
  if (!m?.closed || m.umaResolutionStatus !== 'resolved') return null;
  const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
  const prices = (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices)?.map(Number);
  if (!Array.isArray(outcomes) || !Array.isArray(prices) || outcomes.length !== 2 || prices.length !== 2) return null;
  const up = outcomes.findIndex(x => String(x).toLowerCase() === 'up');
  const down = outcomes.findIndex(x => String(x).toLowerCase() === 'down');
  if (up < 0 || down < 0 || ![0,1].includes(prices[up]) || ![0,1].includes(prices[down]) || prices[up] + prices[down] !== 1) return null;
  return prices[up] === 1 ? 'Up' : 'Down';
}

export function settlePaperPair(account, trade, event, now = Date.now()) {
  if (trade.status !== 'open') return false;
  const winner = settlementWinner(event);
  if (!winner) return false;
  trade.status = 'settled';
  trade.winner = winner;
  trade.settledAt = now;
  trade.payout = trade.shares;
  trade.realizedNet = trade.payout - trade.totalCost;
  account.cash += trade.payout;
  return true;
}
