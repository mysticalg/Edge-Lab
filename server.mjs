import express from 'express';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quotePair } from './edge.mjs';
import { DEFAULT_PAPER_SETTINGS, enterPaperPair, paperQuote, settlePaperPair } from './paper.mjs';
import { OrderBooks, freshBook, sampleStats } from './order-book.mjs';
import { LiveSocket, POLYMARKET_STREAM, BINANCE_STREAM } from './streams.mjs';
import { Scalper, newScalperAccount, validateScalperSettings } from './scalper.mjs';
import { installKraken } from './kraken-service.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.EDGE_LAB_PORT || 4178);
const journalPath = join(root, 'data', 'observations.json');
const paperPath = join(root, 'data', 'paper-v1.json');
const scalperPath = join(root, 'data', 'scalper-v1.json');
const app = express();
app.use((req, res, next) => {
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.get('host') || '')) return res.status(403).json({ error: 'Local host required' });
  next();
});
app.use(express.json({ limit: '20kb' }));

const state = { updatedAt: null, binance: null, markets: [], errors: {}, history: [], observations: [],
  feeds: { polymarket: { status: 'connecting' }, binance: { status: 'connecting' } },
  engine: { scans: 0, scansPerSecond: 0, processingMs: null, processingP95Ms: null, uiPushIntervalMs: 50 },
  scalper: newScalperAccount(),
  paper: { startingCash: 1000, cash: 1000, settings: { ...DEFAULT_PAPER_SETTINGS }, trades: [] } };
let scalper = new Scalper(state.scalper);
let marketRefreshAt = 0;
let settlementRefreshAt = 0;
let busy = false;
const signalKeys = new Map();
const books = new OrderBooks();
let tokenIds = new Set();
let polyStream, binanceStream;
let polySubscribed = false;
const sourceLags = [], processingTimes = [];
const clients = new Set();
let pushTimer = null;
let paperWrites = Promise.resolve(), observationWrites = Promise.resolve();
let scalperWrites = Promise.resolve();
function saveScalper() {
  const { scan, ...account } = state.scalper;
  const data = JSON.stringify(account, null, 2);
  scalperWrites = scalperWrites.catch(() => {}).then(async () => {
    await mkdir(dirname(scalperPath), { recursive: true });
    await writeFile(scalperPath + '.tmp', data);
    await rename(scalperPath + '.tmp', scalperPath);
  });
  return scalperWrites;
}
function runScalper(now = Date.now()) {
  if (scalper.step(state.markets, state.binance, now)) void saveScalper().catch(e => { state.errors.scalper = e.message; });
  state.scalper.scan = scalper.scan;
}

function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (!clients.size) return;
    const data = `data: ${JSON.stringify({ ...state, sentAt: Date.now() })}\n\n`;
    for (const client of clients) {
      // Slow/hidden clients skip intermediate screens; they never delay the engine.
      if (!client.writableNeedDrain) client.write(data);
    }
  }, 50);
}
function syncSubscriptions() {
  const next = new Set(state.markets.flatMap(m => [m.upId, m.downId]));
  const added = [...next].filter(id => !tokenIds.has(id));
  const removed = [...tokenIds].filter(id => !next.has(id));
  if (polyStream?.status.status === 'connected') {
    if (!polySubscribed && next.size) {
      polyStream.send({ assets_ids: [...next], type: 'market' });
      polySubscribed = true;
    } else {
      if (removed.length) polyStream.send({ assets_ids: removed, operation: 'unsubscribe' });
      if (added.length) polyStream.send({ assets_ids: added, operation: 'subscribe' });
    }
  }
  tokenIds = next;
  books.retain(next);
  for (const id of signalKeys.keys()) if (!state.markets.some(m => m.id === id)) signalKeys.delete(id);
}
function invalidateBooks() {
  polySubscribed = false;
  books.clear();
  for (const market of state.markets) {
    market.books = null; market.quote = null; market.bookStreamHealthy = false;
  }
  updatePaperScan();
  if (scalper.reset('Polymarket disconnected; pending entries cancelled')) void saveScalper().catch(console.error);
  state.scalper.scan = scalper.scan;
  pushState();
}
function receiveBooks(events, receivedAt) {
  const start = performance.now();
  const changed = books.apply(events, tokenIds, receivedAt);
  if (!changed.size) return;
  const latestSource = Math.max(...[...changed].map(id => books.get(id).timestamp));
  const lag = receivedAt - latestSource;
  if (lag > 10000 || lag < -5000) throw Error('Book timestamp is delayed or local clock is out of sync');
  sourceLags.push(lag); if (sourceLags.length > 512) sourceLags.shift();
  state.feeds.polymarket.sourceLagMs = lag;
  state.feeds.polymarket.bookEvents = (state.feeds.polymarket.bookEvents || 0) + 1;
  // Apply the entire frame before evaluating either leg to avoid half-updated pairs.
  for (const market of state.markets) {
    if (!changed.has(market.upId) && !changed.has(market.downId)) continue;
    const up = books.snapshot(market.upId), down = books.snapshot(market.downId);
    if (!up || !down) continue;
    market.books = { up, down };
    market.bookTransport = 'websocket';
    market.bookStreamHealthy = true;
    market.bookVerifiedAt = receivedAt;
    market.bookFetchedAt = Math.max(up.receivedAt, down.receivedAt);
    market.bookSourceAt = Math.min(up.timestamp, down.timestamp);
    market.quote = market.feeType === 'crypto_fees_v2' ? quotePair(up.asks, down.asks, 10, 25) : null;
  }
  maybeLogSignals();
  maybeAutoTrade();
  updatePaperScan();
  scalper.observeBooks(state.markets, receivedAt);
  runScalper(receivedAt);
  state.updatedAt = receivedAt;
  const elapsed = performance.now() - start;
  processingTimes.push(elapsed); if (processingTimes.length > 512) processingTimes.shift();
  state.engine.processingMs = elapsed;
  state.engine.scans++;
  pushState();
}
function receiveBinance(b, receivedAt) {
  const bid = Number(b.b), ask = Number(b.a);
  if (b.s !== 'BTCUSDT' || !(bid > 0 && ask >= bid)) return;
  state.binance = { bid, ask, mid: (bid + ask) / 2, fetchedAt: receivedAt };
  scalper.observeSpot(state.binance);
  runScalper(receivedAt);
  // Keep the chart small; the current price still updates on every stream event.
  const last = state.history.at(-1);
  if (!last || receivedAt - last.at >= 2000) state.history.push({ at: receivedAt, price: state.binance.mid });
  state.history = state.history.filter(x => receivedAt - x.at < 30 * 60_000).slice(-900);
  pushState();
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'EdgeLab/0.1 research monitor' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}
function slugs(now) {
  const sec = Math.floor(now / 1000);
  return [300, 900].flatMap(window => [0, 1].map(shift => `btc-updown-${window / 60}m-${Math.floor(sec / window) * window + shift * window}`));
}
function parseList(value) { try { return Array.isArray(value) ? value : JSON.parse(value); } catch { return []; } }
function normalizeEvent(event) {
  const market = event?.markets?.[0];
  if (!market || !market.enableOrderBook || market.closed || !market.acceptingOrders || Date.parse(market.endDate || event.endDate) <= Date.now()) return null;
  const ids = parseList(market.clobTokenIds);
  const outcomes = parseList(market.outcomes);
  const upIndex = outcomes.findIndex(x => String(x).toLowerCase() === 'up');
  const downIndex = outcomes.findIndex(x => String(x).toLowerCase() === 'down');
  if (upIndex < 0 || downIndex < 0 || !ids[upIndex] || !ids[downIndex]) return null;
  return { id: String(market.id), slug: event.slug, title: event.title, endDate: market.endDate || event.endDate,
    description: event.description, resolutionSource: event.resolutionSource, url: `https://polymarket.com/event/${event.slug}`,
    upId: ids[upIndex], downId: ids[downIndex], feeType: market.feeType, minSize: Number(market.orderMinSize || 5) };
}
async function refreshMarkets() {
  const previousMarkets = state.markets;
  const found = await Promise.allSettled(slugs(Date.now()).map(async slug => {
    const events = await getJson(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
    return normalizeEvent(events[0]);
  }));
  const valid = found.filter(x => x.status === 'fulfilled' && x.value).map(x => x.value);
  if (valid.length) {
    state.markets = valid.map(m => ({ ...state.markets.find(old => old.id === m.id), ...m }));
    delete state.errors.markets;
  } else {
    state.markets = state.markets.filter(m => Date.parse(m.endDate) > Date.now());
    state.errors.markets = 'No new open BTC 5m/15m markets returned by Gamma. Retrying.';
  }
  // Keep subscriptions for open directional positions through rollover/discovery gaps.
  for (const trade of state.scalper.trades.filter(t => t.status === 'open')) {
    if (state.markets.some(m => m.id === trade.marketId)) continue;
    state.markets.push({ ...previousMarkets.find(m => m.id === trade.marketId), id:trade.marketId, slug:trade.slug, title:trade.title, endDate:trade.endDate,
      upId:trade.upId, downId:trade.downId, feeType:trade.feeType, minSize:trade.minSize,
      resolutionSource:trade.resolutionSource, url:`https://polymarket.com/event/${trade.slug}` });
  }
  syncSubscriptions();
  marketRefreshAt = Date.now();
}
function saveObservations() {
  const data = JSON.stringify(state.observations.slice(0, 2000), null, 2);
  observationWrites = observationWrites.catch(() => {}).then(async () => {
    await mkdir(dirname(journalPath), { recursive: true });
    await writeFile(journalPath, data);
  });
  return observationWrites;
}
function savePaper() {
  const data = JSON.stringify(state.paper, null, 2);
  paperWrites = paperWrites.catch(() => {}).then(async () => {
    await mkdir(dirname(paperPath), { recursive: true });
    await writeFile(paperPath, data);
  });
  return paperWrites;
}
function maybeAutoTrade() {
  if (!state.paper.settings.autoEnabled) return;
  let changed = false;
  for (const market of state.markets) {
    const result = enterPaperPair(state.paper, market, state.paper.settings.shares, state.paper.settings.bufferBps, 'auto');
    if (result.trade) changed = true;
  }
  if (changed) void savePaper().catch(e => { state.errors.paper = e.message; pushState(); });
}
function updatePaperScan() {
  const { shares, bufferBps, minNetUsd } = state.paper.settings;
  const quotes = state.markets.map(market => ({ market, quote: paperQuote(market, shares, bufferBps) }));
  const available = quotes.filter(x => x.quote.available);
  const eligible = available.filter(x => x.quote.net >= minNetUsd && !state.paper.trades.some(t => t.marketId === x.market.id));
  const best = available.sort((a,b) => b.quote.net - a.quote.net)[0];
  state.paper.lastScan = { at: Date.now(), markets: quotes.length, priced: available.length,
    eligible: eligible.length, bestNet: best?.quote.net ?? null, bestSlug: best?.market.slug ?? null };
}
async function refreshSettlements() {
  if (Date.now() - settlementRefreshAt < 15000) return;
  settlementRefreshAt = Date.now();
  const due = state.paper.trades.filter(t => t.status === 'open' && Date.parse(t.endDate) <= Date.now());
  let changed = false;
  await Promise.all(due.map(async trade => {
    try {
      const events = await getJson(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(trade.slug)}`);
      if (settlePaperPair(state.paper, trade, events[0])) changed = true;
      delete state.errors[`resolution:${trade.slug}`];
    } catch (e) { state.errors[`resolution:${trade.slug}`] = String(e.message || e); }
  }));
  if (changed) await savePaper();
  let scalperChanged = false;
  const directionalDue = state.scalper.trades.filter(t => t.status === 'open' && Date.parse(t.endDate) <= Date.now());
  await Promise.all(directionalDue.map(async trade => {
    try {
      const events = await getJson(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(trade.slug)}`);
      if (scalper.settle(trade, events[0])) scalperChanged = true;
      delete state.errors[`scalper-resolution:${trade.slug}`];
    } catch (error) { state.errors[`scalper-resolution:${trade.slug}`] = error.message; }
  }));
  if (scalperChanged) await saveScalper();
}
function maybeLogSignals() {
  for (const m of state.markets) {
    const q = m.quote;
    if (!q?.available || q.net <= 0 || !freshBook(m) || Date.parse(m.endDate) <= Date.now()) continue;
    const key = `${m.id}:${Math.floor(Date.now() / 15000)}`;
    if (key === signalKeys.get(m.id)) continue;
    signalKeys.set(m.id, key);
    state.observations.unshift({ id: crypto.randomUUID(), at: Date.now(), type: 'Observed gap', slug: m.slug,
      title: m.title, shares: q.shares, upCost: q.up.cost, downCost: q.down.cost, fees: q.fees,
      buffer: q.executionBuffer, net: q.net, binanceMid: state.binance?.mid ?? null,
      note: 'Quote observation only; simultaneous fills were not verified.' });
    state.observations = state.observations.slice(0, 2000);
    void saveObservations().catch(console.error);
  }
}
async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (Date.now() - marketRefreshAt > 20000) await refreshMarkets();
    updatePaperScan();
    await refreshSettlements();
    pushState();
  } finally { busy = false; }
}

app.get('/api/state', (_req, res) => res.json(state));
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  res.write(`retry: 1000\ndata: ${JSON.stringify({ ...state, sentAt: Date.now() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
app.post('/api/paper/settings', async (req, res) => {
  const body = req.body || {};
  const shares = Number(body.shares), bufferBps = Number(body.bufferBps), minNetUsd = Number(body.minNetUsd), maxOpen = Number(body.maxOpen);
  if (typeof body.autoEnabled !== 'boolean' || !Number.isInteger(shares) || shares < 5 || shares > 1000 ||
      !Number.isFinite(bufferBps) || bufferBps < 0 || bufferBps > 500 ||
      !Number.isFinite(minNetUsd) || minNetUsd < 0 || minNetUsd > 100 ||
      !Number.isInteger(maxOpen) || maxOpen < 1 || maxOpen > 10)
    return res.status(400).json({ error: 'Invalid paper settings.' });
  state.paper.settings = { autoEnabled: body.autoEnabled, shares, bufferBps, minNetUsd, maxOpen };
  if (body.autoEnabled) {
    state.scalper.settings.autoEnabled = false;
    scalper.reset('Switched to paired strategy');
    await saveScalper();
  }
  updatePaperScan();
  await savePaper();
  pushState();
  res.json(state.paper);
});
app.post('/api/scalper/settings', async (req, res) => {
  const settings = validateScalperSettings(req.body);
  if (!settings) return res.status(400).json({ error:'Invalid scalper settings or out-of-range value.' });
  state.scalper.settings = settings;
  scalper.reset('Settings changed; pending entries cancelled');
  if (settings.autoEnabled) { state.paper.settings.autoEnabled = false; await savePaper(); }
  runScalper();
  await saveScalper(); pushState();
  res.json(state.scalper);
});
app.post('/api/scalper/close', async (req, res) => {
  const trade = state.scalper.trades.find(t => t.id === req.body.tradeId && t.status === 'open');
  if (!trade) return res.status(404).json({ error:'Open paper position not found.' });
  trade.manualClose = true;
  runScalper();
  await saveScalper(); pushState();
  res.json({ status:'Exit requested; waits for latency and fresh bid depth.' });
});
app.get('/api/scalper/trades.csv', (_req, res) => {
  const fields = ['signalAt','openedAt','closedAt','slug','side','status','shares','entryPrice','entryCost','entryFees','entryBuffer','exitPrice','exitFees','exitBuffer','exitReason','exitBlocked','proceeds','realizedNet','signalMoveBps','signalResponseCents','fillAssumption'];
  const cell = value => `"${String(value ?? '').replaceAll('"','""')}"`;
  res.set('Content-Type','text/csv; charset=utf-8');
  res.set('Content-Disposition','attachment; filename="edge-lab-scalper.csv"');
  res.send([fields.join(','), ...state.scalper.trades.map(t => fields.map(f => cell(t[f])).join(','))].join('\r\n'));
});
app.post('/api/paper/enter', async (req, res) => {
  const market = state.markets.find(x => x.id === String(req.body.marketId));
  const shares = Number(req.body.shares), bufferBps = Number(req.body.bufferBps);
  if (!Number.isInteger(shares) || shares < 5 || shares > 1000 || !Number.isFinite(bufferBps) || bufferBps < 0 || bufferBps > 500)
    return res.status(400).json({ error: 'Invalid paper size or buffer.' });
  const result = enterPaperPair(state.paper, market, shares, bufferBps, 'manual');
  if (!result.trade) return res.status(409).json({ error: result.error });
  await savePaper();
  pushState();
  res.json(result.trade);
});
app.post('/api/capture', async (req, res) => {
  const market = state.markets.find(x => x.id === String(req.body.marketId));
  const shares = Number(req.body.shares);
  const bufferBps = Number(req.body.bufferBps);
  if (!freshBook(market) || market.feeType !== 'crypto_fees_v2') return res.status(409).json({ error: 'Fresh supported order books unavailable.' });
  const quote = quotePair(market.books.up.asks, market.books.down.asks, shares, bufferBps);
  if (!quote.available) return res.status(400).json({ error: quote.reason });
  const observation = { id: crypto.randomUUID(), at: Date.now(), type: 'Manual paper snapshot', slug: market.slug,
    title: market.title, shares, upCost: quote.up.cost, downCost: quote.down.cost, fees: quote.fees,
    buffer: quote.executionBuffer, net: quote.net, binanceMid: state.binance?.mid ?? null,
    note: 'Paper quote snapshot only; no order submitted or fill assumed.' };
  state.observations.unshift(observation);
  state.observations = state.observations.slice(0, 2000);
  await saveObservations();
  pushState();
  res.json(observation);
});
app.get('/api/observations.csv', (_req, res) => {
  const fields = ['at','type','slug','shares','upCost','downCost','fees','buffer','net','binanceMid','note'];
  const cell = value => `"${String(value ?? '').replaceAll('"','""')}"`;
  res.set('Content-Type','text/csv; charset=utf-8');
  res.set('Content-Disposition','attachment; filename="edge-lab-observations.csv"');
  res.send([fields.join(','), ...state.observations.map(row => fields.map(f => cell(row[f])).join(','))].join('\r\n'));
});
app.get('/api/paper/trades.csv', (_req, res) => {
  const fields = ['openedAt','settledAt','mode','slug','status','shares','upCost','downCost','fees','executionBuffer','totalCost','projectedNet','winner','payout','realizedNet','fillAssumption'];
  const cell = value => `"${String(value ?? '').replaceAll('"','""')}"`;
  res.set('Content-Type','text/csv; charset=utf-8');
  res.set('Content-Disposition','attachment; filename="edge-lab-paper-trades.csv"');
  res.send([fields.join(','), ...state.paper.trades.map(row => fields.map(f => cell(row[f])).join(','))].join('\r\n'));
});
const krakenService = await installKraken(app, root, state, pushState);
app.use(express.static(join(root, 'dist')));
app.get('/{*path}', (_req, res) => res.sendFile(join(root, 'dist', 'index.html')));

try { state.observations = JSON.parse(await readFile(journalPath, 'utf8')); } catch { /* first run */ }
try {
  const saved = JSON.parse(await readFile(paperPath, 'utf8'));
  if (saved?.startingCash === 1000 && Number.isFinite(saved.cash) && Array.isArray(saved.trades))
    state.paper = { ...saved, settings: { ...DEFAULT_PAPER_SETTINGS, ...saved.settings } };
} catch { /* first run */ }
try {
  const saved = JSON.parse(await readFile(scalperPath, 'utf8'));
  const settings = validateScalperSettings(saved.settings);
  if (saved.version !== 1 || !Number.isFinite(saved.cash) || !Array.isArray(saved.trades) || !Array.isArray(saved.orders) || !settings) throw Error('Invalid saved scalper account');
  state.scalper = { ...saved, settings };
} catch (error) {
  if (error.code !== 'ENOENT') throw error; // Never silently reset an existing ledger.
  state.scalper.settings.autoEnabled = state.paper.settings.autoEnabled;
  state.paper.settings.autoEnabled = false;
  await savePaper();
}
scalper = new Scalper(state.scalper);
scalper.reset('Server restarted; pending entries cancelled');
await saveScalper();
const server = app.listen(port, '127.0.0.1', () => console.log(`Edge Lab API: http://127.0.0.1:${port}`));
polyStream = new LiveSocket({
  url: POLYMARKET_STREAM, heartbeatText: 'PING',
  onOpen: socket => {
    if (tokenIds.size) { socket.send({ assets_ids: [...tokenIds], type: 'market' }); polySubscribed = true; }
  },
  onMessage: receiveBooks,
  onDisconnect: invalidateBooks,
  onHealth: at => {
    for (const market of state.markets) if (market.books && market.bookStreamHealthy) market.bookVerifiedAt = at;
  },
  onStatus: status => {
    Object.assign(state.feeds.polymarket, status);
    if (status.error) state.errors.polymarket = status.error; else delete state.errors.polymarket;
    pushState();
  },
}).start();
binanceStream = new LiveSocket({
  url: BINANCE_STREAM, onMessage: receiveBinance,
  onDisconnect: () => {
    state.binance = null;
    if (scalper.reset('Binance disconnected; pending entries cancelled')) void saveScalper().catch(console.error);
    state.scalper.scan = scalper.scan;
  },
  onStatus: status => {
    Object.assign(state.feeds.binance, status);
    if (status.error) state.errors.binance = status.error; else delete state.errors.binance;
    pushState();
  },
}).start();
void tick().catch(e => console.error('Initial refresh:', e));
const housekeeping = setInterval(() => void tick().catch(e => console.error('Refresh:', e)), 1000);
const executionTimer = setInterval(() => { runScalper(); pushState(); }, 100);
let previousScans = 0, previousStatsAt = performance.now();
const statsTimer = setInterval(() => {
  const now = performance.now();
  state.engine.scansPerSecond = (state.engine.scans - previousScans) * 1000 / (now - previousStatsAt);
  previousScans = state.engine.scans; previousStatsAt = now;
  state.engine.processingP95Ms = sampleStats(processingTimes).p95;
  const lag = sampleStats(sourceLags);
  Object.assign(state.feeds.polymarket, polyStream.status, { tokens: tokenIds.size, syncedTokens: books.books.size, lagP50Ms: lag.p50, lagP95Ms: lag.p95 });
  Object.assign(state.feeds.binance, binanceStream.status);
  pushState();
}, 1000);
async function shutdown() {
  clearInterval(housekeeping); clearInterval(statsTimer); clearInterval(executionTimer);
  polyStream.stop(); binanceStream.stop(); clearTimeout(pushTimer);
  for (const client of clients) client.end();
  server.close();
  await Promise.allSettled([paperWrites, observationWrites, scalperWrites, krakenService.stop()]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
