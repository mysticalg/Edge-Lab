export const FEE_PAIRS = {
  'BTC/GBP': ['XXBTZGBP', 'XBTGBP'], 'ETH/GBP': ['XETHZGBP', 'ETHGBP'],
  'SOL/GBP': ['SOLGBP'], 'DOGE/GBP': ['XDGGBP', 'XXDGZGBP', 'DOGEGBP'],
  'PEPE/GBP': ['PEPEGBP'], 'WIF/GBP': ['WIFGBP'],
  'ETH/BTC': ['XETHXXBT', 'ETHXBT'], 'SOL/BTC': ['SOLXBT'],
};

// A missing maker rate is unknown, never zero or an inferred taker discount.
export function extractKrakenFees(volume) {
  const result = { feePctByPair: {}, makerFeePctByPair: {} };
  for (const [symbol, aliases] of Object.entries(FEE_PAIRS)) {
    for (const [field, target] of [['fees', 'feePctByPair'], ['fees_maker', 'makerFeePctByPair']]) {
      const raw = aliases.map(name => volume?.[field]?.[name]?.fee).find(x => x !== undefined);
      if (raw === null || raw === '' || raw === undefined) continue;
      const fee = Number(raw);
      if (Number.isFinite(fee) && fee >= 0 && fee <= 2) result[target][symbol] = fee;
    }
  }
  return result;
}
