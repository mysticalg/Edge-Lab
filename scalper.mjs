import { freshBook } from './order-book.mjs';
import { settlementWinner } from './paper.mjs';

export const SCALPER_DEFAULTS = Object.freeze({
  autoEnabled: false, shares: 10, lookbackMs: 2000, minSpotMoveBps: 2,
  maxResponseCents: 0.5, maxSpreadCents: 2, latencyMs: 250,
  bufferBps: 25, takeProfitUsd: 0.25, stopLossUsd: 0.75,
  maxHoldSeconds: 45, maxOpen: 2, cooldownSeconds: 30, dailyLossLimitUsd: 20,
});
export const SCALPER_BOUNDS = {
  shares:[5,100,true], lookbackMs:[500,5000,true], minSpotMoveBps:[0.5,50],
  maxResponseCents:[0,5], maxSpreadCents:[0.1,5], latencyMs:[100,3000,true],
  bufferBps:[0,500], takeProfitUsd:[0.05,10], stopLossUsd:[0.1,10],
  maxHoldSeconds:[5,120,true], maxOpen:[1,4,true], cooldownSeconds:[5,300,true], dailyLossLimitUsd:[1,100],
};
export function validateScalperSettings(input) {
  if (!input || typeof input.autoEnabled !== 'boolean') return null;
  const settings = { autoEnabled: input.autoEnabled };
  for (const [key,[min,max,integer]] of Object.entries(SCALPER_BOUNDS)) {
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return null;
    settings[key] = value;
  }
  return settings;
}
export function newScalperAccount() {
  return { version:1, startingCash:1000, cash:1000, settings:{...SCALPER_DEFAULTS}, trades:[], orders:[] };
}

// Fee-inclusive cash accounting at displayed depth. All fills remain hypothetical.
export function walkSide(levels, shares, side, bufferBps=25) {
  if (!(shares>0)) return { available:false };
  const sorted=(levels||[]).map(l=>({price:Number(l.price),size:Number(l.size)}))
    .filter(l=>Number.isFinite(l.price)&&l.price>0&&l.price<1&&Number.isFinite(l.size)&&l.size>0)
    .sort((a,b)=>side==='buy'?a.price-b.price:b.price-a.price);
  let remaining=shares, gross=0, fees=0;
  for(const level of sorted) {
    const qty=Math.min(remaining,level.size);
    gross+=qty*level.price;
    fees+=qty*0.07*level.price*(1-level.price);
    remaining-=qty;
    if(remaining<1e-8)break;
  }
  if(remaining>1e-8)return {available:false,reason:'Insufficient displayed depth'};
  const buffer=gross*bufferBps/10000;
  return {available:true,averagePrice:gross/shares,gross,fees,buffer,total:side==='buy'?gross+fees+buffer:gross-fees-buffer};
}
function top(book) {
  const bid=Math.max(...(book?.bids||[]).filter(x=>Number(x.size)>0).map(x=>Number(x.price)));
  const ask=Math.min(...(book?.asks||[]).filter(x=>Number(x.size)>0).map(x=>Number(x.price)));
  return bid>0&&ask<1&&ask>=bid?{bid,ask,mid:(bid+ask)/2}:null;
}
function timely(market,now) { return freshBook(market,now) && (market.bookTransport!=='websocket'||now-market.bookVerifiedAt<=1500); }
function currentFiveMinute(market,now) {
  const match=/^btc-updown-5m-(\d+)$/.exec(market.slug||'');
  return match && Number(match[1])*1000<=now && Date.parse(market.endDate)-now>30000;
}
function append(history,sample) {
  if(history.length && sample.at-history.at(-1).at<50)return;
  history.push(sample);
  if(history.length>240)history.shift();
}
function baseline(history,at) {
  for(let i=history.length-1;i>=0;i--)if(history[i].at<=at)return history[i];
  return null;
}

export class Scalper {
  constructor(account=newScalperAccount()) {
    this.account=account; this.spotHistory=[]; this.bookHistory=new Map();
    this.scan={at:null,markets:[],signalCount:0}; this.lastEntryScan=0;
  }
  cancel(order,reason,now) { order.status='cancelled'; order.reason=reason; order.finishedAt=now; }
  reset(reason,now=Date.now()) {
    this.spotHistory=[];this.bookHistory.clear();
    let changed=false;
    for(const order of this.account.orders)if(order.status==='pending'){this.cancel(order,reason,now);changed=true;}
    this.scan={at:now,markets:[],signalCount:0,reason};
    return changed;
  }
  observeSpot(spot) {
    if(!spot?.mid)return;
    if(this.spotHistory.length && spot.fetchedAt-this.spotHistory.at(-1).at>1500)this.spotHistory=[];
    append(this.spotHistory,{at:spot.fetchedAt,price:spot.mid});
  }
  observeBooks(markets,now) {
    const ids=new Set(markets.map(m=>m.id));
    for(const id of this.bookHistory.keys())if(!ids.has(id))this.bookHistory.delete(id);
    for(const market of markets) {
      if(!timely(market,now)){this.bookHistory.delete(market.id);continue;}
      const up=top(market.books?.up),down=top(market.books?.down);
      if(!up||!down)continue;
      if(!this.bookHistory.has(market.id))this.bookHistory.set(market.id,[]);
      append(this.bookHistory.get(market.id),{at:now,up:up.mid,down:down.mid});
    }
  }
  signal(market,spot,now,settings=this.account.settings) {
    const result={marketId:market.id,slug:market.slug,title:market.title,eligible:false};
    const fail=reason=>({...result,reason});
    if(!currentFiveMinute(market,now))return fail('Only current BTC 5m; at least 30s to expiry');
    if(!spot || now-spot.fetchedAt>1500 || !timely(market,now))return fail('Waiting for fresh connected feeds');
    if(market.feeType!=='crypto_fees_v2')return fail('Unsupported fee schedule');
    const reference=baseline(this.spotHistory,now-settings.lookbackMs);
    const contract=baseline(this.bookHistory.get(market.id)||[],now-settings.lookbackMs);
    if(!reference||!contract||now-settings.lookbackMs-reference.at>300||now-settings.lookbackMs-contract.at>300)return fail('Warming up synchronized history');
    const moveBps=(spot.mid/reference.price-1)*10000;
    Object.assign(result,{moveBps,side:moveBps>=0?'up':'down'});
    if(Math.abs(moveBps)<settings.minSpotMoveBps)return fail('BTC move below threshold');
    const book=market.books[result.side],price=top(book);
    if(!price)return fail('No usable bid / ask');
    const responseCents=(price.mid-contract[result.side])*100,spreadCents=(price.ask-price.bid)*100;
    Object.assign(result,{responseCents,spreadCents,ask:price.ask,bid:price.bid});
    if(price.ask<0.05||price.ask>0.95)return fail('Outcome price outside 5–95¢');
    if(responseCents>settings.maxResponseCents+1e-8)return fail('Polymarket already moved');
    if(spreadCents>settings.maxSpreadCents+1e-8)return fail('Spread too wide');
    const entry=walkSide(book.asks,settings.shares,'buy',settings.bufferBps);
    const exit=walkSide(book.bids,settings.shares,'sell',settings.bufferBps);
    if(!entry.available||!exit.available||settings.shares<market.minSize)return fail('Insufficient size / depth');
    result.roundTripCost=entry.total-exit.total;
    result.entryPrice=entry.averagePrice;
    if(result.roundTripCost>=settings.stopLossUsd)return fail('Round-trip costs exceed stop-loss budget');
    result.eligible=true;result.reason='Spot moved; contract response below limit';
    return result;
  }
  dailyLoss(now) {
    const day=new Date(now).toISOString().slice(0,10);
    const realized=this.account.trades.filter(t=>t.closedAt&&new Date(t.closedAt).toISOString().startsWith(day)).reduce((n,t)=>n+t.realizedNet,0);
    const losses=this.account.trades.filter(t=>t.status==='open').reduce((n,t)=>n+(Number.isFinite(t.markNet)?Math.min(0,t.markNet):-t.entryCost),0);
    return Math.max(0,-realized-losses);
  }
  gate(marketId,now,excludingOrderId) {
    const a=this.account,s=a.settings;
    if(!s.autoEnabled)return 'Auto entries stopped';
    if(this.dailyLoss(now)>=s.dailyLossLimitUsd)return 'Daily paper loss limit reached';
    const open=a.trades.filter(t=>t.status==='open');
    const pending=a.orders.filter(o=>o.status==='pending'&&o.id!==excludingOrderId);
    if(open.length+pending.length>=s.maxOpen)return 'Maximum open / pending positions reached';
    if(open.some(t=>t.marketId===marketId)||pending.some(o=>o.marketId===marketId))return 'Position already open / pending';
    if(a.trades.some(t=>t.marketId===marketId&&now-(t.closedAt||t.openedAt)<s.cooldownSeconds*1000))return 'Market cooldown';
    if(a.orders.some(o=>o.marketId===marketId&&o.status==='cancelled'&&now-o.finishedAt<1000))return 'Retry cooldown';
    return null;
  }
  step(markets,spot,now=Date.now()) {
    const a=this.account; let changed=false;
    // Exits run even when entries have been stopped or Binance is unavailable.
    for(const trade of a.trades.filter(t=>t.status==='open')) {
      const market=markets.find(m=>m.id===trade.marketId);
      const end=Date.parse(trade.endDate),fresh=timely(market,now)&&now<end;
      const quote=fresh?walkSide(market.books[trade.side].bids,trade.shares,'sell',trade.rules.bufferBps):{available:false};
      trade.markNet=quote.available?quote.total-trade.entryCost:null;
      trade.markProceeds=quote.available?quote.total:null;
      trade.markAt=quote.available?now:null;
      const signedMove=spot&&now-spot.fetchedAt<=1500?(spot.mid/trade.entrySpot-1)*10000*(trade.side==='up'?1:-1):null;
      let reason=trade.manualClose?'Manual exit':now>=end-15000?'Before expiry':now-trade.openedAt>=trade.rules.maxHoldSeconds*1000?'Time limit':
        trade.markNet!=null&&trade.markNet>=trade.rules.takeProfitUsd?'Take profit':trade.markNet!=null&&trade.markNet<=-trade.rules.stopLossUsd?'Stop loss':
        signedMove!=null&&signedMove<=-trade.rules.minSpotMoveBps?'Spot reversed':null;
      if(reason&&!trade.exitRequestedAt){trade.exitRequestedAt=now;trade.exitDueAt=now+trade.rules.latencyMs;trade.exitReason=reason;changed=true;}
      if(trade.exitRequestedAt&&now>=trade.exitDueAt) {
        if(!quote.available){
          const message=now>=end?'Awaiting verified resolution':!fresh?'Exit blocked: stale book':'Exit blocked: insufficient bid depth';
          if(trade.exitBlocked!==message){trade.exitBlocked=message;changed=true;}
        } else {
          Object.assign(trade,{status:'closed',closedAt:now,exitPrice:quote.averagePrice,exitFees:quote.fees,exitBuffer:quote.buffer,
            proceeds:quote.total,realizedNet:quote.total-trade.entryCost,exitBlocked:null});
          a.cash+=quote.total;changed=true;
        }
      }
    }
    // Recheck price, signal, liquidity and risk after the modeled order latency.
    for(const order of a.orders.filter(o=>o.status==='pending'&&now>=o.executeAt)) {
      const market=markets.find(m=>m.id===order.marketId);
      const reason=this.gate(order.marketId,now,order.id);
      const signal=market?this.signal(market,spot,now,order.rules):null;
      if(reason||!signal?.eligible||signal.side!==order.side||now-order.executeAt>1000){this.cancel(order,reason||'Signal expired or changed during latency',now);changed=true;continue;}
      const fill=walkSide(market.books[order.side].asks,order.rules.shares,'buy',order.rules.bufferBps);
      if(!fill.available||fill.averagePrice>order.limitPrice+1e-8||fill.total>a.cash){this.cancel(order,'Entry price moved, depth missing, or insufficient cash',now);changed=true;continue;}
      const trade={id:crypto.randomUUID(),marketId:market.id,slug:market.slug,title:market.title,endDate:market.endDate,
        upId:market.upId,downId:market.downId,feeType:market.feeType,minSize:market.minSize,resolutionSource:market.resolutionSource,
        side:order.side,status:'open',shares:order.rules.shares,openedAt:now,signalAt:order.requestedAt,entrySpot:spot.mid,
        entryPrice:fill.averagePrice,entryCost:fill.total,entryFees:fill.fees,entryBuffer:fill.buffer,
        signalMoveBps:order.signal.moveBps,signalResponseCents:order.signal.responseCents,rules:{...order.rules},
        fillAssumption:'Full displayed ask depth after modeled latency; no queue position or actual fill verified.'};
      a.cash-=fill.total;a.trades.unshift(trade);order.status='filled';order.tradeId=trade.id;order.finishedAt=now;changed=true;
    }
    // Trigger on source events, keeping diagnostics and candidate work to <=100Hz.
    if(now-this.lastEntryScan>=10) {
      this.lastEntryScan=now;
      const signals=markets.filter(m=>/^btc-updown-5m-/.test(m.slug)).map(m=>this.signal(m,spot,now));
      for(const signal of signals) {
        const blocked=this.gate(signal.marketId,now);signal.blocked=blocked;
        if(!signal.eligible||blocked)continue;
        a.orders.unshift({id:crypto.randomUUID(),marketId:signal.marketId,slug:signal.slug,side:signal.side,status:'pending',
          requestedAt:now,executeAt:now+a.settings.latencyMs,limitPrice:signal.entryPrice+0.005,
          signal:{...signal},rules:{...a.settings}});
        // Bound old order diagnostics; active orders are always retained.
        a.orders=a.orders.filter((o,i)=>o.status==='pending'||i<200);
        changed=true;
      }
      this.scan={at:now,markets:signals,signalCount:signals.filter(s=>s.eligible).length,dailyLoss:this.dailyLoss(now),
        reason:a.settings.autoEnabled?'Waiting for qualifying lead/lag signals':'Auto entries stopped; open positions still managed'};
    }
    return changed;
  }
  settle(trade,event,now=Date.now()) {
    if(trade.status!=='open')return false;
    const winner=settlementWinner(event);if(!winner)return false;
    const proceeds=winner.toLowerCase()===trade.side?trade.shares:0;
    Object.assign(trade,{status:'settled',winner,closedAt:now,proceeds,realizedNet:proceeds-trade.entryCost,exitReason:'Verified resolution',exitBlocked:null});
    this.account.cash+=proceeds;return true;
  }
}
