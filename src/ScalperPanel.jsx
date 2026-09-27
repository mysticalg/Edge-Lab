import React, { useEffect, useState } from 'react';
import { SCALPER_BOUNDS } from '../scalper.mjs';
import './scalper.css';

const cash = n => Number.isFinite(n) ? `${n<0?'-':''}$${Math.abs(n).toFixed(2)}` : '—';
const number = (n,d=2) => Number.isFinite(n) ? n.toFixed(d) : '—';
const clock = n => n ? new Date(n).toLocaleTimeString('en-GB') : '—';
const controls = [
  ['shares','Shares per entry'],['minSpotMoveBps','Minimum BTC move · bps'],['lookbackMs','Lookback · ms'],
  ['maxResponseCents','Maximum contract response · cents'],['maxSpreadCents','Maximum spread · cents'],
  ['latencyMs','Order latency · ms'],['bufferBps','Extra cost each way · bps'],
  ['takeProfitUsd','Take profit after costs · USD'],['stopLossUsd','Stop loss after costs · USD'],
  ['maxHoldSeconds','Maximum hold · seconds'],['maxOpen','Maximum open positions'],
  ['cooldownSeconds','Market cooldown · seconds'],['dailyLossLimitUsd','Daily loss limit · USD'],
];
export default function ScalperPanel({ account, connection, notify }) {
  const [draft,setDraft]=useState(null),[saving,setSaving]=useState(false);
  useEffect(()=>{if(account?.settings)setDraft(old=>old||account.settings);},[account?.settings]);
  if(!account||!draft)return <div className="panel">Connecting to the paper scalper…</div>;
  const trades=account.trades||[],open=trades.filter(t=>t.status==='open'),closed=trades.filter(t=>t.status!=='open');
  const realized=closed.reduce((n,t)=>n+(t.realizedNet||0),0),marksKnown=open.every(t=>Number.isFinite(t.markNet));
  const unrealized=marksKnown?open.reduce((n,t)=>n+t.markNet,0):null;
  const equity=marksKnown?account.cash+open.reduce((n,t)=>n+t.markProceeds,0):null;
  const pending=account.orders.filter(o=>o.status==='pending');
  const save=async enabled=>{
    setSaving(true);
    try {
      const body={autoEnabled:enabled};for(const [key]of controls)body[key]=Number(draft[key]);
      const response=await fetch('/api/scalper/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const result=await response.json();if(!response.ok)throw Error(result.error);
      setDraft(result.settings);notify(enabled?'Latency scalper paper entries enabled.':'New scalper entries stopped. Open positions continue to be managed.');
    }catch(error){notify(error.message);}finally{setSaving(false);}
  };
  const close=async tradeId=>{
    try {const response=await fetch('/api/scalper/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tradeId})});
      const result=await response.json();if(!response.ok)throw Error(result.error);notify(result.status);
    }catch(error){notify(error.message);}
  };
  return <>
    <div className="scalper-intro"><div><span className="source">EXPERIMENTAL · PAPER ONLY</span><h2>BTC moves first. Test the contract response.</h2><p>Buy one outcome when Binance moves and Polymarket has barely responded. Sell after repricing, reversal, a stop, or the time limit. This is a testable approximation of the video’s idea; its exact rules are unpublished.</p></div><div className="scalper-running"><b>{account.settings.autoEnabled?'AUTO ENTRIES ON':'AUTO ENTRIES OFF'}</b><span>{open.length} open · {pending.length} pending</span></div></div>
    <div className="paper-summary"><div><span>Scalper paper equity · bid value</span><strong>{cash(equity)}</strong><small>Starts with $1,000 · cash {cash(account.cash)}</small></div><div><span>Realized paper P&amp;L</span><strong className={realized>=0?'positive':'negative'}>{cash(realized)}</strong><small>{closed.length} closed positions</small></div><div><span>Open P&amp;L · after exit costs</span><strong className={unrealized>=0?'positive':'negative'}>{cash(unrealized)}</strong><small>{marksKnown?'Marked at executable bid depth':'Unavailable: stale or insufficient exit depth'}</small></div><div><span>Closed win rate</span><strong>{closed.length?`${number(closed.filter(t=>t.realizedNet>0).length/closed.length*100,1)}%`:'—'}</strong><small>Losses and fees included</small></div></div>
    <section className="panel"><div className="panel-head"><div><h2>Live signal checks</h2><span>Current BTC 5-minute contract · local arrival times · no claimed fair-value estimate</span></div><span className="source">{connection==='live'?'LIVE':'DISPLAY '+connection.toUpperCase()}</span></div><div className="signal-grid">{(account.scan?.markets||[]).map(signal=><div className="signal-card" key={signal.marketId}><b>{signal.title}</b><div className="signal-values"><span>BTC move <strong>{number(signal.moveBps)} bps</strong></span><span>Side <strong>{signal.side?.toUpperCase()||'—'}</strong></span><span>Contract response <strong>{number(signal.responseCents)}¢</strong></span><span>Round-trip cost <strong>{cash(signal.roundTripCost)}</strong></span></div><p className={signal.eligible&&!signal.blocked?'positive':''}>{signal.blocked||signal.reason}</p></div>)}</div><p className="scalper-note">{account.scan?.reason||'Warming up live history…'} · Daily loss used {cash(account.scan?.dailyLoss||0)} / {cash(account.settings.dailyLossLimitUsd)} (UTC).</p></section>
    <div className="paper-layout scalper-controls"><section className="panel"><h2>Entry and exit rules</h2><div className="inputs paper-inputs">{controls.map(([key,label])=>{const [min,max,integer]=SCALPER_BOUNDS[key];return <label key={key}>{label}<input type="number" min={min} max={max} step={integer?1:key.includes('Usd')?0.05:0.1} value={draft[key]} onChange={event=>setDraft({...draft,[key]:event.target.value})}/></label>;})}</div><div className="paper-actions"><button disabled={saving} onClick={()=>save(account.settings.autoEnabled)}>Save scalper rules</button><button disabled={saving} className={account.settings.autoEnabled?'stop':'start'} onClick={()=>save(!account.settings.autoEnabled)}>{account.settings.autoEnabled?'Stop new entries':'Start paper scalper'}</button></div></section>
    <section className="panel"><h2>What the simulator assumes</h2><p>1 basis point is 0.01%. The default signal tests a BTC move of at least 0.02% over two seconds while the chosen contract’s midpoint rises no more than 0.5¢. This heuristic is uncalibrated; a signal is not proof of profitable mispricing.</p><p>Entries wait {draft.latencyMs} ms, then recheck the signal and full ask depth. An entry cancels if its average price rises by more than 0.5¢. Exits wait the same modeled delay and use full bid depth. Fees and an extra buffer are charged each way.</p><p>Stop losses and time limits request an exit; they cannot guarantee its price or fill. Missing depth leaves the position open. If held through expiry, only a verified Gamma resolution credits its actual winning or losing payout.</p><p>Only current BTC 5m markets with at least 30 seconds remaining can open a position. An exit is requested 15 seconds before expiry. There is no fabricated TradingView, CryptoQuant, or MiroFish feed. Chainlink still determines settlement.</p><p>This strategy has its own $1,000 paper account. The earlier paired account and its history remain under Paper trades. Enabling either strategy stops new automatic entries in the other.</p></section></div>
    <section className="panel table-panel"><div className="panel-head"><div><h2>Directional paper trades</h2><span>Ask entries → bid exits · P&amp;L after fees and buffers</span></div><a className="button" href="/api/scalper/trades.csv">Export scalper CSV</a></div><div className="table-wrap"><table><thead><tr><th>Opened</th><th>Market / side</th><th>Shares</th><th>Entry</th><th>Exit</th><th>Net P&amp;L</th><th>Status / reason</th><th>Action</th></tr></thead><tbody>{trades.slice(0,100).map(t=><tr key={t.id}><td>{clock(t.openedAt)}</td><td title={t.title}>{t.slug}<br/><b>{t.side.toUpperCase()}</b></td><td>{t.shares}</td><td>{number(t.entryPrice*100)}¢<br/>{cash(t.entryCost)}</td><td>{t.exitPrice!=null?`${number(t.exitPrice*100)}¢`:t.status==='settled'?t.winner:'—'}</td><td className={(t.status==='open'?t.markNet:t.realizedNet)>=0?'positive':'negative'}>{cash(t.status==='open'?t.markNet:t.realizedNet)}<br/><small>{t.status==='open'?'Unrealized':'Realized'}</small></td><td>{t.status}<br/>{t.exitBlocked||t.exitReason||'Watching bids'}</td><td>{t.status==='open'&&<button disabled={!!t.exitRequestedAt||connection!=='live'} onClick={()=>close(t.id)}>{t.exitRequestedAt?'Exit pending':'Close paper position'}</button>}</td></tr>)}{!trades.length&&<tr><td colSpan="8" className="empty-table">No filled paper entries yet. Live checks above explain what the strategy is waiting for.</td></tr>}</tbody></table></div></section>
    <section className="panel table-panel"><div className="panel-head"><div><h2>Entry attempts</h2><span>Signals that reached the modeled order delay, including cancellations</span></div></div><div className="table-wrap"><table><thead><tr><th>Time</th><th>Market / side</th><th>BTC move</th><th>Outcome response</th><th>Result</th></tr></thead><tbody>{account.orders.slice(0,20).map(order=><tr key={order.id}><td>{clock(order.requestedAt)}</td><td>{order.slug} · {order.side.toUpperCase()}</td><td>{number(order.signal.moveBps)} bps</td><td>{number(order.signal.responseCents)}¢</td><td>{order.status}{order.reason?` · ${order.reason}`:''}</td></tr>)}{!account.orders.length&&<tr><td colSpan="5" className="empty-table">No qualifying entry attempts yet.</td></tr>}</tbody></table></div></section>
  </>;
}
