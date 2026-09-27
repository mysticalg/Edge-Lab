import React, { useState } from 'react';
import { MAKER_BOUNDS } from '../kraken-maker.mjs';
import './maker.css';

const gbp = n => Number.isFinite(n) ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n) : 'Unavailable';
const num = n => Number.isFinite(n) ? n.toLocaleString('en-GB', { maximumFractionDigits: 8 }) : '—';
const time = at => at ? new Date(at).toLocaleTimeString('en-GB') : '—';
const fields = [['spend', 'Route budget · GBP'], ['minNet', 'Minimum conditional net · GBP'],
  ['bufferBps', 'Taker price buffer · bps'], ['latencyMs', 'Order / cancellation delay · ms'],
  ['orderSeconds', 'Limit order lifetime · seconds'], ['hedgeSeconds', 'Hedge timeout · seconds'], ['lossLimit', 'Unwind loss trigger · GBP']];

export default function KrakenMakerPanel({ account, connection, notify }) {
  const [draft, setDraft] = useState(null), [busy, setBusy] = useState(false);
  const a = account?.maker;
  if (!a) return <div className="panel">Connecting to the Kraken maker paper experiment…</div>;
  const rules = draft || a.settings, open = a.cycles.find(c => c.status === 'open');
  const waiting = a.orders.find(o => ['pending', 'resting', 'cancelling'].includes(o.status));
  const disabled = busy || connection !== 'live' || Boolean(a.persistenceError);
  const action = async (path, body) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/kraken/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw Error(result.error || 'Request failed');
      if (path === 'maker/settings') setDraft(null);
      notify(result.message);
    } catch (error) { notify(error.message); } finally { setBusy(false); }
  };
  return <div className="kraken maker">
    <div className="kraken-banner"><div><b>One patient entry. Two conversions back to GBP.</b><p>Kraken live data · separate £1,000 paper account · conditional arbitrage experiment</p></div><span className="source">PAPER ONLY</span></div>
    <div className="paper-summary">
      <div><span>Paper equity · after exit costs</span><strong>{gbp(a.equity)}</strong><small>Cash {gbp(a.cash)} · reserved {gbp(a.reserved)}</small></div>
      <div><span>Realized paper P&amp;L</span><strong className={a.realizedNet >= 0 ? 'positive' : 'negative'}>{gbp(a.realizedNet)}</strong><small>Includes failed-route exits and fees</small></div>
      <div><span>Open inventory P&amp;L</span><strong className={a.openNet >= 0 ? 'positive' : 'negative'}>{gbp(a.openNet)}</strong><small>{open ? `${num(open.quantity)} ${open.asset} remains at risk` : 'No crypto inventory in an open route'}</small></div>
      <div><span>Maximum observed drawdown</span><strong>{gbp(a.maxDrawdown)}</strong><small>After-cost marks · gaps can hide deeper losses</small></div>
    </div>
    <section className="panel maker-state" aria-label="Maker paper status">
      <div className="panel-head"><div><h2>{a.settings.autoEnabled ? 'Paper maker running' : 'Paper maker stopped'}</h2><span>{account.feed?.status} · {a.tradeSubscriptions.length}/3 trade subscriptions · {num(a.tradeCount)} fresh trade prints</span></div><span className="source">{connection === 'live' ? 'LIVE DISPLAY' : 'DISPLAY ' + connection.toUpperCase()}</span></div>
      <p role="status">{a.lastAction}</p>
      {a.block && <p>{a.block}</p>}
      {waiting && <div className="maker-inventory"><b>{waiting.symbol} · {waiting.status}</b><span>Limit {num(waiting.price)} GBP</span><span>Filled {num(waiting.filled)} / {num(waiting.quantity)}</span><span>Queue ahead {num(waiting.queueAhead)} shares</span><span>Reserved cash {gbp(a.reserved)}</span></div>}
      {open && <div className="maker-inventory"><b>{open.route} · {open.phase}</b><span>Spent {gbp(open.spent)}</span><span>Unmatched holding {num(open.quantity)} {open.asset}</span><span>Held {Math.max(0, Math.floor((Date.now() - open.openedAt) / 1000))}s</span><span>{open.blocked || open.reason || 'Waiting for next delayed conversion'}</span></div>}
      {a.persistenceError && <p role="alert" className="negative">{a.persistenceError}</p>}
      {account.metadataError && <p role="alert">{account.metadataError}</p>}
    </section>
    <section className="panel table-panel"><div className="panel-head"><div><h2>Route comparison</h2><span>Maker entry at the bid, followed by two taker conversions. These are conditional quotes, not fills.</span></div></div>
      <div className="table-wrap"><table><thead><tr><th>Route</th><th>All-taker net</th><th>Maker-first net</th><th>First maker fee</th><th>Checks</th></tr></thead><tbody>{a.candidates.map(r => {
        const taker = a.takerComparison?.find(t => t.route === r.route);
        return <tr key={r.route}><td>{r.route}</td><td>{gbp(taker?.net)}<small>{taker ? `Budget ${gbp(taker.budget)}` : 'No quote'}</small></td><td className={r.net >= rules.minNet ? 'positive' : ''}>{gbp(r.net)}<small>Budget {gbp(r.budget)}</small></td><td>{r.legs[0] ? `${num(r.legs[0].feePct)}%` : 'Unknown'}</td><td>{r.status}</td></tr>;
      })}</tbody></table></div>
    </section>
    <div className="paper-layout kraken-controls"><section className="panel"><h2>Paper experiment controls</h2>
      <div className="inputs paper-inputs">{fields.map(([key, label]) => <label key={key}>{label}<input aria-label={label} type="number" min={MAKER_BOUNDS[key][0]} max={MAKER_BOUNDS[key][1]} step={['minNet', 'lossLimit'].includes(key) ? 0.01 : 1} value={rules[key]} onChange={e => setDraft({ ...rules, [key]: e.target.value })}/></label>)}</div>
      <div className="paper-actions"><button disabled={disabled} onClick={() => action('maker/settings', { ...rules, ...Object.fromEntries(fields.map(([k]) => [k, Number(rules[k])])), autoEnabled: a.settings.autoEnabled })}>Save maker rules</button><button disabled={disabled} className={a.settings.autoEnabled ? 'stop' : 'start'} onClick={() => action('maker/settings', { ...a.settings, autoEnabled: !a.settings.autoEnabled })}>{a.settings.autoEnabled ? 'Stop maker entries' : 'Start maker paper'}</button><button disabled={disabled || (!open && !waiting)} onClick={() => action('maker/unwind', {})}>Stop and unwind paper inventory</button></div>
      <p>One route at a time · 60s entry cooldown · £10 daily realized loss threshold (UTC). Stop cancels waiting orders after the modeled delay. Open inventory continues through conversions or an attempted unwind. Restart stops new entries.</p>
      <button disabled={disabled} onClick={() => action('account/check', {})}>Refresh Kraken maker / taker fees</button>
      <p>{account.accountConnection?.error || 'Both maker and taker fees must have been verified within the last hour. Missing fees block entry.'}</p>
    </section><section className="panel"><h2>How to read these results</h2>
      <p>A limit order joins behind twice the displayed best-bid quantity after the order delay. A further one-second clock guard excludes early trades. Only fresh sell trades at that exact price can consume this assumed queue. Price touches and book cancellations do not count as fills.</p>
      <p>The first partial fill requests cancellation of the remainder; further fills can occur during the cancellation delay. Each follow-on conversion waits again, then needs fresh quotes, account fees, order minimums and enough displayed depth.</p>
      <p>If a hedge times out or hits the loss trigger, the simulator tries a direct sale to GBP. Missing liquidity, stale fees or a holding below the order minimum leaves inventory open and blocks new entries. A loss trigger cannot cap the loss.</p>
      <p>Maker fees are charged using your Kraken rate. Rebates are assumed to be £0. Residual crypto dust is retained below but valued at zero, so it cannot inflate profit. Missing exit marks show “Unavailable”.</p>
      <p>This top-of-book model cannot establish real queue priority or account for every fill, cancellation race or hidden order. It is a conservative research approximation, not PBot-6’s algorithm or proof of an executable return.</p>
      <div className="source-links"><a href="https://docs.kraken.com/api-reference/account-data/get-trade-volume" target="_blank" rel="noreferrer">Kraken account fees ↗</a><a href="https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/trade" target="_blank" rel="noreferrer">Kraken trade stream ↗</a></div>
    </section></div>
    <section className="panel table-panel"><div className="panel-head"><div><h2>Maker route ledger</h2><span>{a.cycleCount} routes with fills · showing latest 100 · rebates £0</span></div><a className="button" href="/api/kraken/maker/trades.csv">Export maker ledger</a></div><div className="table-wrap"><table><thead><tr><th>Started</th><th>Route</th><th>Spent / returned</th><th>Inventory</th><th>Realized net</th><th>Status</th></tr></thead><tbody>{a.cycles.length ? a.cycles.map(c => <tr key={c.id}><td>{time(c.openedAt)}</td><td>{c.route}<small>{c.legs.map(l => `${l.symbol} ${l.liquidity}: fee ${num(l.fee)} ${l.feeCurrency}`).join(' · ')}</small></td><td>{gbp(c.spent)} / {gbp(c.returnedGbp)}</td><td>{c.status === 'open' ? `${num(c.quantity)} ${c.asset}` : 'Returned to GBP'}<small>{Object.entries(c.dust).map(([asset, qty]) => `${num(qty)} ${asset} dust`).join(' · ')}</small></td><td className={c.realizedNet >= 0 ? 'positive' : ''}>{c.status === 'closed' ? gbp(c.realizedNet) : 'Unrealized'}</td><td>{c.status} · {c.phase}<small>{c.blocked || c.reason}</small></td></tr>) : <tr><td colSpan="6" className="empty-table">No hypothetical maker fills yet. Unfilled and cancelled attempts appear below.</td></tr>}</tbody></table></div></section>
    <section className="panel table-panel"><div className="panel-head"><div><h2>Limit order attempts</h2><span>{a.orderCount} attempts · showing latest 50</span></div><a className="button" href="/api/kraken/maker/orders.csv">Export attempts</a></div><div className="table-wrap"><table><thead><tr><th>Requested</th><th>Pair</th><th>Limit</th><th>Filled / requested</th><th>Queue ahead</th><th>Status</th></tr></thead><tbody>{a.orders.length ? a.orders.map(o => <tr key={o.id}><td>{time(o.requestedAt)}</td><td>{o.symbol}</td><td>{num(o.price)} GBP</td><td>{num(o.filled)} / {num(o.quantity)}</td><td>{num(o.queueAhead)}</td><td>{o.status}<small>{o.reason}</small></td></tr>) : <tr><td colSpan="6" className="empty-table">Start the paper experiment to watch eligible routes. A positive estimate never creates an automatic fill.</td></tr>}</tbody></table></div></section>
    <section className="panel"><h2>Retained crypto dust · valued at £0</h2><p>{Object.entries(a.dust).length ? Object.entries(a.dust).map(([asset, qty]) => `${num(qty)} ${asset}`).join(' · ') : 'No residual crypto.'}</p></section>
  </div>;
}
