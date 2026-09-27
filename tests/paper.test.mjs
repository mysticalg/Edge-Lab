import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PAPER_SETTINGS, enterPaperPair, settlePaperPair } from '../paper.mjs';

const market = now => ({ id:'1', slug:'btc-updown-5m-1', title:'BTC test', endDate:new Date(now+60000).toISOString(), feeType:'crypto_fees_v2',
  resolutionSource:'Chainlink', bookFetchedAt:now, bookSourceAt:now,
  books:{up:{asks:[{price:.44,size:10}]},down:{asks:[{price:.45,size:10}]}} });
test('paper pair debits assumed fill cost and credits only after verified resolution', () => {
  const now=Date.now(), account={cash:100,settings:{...DEFAULT_PAPER_SETTINGS},trades:[]};
  const {trade,error}=enterPaperPair(account,market(now),10,25,'manual',now);
  assert.equal(error,undefined);
  assert.equal(trade.status,'open');
  assert.equal(account.cash,100-trade.totalCost);
  assert.equal(enterPaperPair(account,market(now),10,25,'manual',now).error,'This market already has a paper pair.');
  assert.equal(settlePaperPair(account,trade,{markets:[{closed:true,umaResolutionStatus:'proposed',outcomes:'["Up","Down"]',outcomePrices:'["1","0"]'}]},now+60000),false);
  assert.equal(trade.status,'open');
  assert.equal(settlePaperPair(account,trade,{markets:[{closed:true,umaResolutionStatus:'resolved',outcomes:'["Up","Down"]',outcomePrices:'["1","0"]'}]},now+60000),true);
  assert.equal(trade.realizedNet,trade.projectedNet);
  assert.equal(account.cash,100+trade.realizedNet);
});
test('auto entry enforces net threshold and fresh books', () => {
  const now=Date.now(), account={cash:100,settings:{...DEFAULT_PAPER_SETTINGS,minNetUsd:2},trades:[]};
  assert.match(enterPaperPair(account,market(now),10,25,'auto',now).error,/threshold/);
  assert.match(enterPaperPair(account,market(now-20000),10,25,'manual',now).error,/stale/);
});
