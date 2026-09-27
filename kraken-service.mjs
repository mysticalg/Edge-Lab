import { scanTriangles } from './kraken-triangles.mjs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LiveSocket } from './streams.mjs';
import { KrakenPaper, STREAM_SYMBOLS, newAccount, settings } from './kraken-paper.mjs';
import { accountReader } from './kraken-account.mjs';
import { KrakenLive } from './kraken-live.mjs';
import { KrakenMaker, newMakerAccount, makerSettings, MAKER_SYMBOLS } from './kraken-maker.mjs';

export async function installKraken(app, root, state, pushState) {
  const file = join(root, 'data', 'kraken-paper-v1.json');
  let account;
  try { account = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; account = newAccount(); }
  const engine = new KrakenPaper(account);
  const makerFile = join(root, 'data', 'kraken-maker-v1.json');
  let makerAccount;
  try { makerAccount = JSON.parse(await readFile(makerFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; makerAccount = newMakerAccount(); }
  const maker = new KrakenMaker(engine, makerAccount);
  let makerWrites = Promise.resolve();
  function saveMaker() {
    const data = JSON.stringify(makerAccount, null, 2);
    makerWrites = makerWrites.catch(() => {}).then(async () => {
      await mkdir(dirname(makerFile), { recursive: true });
      await writeFile(makerFile + '.tmp', data); await rename(makerFile + '.tmp', makerFile);
    }).catch(error => {
      maker.persistenceError = `Maker ledger save failed: ${error.message}. Simulation paused; restart after fixing storage.`;
      makerAccount.settings.autoEnabled = false;
      // Do not simulate additional fills while durable inventory is uncertain.
      maker.reset('Persistence failure; paper orders cancelled');
      publish(); throw error;
    });
    return makerWrites;
  }
  const reader = accountReader(root);
  await reader.stored();
  const liveFile = join(root, 'data', 'kraken-live-v1.json');
  let journal;
  try { journal = JSON.parse(await readFile(liveFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let liveWrites = Promise.resolve();
  const live = new KrakenLive({ reader, engine, journal, save: data => {
    const json = JSON.stringify(data, null, 2);
    liveWrites = liveWrites.catch(() => {}).then(async () => {
      await mkdir(dirname(liveFile), { recursive: true });
      await writeFile(liveFile + '.tmp', json); await rename(liveFile + '.tmp', liveFile);
    });
    return liveWrites;
  } });
  const liveCsrf = crypto.randomUUID();
  let writes = Promise.resolve(), persistenceError = null, metadataError = null, stopped = false, socket;
  const feed = { status: 'connecting' };
  function syncFees() { engine.accountFees = reader.status.feePctByPair; engine.makerFees = reader.status.makerFeePctByPair; engine.feesCheckedAt = reader.status.checkedAt || 0; }
  function publish() {
    syncFees(); if (socket) Object.assign(feed, socket.status);
    const comparison = Object.create(engine);
    comparison.account = { settings: { ...account.settings, spend: makerAccount.settings.spend, bufferBps: makerAccount.settings.bufferBps } };
    state.kraken = { ...engine.view(), triangles: scanTriangles(engine), maker: { ...maker.view(), takerComparison: scanTriangles(comparison) },
      feed, persistenceError, metadataError, accountConnection: reader.status, live: { ...live.view(), csrf: liveCsrf }, liveOrdersEnabled: live.view().armed };
    pushState();
  }
  function save() {
    const data = JSON.stringify(account, null, 2);
    writes = writes.catch(() => {}).then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file + '.tmp', data); await rename(file + '.tmp', file);
      persistenceError = null;
    }).catch(error => { persistenceError = `Paper ledger cannot be saved: ${error.message}. Execution paused.`; account.settings.autoEnabled = false; publish(); throw error; });
    return writes;
  }
  function step() {
    syncFees();
    if (!persistenceError && engine.step()) void save().catch(() => {});
    if (!maker.persistenceError && maker.step()) void saveMaker().catch(() => {});
    publish();
  }
  async function metadata() {
    try {
      const response = await fetch('https://api.kraken.com/0/public/AssetPairs?pair=XBTGBP,ETHGBP,SOLGBP,XDGGBP,PEPEGBP,WIFGBP,ETHXBT,SOLXBT', { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw Error(`Kraken pair metadata HTTP ${response.status}`);
      const body = await response.json();
      if (body.error?.length) throw Error(body.error.join('; '));
      const next = {};
      for (const pair of Object.values(body.result || {})) {
        const symbol = pair.wsname?.replace('XBT/', 'BTC/').replace('XDG/', 'DOGE/').replace('/XBT', '/BTC');
        if (!STREAM_SYMBOLS.includes(symbol)) continue;
        const orderMin = Number(pair.ordermin), costMin = Number(pair.costmin), lotDecimals = Number(pair.lot_decimals);
        if (!(orderMin > 0 && costMin > 0 && Number.isInteger(lotDecimals) && lotDecimals >= 0 && lotDecimals <= 12)) throw Error('Invalid Kraken order minimum metadata');
        next[symbol] = { orderMin, costMin, lotDecimals, tickSize: Number(pair.tick_size), pairDecimals: Number(pair.pair_decimals), status: pair.status, at: Date.now() };
      }
      if (Object.keys(next).length !== STREAM_SYMBOLS.length) throw Error('Kraken did not return all requested GBP pairs');
      if (!stopped) { engine.metadata = next; metadataError = null; }
    } catch (error) { metadataError = error.message; }
    if (!stopped) publish();
  }
  await save();
  await saveMaker();
  socket = new LiveSocket({
    url: 'wss://ws.kraken.com/v2', heartbeatMs: 2000, staleMs: 5000,
    onOpen: stream => {
      engine.connected = true;
      stream.send({ method: 'subscribe', params: { channel: 'ticker', symbol: STREAM_SYMBOLS, event_trigger: 'bbo', snapshot: true } });
      stream.send({ method: 'subscribe', params: { channel: 'trade', symbol: MAKER_SYMBOLS, snapshot: false } });
    },
    onHealth: at => { engine.healthAt = at; },
    onMessage: (message, at) => {
      engine.receive(message, at); syncFees();
      if (!maker.persistenceError && maker.receive(message, at)) void saveMaker().catch(() => {});
      step();
    },
    onDisconnect: () => {
      if (engine.disconnect()) void save().catch(() => {});
      if (maker.reset('Kraken disconnected; paper quotes cancelled') && !maker.persistenceError) void saveMaker().catch(() => {});
      publish();
    },
    onStatus: status => { Object.assign(feed, status); if (!status.error) delete feed.error; publish(); },
  }).start();
  const timer = setInterval(step, 100), metaTimer = setInterval(() => void metadata(), 600000);
  void metadata();
  // Local JSON only. Live routes additionally require an Origin and a per-run
  // CSRF token. The paper engine has no reference to the live submit method.
  app.use('/api/kraken', (req, res, next) => {
    if (req.method !== 'GET') {
      const origin = req.get('origin');
      if (origin && !['http://127.0.0.1:5178', 'http://localhost:5178', 'http://127.0.0.1:4178', 'http://localhost:4178'].includes(origin)) return res.status(403).json({ error: 'Local app origin required' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
      if (persistenceError && !req.path.startsWith('/live/')) return res.status(503).json({ error: persistenceError });
    }
    next();
  });
  const mutate = action => async (req, res) => {
    try { action(req.body); await save(); publish(); res.json({ ok: true, settings: account.settings, message: account.lastAction }); }
    catch (error) { res.status(persistenceError ? 503 : 400).json({ error: error.message }); }
  };
  app.post('/api/kraken/settings', mutate(body => {
    account.settings = settings(body);
    if (!account.settings.autoEnabled && account.pending?.mode === 'auto momentum') account.pending = null;
    account.lastAction = `Auto paper entries ${account.settings.autoEnabled ? 'enabled' : 'disabled'}; existing positions retain their exit rules`;
  }));
  app.post('/api/kraken/enter', mutate(body => engine.request(body.symbol)));
  app.post('/api/kraken/account/check', async (_req, res) => {
    await reader.refresh(); publish();
    res.json({ ok: reader.status.connected, message: reader.status.error || 'Kraken available balances, fees and API permissions checked. No orders placed.' });
  });
  app.post('/api/kraken/maker/settings', async (req, res) => {
    try {
      if (maker.persistenceError) throw Error(maker.persistenceError);
      const next = makerSettings(req.body);
      maker.cancel('Maker rules changed; old paper quote cancelled');
      makerAccount.settings = next;
      makerAccount.lastAction = next.autoEnabled ? 'Maker paper entries enabled; waiting for an eligible route' : 'New maker entries stopped; existing inventory still managed';
      await saveMaker(); publish(); res.json({ settings: next, message: makerAccount.lastAction });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/api/kraken/maker/unwind', async (_req, res) => {
    try {
      if (maker.persistenceError) throw Error(maker.persistenceError);
      makerAccount.settings.autoEnabled = false; maker.unwind();
      await saveMaker(); publish(); res.json({ message: 'New entries stopped. Paper unwind requested; waits for cancellation, latency, fresh fees and sufficient GBP bid depth.' });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.get('/api/kraken/maker/trades.csv', (_req, res) => {
    const fields = ['id', 'openedAt', 'closedAt', 'route', 'status', 'phase', 'asset', 'quantity', 'spent', 'returnedGbp', 'realizedNet', 'reason', 'blocked', 'rebates', 'dust', 'legs'];
    const cell = value => `"${String(typeof value === 'object' && value !== null ? JSON.stringify(value) : value ?? '').replaceAll('"', '""')}"`;
    res.type('text/csv').attachment('edge-lab-kraken-maker-paper.csv').send([fields.join(','), ...makerAccount.cycles.map(c => fields.map(f => cell(c[f])).join(','))].join('\r\n'));
  });
  app.get('/api/kraken/maker/orders.csv', (_req, res) => {
    const fields = ['id', 'requestedAt', 'activeAt', 'closedAt', 'route', 'symbol', 'price', 'quantity', 'filled', 'initialQueue', 'queueAhead', 'estimatedNet', 'status', 'reason'];
    const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    res.type('text/csv').attachment('edge-lab-kraken-maker-attempts.csv').send([fields.join(','), ...makerAccount.orders.map(o => fields.map(f => cell(o[f])).join(','))].join('\r\n'));
  });
  app.use('/api/kraken/live', (req, res, next) => {
    if (!req.get('origin') || req.get('x-edge-live') !== liveCsrf) return res.status(403).json({ error: 'Open the local app to use manual live controls' });
    next();
  });
  const liveAction = action => async (req, res) => {
    try { const result = await action(req.body); publish(); res.json({ ok: true, result }); }
    catch (error) { publish(); res.status(409).json({ error: error.message }); }
  };
  app.post('/api/kraken/live/arm', liveAction(body => {
    if (typeof body.enabled !== 'boolean') throw Error('Invalid live switch');
    live.arm(body.enabled); return live.view();
  }));
  app.post('/api/kraken/live/preview', liveAction(body => live.preview(body)));
  app.post('/api/kraken/live/submit', liveAction(body => live.submit(body.previewId, body.confirmation)));
  app.post('/api/kraken/live/reconcile', liveAction(() => live.reconcile()));
  app.get('/api/kraken/live-orders.csv', (_req, res) => {
    const fields = ['id', 'clientId', 'txid', 'submittedAt', 'symbol', 'side', 'status', 'quantity', 'limitPrice', 'feePct', 'filledQuantity', 'executedCost', 'reportedFee', 'checkedAt', 'error'];
    const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    res.type('text/csv').attachment('edge-lab-kraken-real-orders.csv').send([fields.join(','), ...live.journal.orders.map(o => fields.map(f => cell(o[f])).join(','))].join('\r\n'));
  });
  const livePoll = setInterval(() => {
    if (!live.busy && live.journal.orders.some(order => ['submitting', 'submitted', 'pending', 'open', 'unknown'].includes(order.status))) void live.reconcile().then(publish).catch(() => {});
  }, 15000);
  app.post('/api/kraken/close', mutate(body => { engine.close(body.tradeId); account.lastAction = 'Paper exit requested; waiting for latency and fresh bid quantity'; }));
  app.get('/api/kraken/trades.csv', (_req, res) => {
    const fields = ['id', 'symbol', 'mode', 'status', 'openedAt', 'closedAt', 'quantity', 'entryPrice', 'entryFee', 'totalCost', 'exitPrice', 'exitFee', 'proceeds', 'realizedNet', 'exitReason', 'fillAssumption'];
    const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    res.type('text/csv').attachment('edge-lab-kraken-paper-gbp.csv').send([fields.join(','), ...account.trades.map(t => fields.map(f => cell(t[f])).join(','))].join('\r\n'));
  });
  publish();
  return { async stop() { stopped = true; live.arm(false); clearInterval(timer); clearInterval(metaTimer); clearInterval(livePoll); socket.stop(); await Promise.allSettled([writes, liveWrites, makerWrites]); } };
}
