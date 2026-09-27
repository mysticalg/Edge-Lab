import React from 'react';
import './observation-status.css';
import { freshBook } from '../order-book.mjs';
const time = at => at ? new Date(at).toLocaleTimeString('en-GB', { hour12: false }) : 'None yet';
const money = n => Number.isFinite(n) ? `${n < 0 ? '-$' : '$'}${Math.abs(n).toFixed(3)}` : 'Unavailable';
export default function ObservationStatus({ state, connection }) {
  const now = Date.now(), feed = state?.feeds?.polymarket;
  const active = (state?.markets || []).filter(m => Date.parse(m.endDate) > now);
  const priced = active.filter(m => freshBook(m, now) && m.quote?.available);
  const positive = priced.filter(m => m.quote.net > 0);
  const best = priced.length ? Math.max(...priced.map(m => m.quote.net)) : null;
  const lastGap = (state?.observations || []).find(o => o.type === 'Observed gap');
  const latestBook = Math.max(0, ...active.map(m => m.bookFetchedAt || 0));
  const connected = connection === 'live' && feed?.status === 'connected' && now - (feed.lastMessageAt || 0) < 12000;
  const label = connection === 'paused' ? 'Display paused' : !connected ? 'Waiting for stream' : !priced.length ? 'Waiting for fresh depth' : positive.length ? 'Positive quote detected' : 'Active · no positive gap';
  return <section className="panel observation-status" aria-label="Polymarket observation scanner">
    <div className="panel-head"><div><h2>Polymarket observation scanner</h2><span>Live checks continue between saved observations</span></div><span className={`source ${connected && priced.length ? 'positive' : 'negative'}`}>{label}</span></div>
    <div className="observation-metrics"><div><span>Book scans this run</span><b>{(state?.engine?.scans || 0).toLocaleString()}</b><small>{Math.round(state?.engine?.scansPerSecond || 0)} / second · last book {time(latestBook)}</small></div><div><span>Fresh priced markets</span><b>{priced.length} / {active.length}</b><small>{positive.length} positive right now</small></div><div><span>Best current net · 10 paired shares</span><b className={best > 0 ? 'positive' : 'negative'}>{money(best)}</b><small>After fees and 25 bps buffer</small></div><div><span>Last saved positive gap</span><b>{time(lastGap?.at)}</b><small>{lastGap ? new Date(lastGap.at).toLocaleDateString('en-GB') : 'No positive gap recorded yet'}</small></div></div>
    <p>{connection === 'paused' ? 'The screen is paused; the server continues scanning. Resume the display for current counts.' : !connected ? 'Stream or screen connection is delayed. Displayed prices may be stale.' : !priced.length ? 'Waiting for complete, fresh ask depth before evaluating gaps.' : positive.length ? 'A positive quote is present. The logger saves at most one per market in each 15-second interval.' : 'Scanning normally. Current quotes do not exceed zero net, so no new automatic observation is saved.'} This log covers Polymarket paired quotes. Kraken activity appears in the Kraken tabs; automatic entries and logging have separate rules.</p>
  </section>;
}
