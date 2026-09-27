import React, { useState } from 'react';
const gbp = n => Number.isFinite(n) ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n) : '—';
export default function KrakenLivePanel({ account: a, connection, notify }) {
  const [symbol, setSymbol] = useState('BTC/GBP'), [side, setSide] = useState('buy'), [budget, setBudget] = useState(5);
  const [preview, setPreview] = useState(null), [confirmation, setConfirmation] = useState(''), [busy, setBusy] = useState(false);
  const live = a.live, account = a.accountConnection || {};
  if (!live) return null;
  const offline = connection !== 'live', expired = !preview || Date.now() >= preview.expiresAt;
  const act = async (path, body = {}) => {
    setBusy(true);
    try {
      const response = await fetch(path === 'account' ? '/api/kraken/account/check' : `/api/kraken/live/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-edge-live': live.csrf }, body: JSON.stringify(body) });
      const data = await response.json(); if (!response.ok) throw Error(data.error || 'Live request failed');
      if (path === 'preview') { setPreview(data.result); setConfirmation(''); notify('Kraken validated this preview without trading. Review it before submitting.'); }
      else if (path === 'submit') { setPreview(null); setConfirmation(''); notify(`Real order status: ${data.result.status}. ${data.result.error || 'Refresh order status for confirmed fills.'}`); }
      else if (path === 'arm') { if (!body.enabled) setPreview(null); setConfirmation(''); notify(body.enabled ? 'Manual live controls enabled for 10 minutes. Paper automation cannot place real orders.' : 'New live submissions disabled. Check any already submitted order below.'); }
      else notify(path === 'account' ? data.message : 'Order status checked against Kraken.');
    } catch (error) { if (path === 'preview') setPreview(null); notify(error.message); }
    finally { setBusy(false); }
  };
  const edit = setter => event => { setter(event.target.value); setPreview(null); setConfirmation(''); };
  return <section className="panel kraken-live" aria-label="Real Kraken orders">
    <div className="panel-head"><div><h2>Real Kraken orders</h2><span>Manual only · real account funds · spot, no leverage</span></div><span className="source">{live.armed ? 'LIVE CONTROLS ENABLED' : 'LIVE CONTROLS OFF'}</span></div>
    <p>Market stream: {a.feed.status} · {a.online ? 'exchange online' : 'exchange not ready'} · {account.connected ? 'Account authenticated' : 'Account not checked'}</p><button disabled={busy || offline || live.busy} onClick={() => act('account')}>Refresh real account</button>
    <p>These controls can place real buy or sell orders. Auto trading on the Kraken spot tab remains a separate simulation. There are no automatic live exits; manage bought assets here or in Kraken Pro.</p>
    <div className="kraken-balances">{['GBP', 'BTC', 'ETH', 'SOL'].map(asset => <div key={asset}><span>Available {asset}</span><b>{Number.isFinite(account.available?.[asset]) ? asset === 'GBP' ? gbp(account.available[asset]) : account.available[asset].toFixed(8) : 'Check account'}</b></div>)}</div>
    <p>Available amounts exclude order holds and borrowed credit. Account snapshot: {account.checkedAt ? new Date(account.checkedAt).toLocaleString('en-GB') : 'not checked'}. Previews refresh these values.</p>
    {account.connected && account.available?.GBP === 0 && <p className="negative">No GBP is available for these GBP-pair buys. Any other currencies or assets in your account are not included in this panel.</p>}
    {account.permissions?.includes('withdraw-funds') && <p className="kraken-key-note">Your API key includes withdrawal permission. Edge Lab has no withdrawal endpoint and does not need that permission.</p>}
    <p>Initial limits: £25 per order and £25 total buy submissions per UTC day, including canceled attempts. The order uses a limit price with immediate-or-cancel execution; it can fill partially. Unfilled quantity is canceled. No automatic retry after an uncertain response.</p>
    {live.error && <div className="notice" role="alert">{live.error}</div>}
    <div className="paper-actions"><button disabled={offline} className={live.armed ? 'stop' : ''} onClick={() => act('arm', { enabled: !live.armed })}>{live.armed ? 'Disable new live submissions' : 'Enable manual live orders · 10 minutes'}</button></div>
    <div className="inputs paper-inputs"><label>Real order pair<select aria-label="Real order pair" value={symbol} onChange={edit(setSymbol)}>{['BTC/GBP', 'ETH/GBP', 'SOL/GBP'].map(p => <option key={p}>{p}</option>)}</select></label><label>Real order side<select aria-label="Real order side" value={side} onChange={edit(setSide)}><option value="buy">Buy crypto with GBP</option><option value="sell">Sell crypto for GBP</option></select></label><label>{side === 'buy' ? 'Maximum spend including fee · GBP' : 'Sell value at limit price · GBP'}<input aria-label="Real order budget GBP" type="number" min="5" max="25" step="1" value={budget} onChange={edit(setBudget)}/></label></div>
    <button disabled={busy || offline || live.busy} onClick={() => act('preview', { symbol, side, budget: Number(budget) })}>Preview real order · no trade yet</button>
    {preview && <div className="kraken-order-preview"><h3>Review real {preview.side} · {preview.symbol}</h3><dl><dt>Exact crypto quantity</dt><dd>{preview.quantity.toFixed(8)}</dd><dt>{preview.side === 'buy' ? 'Maximum buy price' : 'Minimum sell price'}</dt><dd>{gbp(preview.limitPrice)}</dd><dt>Verified taker fee rate</dt><dd>{preview.feePct.toFixed(2)}%</dd><dt>{preview.side === 'buy' ? 'Maximum debit including fee reserve' : 'Estimated proceeds after fees'}</dt><dd>{gbp(preview.side === 'buy' ? preview.maxDebit : preview.estimatedNetProceeds)}</dd><dt>Preview expiry</dt><dd>{new Date(preview.expiresAt).toLocaleTimeString('en-GB')}{expired ? ' · EXPIRED' : ''}</dd></dl><p>This submits one real immediate-or-cancel limit order. Funds and fees will be rechecked; Kraken may reject it, or fill only part of it.</p><label>Type {preview.side.toUpperCase()} {preview.symbol} to confirm<input aria-label="Real order confirmation" value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off"/></label><button className="kraken-submit" disabled={busy || offline || !live.armed || live.busy || expired || confirmation !== `${preview.side.toUpperCase()} ${preview.symbol}`} onClick={() => act('submit', { previewId: preview.id, confirmation })}>Submit real {preview.side} order</button></div>}
    <div className="panel-head kraken-live-history"><h2>Confirmed order status</h2><button disabled={busy || offline || live.busy} onClick={() => act('reconcile')}>Refresh real order status</button></div>
    <div className="table-wrap"><table><thead><tr><th>Submitted</th><th>Order</th><th>Status</th><th>Filled quantity</th><th>Executed value · GBP</th><th>Kraken order ID</th></tr></thead><tbody>{live.orders.length ? live.orders.map(o => <tr key={o.id}><td>{new Date(o.submittedAt).toLocaleString('en-GB')}</td><td>{o.side} {o.symbol}</td><td>{o.status}<small>{o.error}</small></td><td>{Number.isFinite(o.filledQuantity) ? o.filledQuantity.toFixed(8) : 'Unverified'}</td><td>{gbp(o.executedCost)}</td><td>{o.txid || 'Not yet known'}</td></tr>) : <tr><td colSpan="6" className="empty-table">No real orders have been submitted through Edge Lab.</td></tr>}</tbody></table></div><p>Executed value excludes fees. Fill status comes from Kraken; an accepted order is not proof of a fill. Profit is not calculated because assets already held may have an unknown cost basis.</p>
  </section>;
}
