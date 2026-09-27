import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTriangles } from '../kraken-triangles.mjs';
function fixture() {
 const quotes = Object.fromEntries(Object.entries({'BTC/GBP':100,'ETH/GBP':10,'ETH/BTC':.1,'SOL/GBP':5,'SOL/BTC':.05}).map(([s,p])=>[s,{bid:p,ask:p,bidQty:1e6,askQty:1e6}]));
 return {account:{settings:{spend:25}},quotes,metadata:Object.fromEntries(Object.keys(quotes).map(s=>[s,{lotDecimals:8,orderMin:1e-8,costMin:1e-8}])),quoteGuard:()=>null,rulesFor:()=>({feePct:.8,bufferBps:0,feeSource:'Verified account taker fee'})};
}
test('Both triangle directions apply three fees and leave balances untouched',()=>{
 const e=fixture(), before=JSON.stringify(e.account), rows=scanTriangles(e);
 assert.equal(rows.length,4);
 for(const r of rows){assert.equal(r.legs.length,3);assert.ok(r.net < -.58 && r.net > -.61);assert.ok(r.returnedGbp < 25);}
 assert.equal(JSON.stringify(e.account),before);
});
test('Missing fees, stale books and thin legs never produce executable profit',()=>{
 const e=fixture();e.quotes['ETH/BTC'].askQty=0;e.quotes['ETH/BTC'].bidQty=0;
 assert.ok(scanTriangles(e).filter(r=>r.route.includes('ETH')).every(r=>r.net===null));
 e.rulesFor=()=>({feePct:.8,bufferBps:0,feeSource:'Configured fee assumption'});
 assert.ok(scanTriangles(e).every(r=>r.net===null));
 e.quoteGuard=()=> 'stale'; assert.ok(scanTriangles(e).every(r=>r.status.includes('stale')));
});
