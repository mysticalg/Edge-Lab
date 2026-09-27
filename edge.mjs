export const CRYPTO_TAKER_FEE_RATE = 0.07;

export function quotePair(upAsks, downAsks, shares, bufferBps = 25) {
  if (!Number.isFinite(shares) || shares < 5) return { available: false, reason: 'Minimum paper size is 5 paired shares.' };
  if (!Number.isFinite(bufferBps) || bufferBps < 0 || bufferBps > 500) return { available: false, reason: 'Invalid execution buffer.' };
  const walk = (levels) => {
    let left = shares, cost = 0, fees = 0, worst = null;
    const sorted = [...(levels || [])].map(x => ({ price: Number(x.price), size: Number(x.size) }))
      .filter(x => x.price > 0 && x.price < 1 && x.size > 0).sort((a,b) => a.price - b.price);
    for (const level of sorted) {
      const take = Math.min(left, level.size);
      cost += take * level.price;
      fees += take * CRYPTO_TAKER_FEE_RATE * level.price * (1 - level.price);
      worst = level.price;
      left -= take;
      if (left < 1e-8) break;
    }
    return { filled: shares - left, cost, fees, worst, complete: left < 1e-8 };
  };
  const up = walk(upAsks), down = walk(downAsks);
  if (!up.complete || !down.complete) return { available: false, reason: 'Insufficient ask depth on one or both legs.', up, down };
  const executionBuffer = (up.cost + down.cost) * bufferBps / 10000;
  const totalCost = up.cost + down.cost + up.fees + down.fees + executionBuffer;
  const net = shares - totalCost;
  return { available: true, shares, up, down, executionBuffer, totalCost, payout: shares, net, netPct: 100 * net / totalCost,
    gross: shares - up.cost - down.cost, fees: up.fees + down.fees };
}
