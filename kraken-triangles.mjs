// Read-only snapshot estimates. Never dispatches orders or credits paper cash.
export function scanTriangles(engine, now = Date.now()) {
  const budget = engine.account.settings.spend;
  return ['ETH', 'SOL'].flatMap(coin => [false, true].map(reverse => {
    const assets = reverse ? ['GBP', coin, 'BTC', 'GBP'] : ['GBP', 'BTC', coin, 'GBP'];
    let amount = budget, error = null;
    const legs = [], dust = [];
    for (let i = 0; i < 3; i++) {
      const from = assets[i], to = assets[i + 1];
      const buy = from === 'GBP' || (from === 'BTC' && to !== 'GBP');
      const symbol = buy ? `${to}/${from}` : `${from}/${to}`;
      const guard = engine.quoteGuard(symbol, now);
      const q = engine.quotes[symbol], meta = engine.metadata[symbol];
      const rules = engine.rulesFor(symbol, now);
      if (guard || rules.feeSource !== 'Verified account taker fee') { error = `${symbol}: ${guard || 'Fresh verified account fee required'}`; break; }
      const f = rules.feePct / 100, buffer = rules.bufferBps / 10000;
      const price = buy ? q.ask * (1 + buffer) : q.bid * (1 - buffer);
      const scale = 10 ** meta.lotDecimals;
      const quantity = Math.floor((buy ? amount / (price * (1 + f)) : amount) * scale) / scale;
      const notional = quantity * price;
      if (quantity < meta.orderMin || notional < meta.costMin) { error = `${symbol}: below order minimum`; break; }
      if (quantity > (buy ? q.askQty : q.bidQty)) { error = `${symbol}: insufficient best-level liquidity`; break; }
      const fee = notional * f;
      const remainder = Math.max(0, amount - (buy ? notional + fee : quantity));
      dust.push({ asset: from, amount: remainder });
      amount = buy ? quantity : notional - fee;
      legs.push({ symbol, side: buy ? 'buy' : 'sell', quantity, price, fee, feeCurrency: symbol.split('/')[1], feePct: rules.feePct, output: amount });
    }
    const returnedGbp = error ? null : amount + dust.filter(x => x.asset === 'GBP').reduce((s, x) => s + x.amount, 0);
    const net = returnedGbp === null ? null : returnedGbp - budget;
    return { route: assets.join(' → '), budget, returnedGbp, net, legs, dust,
      status: error || (net > 0 ? 'Positive snapshot estimate — execution unverified' : 'No net opportunity'), checkedAt: now };
  })).sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity));
}
