// A stream delta is a replacement quantity at one price, not an amount to add.
// Discard this cache whenever the connection breaks; a new snapshot must seed it.
export class OrderBooks {
  constructor() { this.books = new Map(); }
  clear() { this.books.clear(); }
  retain(ids) { for (const id of this.books.keys()) if (!ids.has(id)) this.books.delete(id); }
  get(id) { return this.books.get(id); }
  apply(events, allowed, receivedAt = Date.now()) {
    const changed = new Set();
    for (const event of Array.isArray(events) ? events : [events]) {
      const timestamp = Number(event.timestamp);
      if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
      if (event.event_type === 'book' && allowed.has(event.asset_id)) {
        const old = this.books.get(event.asset_id);
        if (old && timestamp < old.timestamp) continue;
        const levels = rows => {
          if (!Array.isArray(rows)) throw Error('Invalid book snapshot');
          const map = new Map();
          for (const row of rows) {
            const price = Number(row.price), size = Number(row.size);
            if (!Number.isFinite(price) || price < 0 || price > 1 || !Number.isFinite(size) || size < 0) throw Error('Invalid book level');
            if (size > 0) map.set(price, size);
          }
          return map;
        };
        this.books.set(event.asset_id, { bids: levels(event.bids), asks: levels(event.asks), timestamp, receivedAt });
        changed.add(event.asset_id);
      } else if (event.event_type === 'price_change') {
        if (!Array.isArray(event.price_changes)) throw Error('Invalid price changes');
        for (const change of event.price_changes) {
          if (!allowed.has(change.asset_id)) continue;
          const book = this.books.get(change.asset_id);
          // Never turn a partial delta into a complete, apparently tradable book.
          if (!book || timestamp < book.timestamp) continue;
          const price = Number(change.price), size = Number(change.size);
          if (!['BUY','SELL'].includes(change.side) || !Number.isFinite(price) || price < 0 || price > 1 || !Number.isFinite(size) || size < 0) throw Error('Invalid price change');
          const side = change.side === 'BUY' ? book.bids : book.asks;
          if (size === 0) side.delete(price); else side.set(price, size);
          book.timestamp = timestamp;
          book.receivedAt = receivedAt;
          changed.add(change.asset_id);
        }
      }
    }
    return changed;
  }
  snapshot(id) {
    const book = this.books.get(id);
    if (!book) return null;
    const rows = map => [...map].map(([price,size]) => ({ price, size }));
    return { bids: rows(book.bids), asks: rows(book.asks), timestamp: book.timestamp, receivedAt: book.receivedAt };
  }
}

export function freshBook(market, now = Date.now()) {
  if (!market?.books?.up || !market?.books?.down) return false;
  if (market.bookTransport === 'websocket') {
    // An unchanged book remains current on an unbroken, heartbeating stream.
    // This timestamp verifies transport health; source timestamps remain intact.
    return market.bookStreamHealthy === true && market.bookVerifiedAt > 0 && now - market.bookVerifiedAt < 25000;
  }
  return market.bookFetchedAt > 0 && now - market.bookFetchedAt <= 7000 &&
    market.bookSourceAt > 0 && now - market.bookSourceAt <= 10000;
}

export function sampleStats(values) {
  if (!values.length) return { p50: null, p95: null };
  const sorted = [...values].sort((a,b) => a-b);
  return { p50: sorted[Math.floor((sorted.length-1)*.50)], p95: sorted[Math.floor((sorted.length-1)*.95)] };
}
