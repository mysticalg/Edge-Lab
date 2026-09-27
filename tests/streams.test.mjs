import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { OrderBooks, freshBook } from '../order-book.mjs';
import { LiveSocket } from '../streams.mjs';
import { DEFAULT_PAPER_SETTINGS, enterPaperPair } from '../paper.mjs';

const snapshot = (id, timestamp = 1000) => ({ event_type: 'book', asset_id: id, timestamp: String(timestamp), bids: [{ price: '.40', size: '10' }], asks: [{ price: '.45', size: '10' }, { price: '.50', size: '20' }] });
const delta = (id, size, timestamp = 1001) => ({ event_type: 'price_change', timestamp: String(timestamp), price_changes: [{ asset_id: id, side: 'SELL', price: '.45', size: String(size) }] });

test('stream books require snapshots, replace quantities, remove zero levels, and ignore older events', () => {
  const cache = new OrderBooks(), ids = new Set(['up','down']);
  cache.apply(delta('up', 999), ids);
  assert.equal(cache.get('up'), undefined);
  cache.apply([snapshot('up'), snapshot('down')], ids);
  cache.apply(delta('up', 3), ids);
  assert.equal(cache.get('up').asks.get(.45), 3);
  cache.apply(delta('up', 999, 999), ids);
  cache.apply(snapshot('up', 999), ids);
  assert.equal(cache.get('up').asks.get(.45), 3);
  cache.apply(delta('up', 0, 1002), ids);
  assert.deepEqual(cache.snapshot('up').asks, [{ price: .50, size: 20 }]);
  cache.retain(new Set(['down']));
  assert.equal(cache.get('up'), undefined);
  cache.clear();
  cache.apply(delta('down', 3, 1003), ids);
  assert.equal(cache.books.size, 0);
});

test('both legs of a frame are applied before a paper decision; disconnect and lost heartbeat block entry', () => {
  const now = 100000, cache = new OrderBooks(), ids = new Set(['up','down']);
  cache.apply([snapshot('up', now), snapshot('down', now)], ids, now);
  const change = delta('up', 0, now+1);
  change.price_changes.push({ asset_id:'down', side:'SELL', price:'.45', size:'0' });
  cache.apply(change, ids, now+1);
  const market = { id:'test', endDate:new Date(now+120000).toISOString(), feeType:'crypto_fees_v2',
    books:{up:cache.snapshot('up'),down:cache.snapshot('down')}, bookTransport:'websocket',
    bookStreamHealthy:true, bookVerifiedAt:now, bookSourceAt:now };
  const account = { cash:1000, trades:[], settings:{...DEFAULT_PAPER_SETTINGS} };
  assert.match(enterPaperPair(account,market,10,25,'auto',now).error,/threshold/);
  assert.equal(account.trades.length,0);
  // Quiet books remain valid while the same connection is alive, without faking source timestamps.
  market.bookVerifiedAt=now+60000;
  assert.equal(freshBook(market,now+60000),true);
  assert.equal(freshBook(market,now+86000),false);
  market.bookStreamHealthy=false;
  assert.match(enterPaperPair(account,market,10,25,'manual',now+60000).error,/stale/);
});

test('malformed depth fails closed instead of creating a tradable partial book', () => {
  const cache=new OrderBooks(), ids=new Set(['up']);
  assert.throws(() => cache.apply({...snapshot('up'), asks:[{price:'.5',size:'NaN'}]},ids),/Invalid book level/);
  assert.equal(cache.get('up'),undefined);
});

test('socket reconnects, resubscribes, invalidates old depth and measures heartbeat round trip', { timeout:4000 }, async t => {
  const server = new WebSocketServer({ port:0 });
  await new Promise(resolve => server.on('listening',resolve));
  const cache=new OrderBooks(), ids=new Set(['up']);
  let connections=0, subscriptions=0, invalidations=0, client;
  t.after(() => { client?.stop(); for(const socket of server.clients) socket.terminate(); server.close(); });
  const complete=new Promise((resolve,reject) => {
    server.on('connection', socket => {
      const generation=++connections;
      socket.on('message', raw => {
        const message=raw.toString();
        if(message==='PING') { socket.send('PONG'); return; }
        assert.deepEqual(JSON.parse(message),{type:'market',assets_ids:['up']});
        subscriptions++;
        if(generation===1) {
          socket.send(JSON.stringify(snapshot('up')));
          setTimeout(()=>socket.close(),30);
        } else {
          try { assert.equal(cache.books.size,0); } catch(error) { reject(error); }
          socket.send(JSON.stringify(snapshot('up',2000)));
          setTimeout(resolve,50);
        }
      });
    });
  });
  client=new LiveSocket({url:`ws://127.0.0.1:${server.address().port}`,heartbeatText:'PING',heartbeatMs:10,staleMs:100,retryMs:10,
    onOpen:socket=>socket.send({type:'market',assets_ids:['up']}),
    onMessage:events=>cache.apply(events,ids),
    onDisconnect:()=>{invalidations++;cache.clear();},
  }).start();
  await complete;
  assert.equal(subscriptions,2);
  assert.equal(cache.get('up').timestamp,2000);
  assert.ok(invalidations>=1);
  assert.ok(client.status.roundTripMs>=0);
});

test('silent connection times out and immediately invalidates cached books', {timeout:3000}, async t => {
  const server=new WebSocketServer({port:0});
  await new Promise(resolve=>server.on('listening',resolve));
  let client;
  t.after(()=>{client?.stop();for(const socket of server.clients)socket.terminate();server.close();});
  const disconnected=new Promise(resolve=>{
    client=new LiveSocket({url:`ws://127.0.0.1:${server.address().port}`,heartbeatText:'PING',heartbeatMs:10,staleMs:30,retryMs:1000,
      onMessage:()=>{},onDisconnect:resolve,
    }).start();
  });
  await disconnected;
  assert.match(client.status.error,/timed out/);
});
