import test from 'node:test';
import assert from 'node:assert/strict';
import { quotePair } from '../edge.mjs';
test('walks both ask books and charges both taker fees', () => {
  const q = quotePair([{price:.46,size:5},{price:.47,size:5}], [{price:.48,size:10}], 10, 0);
  assert.equal(q.available, true);
  assert.equal(q.up.cost, 4.65);
  assert.equal(q.down.cost, 4.8);
  assert.ok(q.fees > 0);
  assert.ok(q.net < q.gross);
});
test('does not invent fills when a leg lacks depth', () => {
  const q = quotePair([{price:.4,size:3}], [{price:.5,size:10}], 10);
  assert.equal(q.available, false);
});
