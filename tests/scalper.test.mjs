import test from 'node:test';
import assert from 'node:assert/strict';
import { Scalper, newScalperAccount, validateScalperSettings, walkSide } from '../scalper.mjs';

const now=1_800_000_100_000;
const book=(bid=.49,ask=.50,size=100)=>({bids:[{price:bid,size}],asks:[{price:ask,size}]});
function fixture(direction=1) {
  const a=newScalperAccount();a.settings.autoEnabled=true;
  const e=new Scalper(a);
  const m={id:'test',slug:'btc-updown-5m-1800000000',title:'BTC test',endDate:new Date(now+200000).toISOString(),
    feeType:'crypto_fees_v2',minSize:5,bookTransport:'websocket',bookStreamHealthy:true,bookVerifiedAt:now,
    books:{up:book(),down:book()},upId:'u',downId:'d'};
  const spot={mid:100000*(1+direction*.0003),fetchedAt:now};
  e.observeSpot({mid:100000,fetchedAt:now-2000});e.observeBooks([m],now-2000);
  e.observeSpot({mid:100000,fetchedAt:now-1000});
  e.observeSpot(spot);e.observeBooks([m],now);
  return {a,e,m,spot};
}
function enter(f) {
  f.e.step([f.m],f.spot,now);
  assert.equal(f.a.orders[0].status,'pending');assert.equal(f.a.cash,1000);
  f.e.step([f.m],f.spot,now+249);assert.equal(f.a.trades.length,0);
  f.e.step([f.m],f.spot,now+250);
  assert.equal(f.a.trades.length,1);assert.equal(f.a.orders[0].status,'filled');
  return f.a.trades[0];
}
test('up and down signals require a spot move with lagging contract and current window',()=>{
  for(const direction of [1,-1]) {
    const f=fixture(direction),s=f.e.signal(f.m,f.spot,now);
    assert.equal(s.eligible,true);assert.equal(s.side,direction===1?'up':'down');
    assert.equal(f.e.signal(f.m,{...f.spot,mid:100000},now).eligible,false);
    assert.equal(f.e.signal({...f.m,slug:'btc-updown-5m-1800000300'},f.spot,now).eligible,false);
    assert.equal(f.e.signal({...f.m,endDate:new Date(now+20000).toISOString()},f.spot,now).eligible,false);
    f.m.books[s.side]=book(.51,.52);
    assert.match(f.e.signal(f.m,f.spot,now).reason,/already moved/);
  }
});
test('signals reject stale feeds, missing depth, unsupported fees and cold history',()=>{
  const f=fixture();
  assert.match(f.e.signal(f.m,{...f.spot,fetchedAt:now-1600},now).reason,/fresh/);
  assert.match(f.e.signal({...f.m,bookStreamHealthy:false},f.spot,now).reason,/fresh/);
  assert.match(f.e.signal({...f.m,feeType:'unknown'},f.spot,now).reason,/fee/);
  f.m.books.up.bids=[];assert.equal(f.e.signal(f.m,f.spot,now).eligible,false);
  f.m.books.up=book(.49,.50,4);assert.match(f.e.signal(f.m,f.spot,now).reason,/depth/);
  f.e.reset('test');assert.match(f.e.signal(f.m,f.spot,now).reason,/history/);
});
test('depth walk charges fees and buffer on both sides, refuses partial quantity',()=>{
  const buy=walkSide([{price:.51,size:6},{price:.5,size:4}],10,'buy',25);
  assert.ok(Math.abs(buy.gross-5.06)<1e-10);
  assert.ok(Math.abs(buy.fees-(4*.07*.5*.5+6*.07*.51*.49))<1e-10);
  assert.equal(buy.total,buy.gross+buy.fees+buy.buffer);
  const sell=walkSide([{price:.49,size:6},{price:.5,size:4}],10,'sell',25);
  assert.equal(sell.total,sell.gross-sell.fees-sell.buffer);
  assert.equal(walkSide([{price:.5,size:9}],10,'sell').available,false);
});
test('latency fill debits cash once; take profit exits at bids after delay and all costs',()=>{
  const f=fixture(),t=enter(f);
  assert.equal(f.a.cash,1000-t.entryCost);assert.equal(t.side,'up');
  f.m.books.up=book(.58,.59);f.m.bookVerifiedAt=now+500;
  f.e.step([f.m],f.spot,now+500);
  assert.equal(t.status,'open');assert.equal(t.exitReason,'Take profit');
  f.e.step([f.m],null,now+750);
  assert.equal(t.status,'closed');assert.equal(t.exitPrice,.58);
  assert.ok(t.realizedNet>0);assert.equal(f.a.cash,1000+t.realizedNet);
  f.e.step([f.m],null,now+800);assert.equal(f.a.cash,1000+t.realizedNet);
});
test('signal expiry, insufficient cash and entry price changes cancel pending orders',()=>{
  for(const scenario of ['expired','cash','price']) {
    const f=fixture();f.e.step([f.m],f.spot,now);
    if(scenario==='expired')f.spot.mid=100000;
    if(scenario==='cash')f.a.cash=1;
    if(scenario==='price')f.m.books.up=book(.49,.507);
    f.e.step([f.m],f.spot,now+250);
    assert.equal(f.a.orders[0].status,'cancelled',scenario);assert.equal(f.a.trades.length,0);
  }
});
test('stop loss records an actual paper loss, with exits managed while auto is off',()=>{
  const f=fixture(-1),t=enter(f);f.a.settings.autoEnabled=false;
  f.m.books.down=book(.4,.41);f.m.bookVerifiedAt=now+500;
  f.e.step([f.m],null,now+500);assert.equal(t.exitReason,'Stop loss');
  f.e.step([f.m],null,now+750);
  assert.equal(t.status,'closed');assert.ok(t.realizedNet<-.75);
  assert.equal(f.a.cash,1000+t.realizedNet);
});
test('stale or thin exits remain open and never fabricate proceeds; recovery permits exit',()=>{
  const f=fixture(),t=enter(f),cash=f.a.cash;t.manualClose=true;
  f.e.step([f.m],null,now+500);
  f.m.bookStreamHealthy=false;f.e.step([f.m],null,now+750);
  assert.equal(t.markNet,null);assert.equal(t.status,'open');assert.match(t.exitBlocked,/stale/);
  assert.equal(f.a.cash,cash);
  f.m.bookStreamHealthy=true;f.m.books.up.bids=[{price:.49,size:1}];
  f.e.step([f.m],null,now+800);assert.match(t.exitBlocked,/depth/);assert.equal(f.a.cash,cash);
  f.m.books.up=book();f.e.step([f.m],null,now+850);
  assert.equal(t.status,'closed');assert.ok(t.realizedNet<0);
});
test('position limits, daily losses and cooldown block further entries',()=>{
  const f=fixture(),t=enter(f);
  assert.match(f.e.gate(f.m.id,now+300),/already open/);
  f.a.settings.maxOpen=1;assert.match(f.e.gate('other',now+300),/Maximum/);
  f.a.settings.maxOpen=2;t.status='closed';t.closedAt=now+300;t.realizedNet=-1;
  assert.match(f.e.gate(f.m.id,now+400),/cooldown/);
  t.realizedNet=-21;assert.match(f.e.gate('other',now+400),/loss limit/);
});
test('restart cancels pending entries and winning/losing resolution credits only once',()=>{
  const f=fixture();f.e.step([f.m],f.spot,now);f.e.reset('restart',now+100);
  assert.equal(f.a.orders[0].status,'cancelled');assert.equal(f.a.cash,1000);
  for(const direction of [1,-1]) {
    const g=fixture(direction),t=enter(g),cash=g.a.cash;
    const market={closed:true,umaResolutionStatus:'proposed',outcomes:['Up','Down'],outcomePrices:['1','0']};
    assert.equal(g.e.settle(t,{markets:[market]},now+200000),false);
    market.umaResolutionStatus='resolved';
    assert.equal(g.e.settle(t,{markets:[market]},now+200000),true);
    assert.equal(g.a.cash,cash+(direction===1?10:0));
    assert.equal(g.e.settle(t,{markets:[market]},now+200001),false);
  }
});
test('settings reject invalid risk, latency and sizes',()=>{
  const s=newScalperAccount().settings;assert.deepEqual(validateScalperSettings(s),s);
  for(const patch of [{latencyMs:0},{shares:2},{shares:5.5},{autoEnabled:'true'},{stopLossUsd:NaN},{dailyLossLimitUsd:0}])
    assert.equal(validateScalperSettings({...s,...patch}),null);
});
