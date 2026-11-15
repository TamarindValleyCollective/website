// Run with: node --test scripts/lib/finance-channels-view.test.mjs
//
// The drawing rules of the Channels view that need no browser: how big each circle is, what is written on it and how thick each
// link is. (The graph itself is drawn with Cytoscape.js and laid out by ELK in the browser.) Every figure is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { elementsOf, moneyText } from './finance-channels-view.mjs';

const graph = {
  dir: 'out', total: 10_000_000, // ₹1,00,000
  nodes: [
    { id: 'acct:A1', kind: 'account', label: 'Current account', paise: 10_000_000, n: 9 },
    { id: 'ch:bulk', kind: 'channel', label: 'Paypro', paise: 6_000_000, n: 5, attention: [] },
    { id: 'ch:card', kind: 'channel', label: 'Debit card', paise: 40_000, n: 1, attention: [{ tone: 'warn', text: '1 line has no category' }] },
    { id: 'del:d1', kind: 'delegate', label: 'Test Person', paise: 90_000, n: 3, monthPaise: 450_000, capPaise: 500_000 },
    { id: 'del:d2', kind: 'delegate', label: '5550100001', paise: 30_000, n: 1, monthPaise: 10_000, capPaise: 500_000 },
    { id: 'del:d3', kind: 'delegate', label: 'Third Person', paise: 20_000, n: 1, monthPaise: 600_000, capPaise: 500_000 },
    { id: 'fd', kind: 'fd', label: 'Fixed deposits', paise: 4_000_000, n: 0 },
  ],
  edges: [{ from: 'acct:A1', to: 'ch:bulk', paise: 6_000_000 }, { from: 'acct:A1', to: 'ch:card', paise: 40_000 }, { from: 'ch:bulk', to: 'fd', paise: 3_000_000 }],
};
const el = elementsOf(graph);
const nodeOf = (id) => el.nodes.find((n) => n.data.id === id).data;

test('money is written in lakh once it is large enough to matter, and in rupees below that', () => {
  assert.equal(moneyText(10_000_000), '₹1.00 L');
  assert.equal(moneyText(2_305_000), '₹0.23 L');
  assert.equal(moneyText(96_700), '₹967');
  assert.equal(moneyText(9_670_000), '₹0.97 L');
  assert.equal(moneyText(500_000), '₹5,000');
});

test('circle area is the amount: the biggest account is the biggest circle, channels are on the same scale, small ones have a floor', () => {
  assert.equal(nodeOf('acct:A1').w, 104);
  assert.ok(Math.abs(nodeOf('ch:bulk').w - 104 * Math.sqrt(0.6)) < 0.5);
  assert.equal(nodeOf('ch:card').w, 32, 'a tiny amount is still big enough to click');
  assert.ok(nodeOf('fd').w < nodeOf('acct:A1').w);
});

test('delegates have a scale of their own, so they are not lost beside the accounts', () => {
  assert.equal(nodeOf('del:d1').w, 76);
  assert.ok(nodeOf('del:d2').w < 76 && nodeOf('del:d2').w >= 32);
});

test('the figure is written inside the circle where it fits, and under the name where it does not', () => {
  assert.equal(nodeOf('acct:A1').inside, true);
  assert.equal(nodeOf('acct:A1').label, 'Current account');
  assert.equal(nodeOf('ch:card').inside, false);
  assert.equal(nodeOf('ch:card').label, 'Debit card\n₹400');
});

test('a circle that needs attention says so, and a delegate near or over their monthly limit is coloured by it', () => {
  assert.equal(nodeOf('ch:card').attention, true);
  assert.equal(nodeOf('ch:bulk').attention, false);
  assert.equal(nodeOf('del:d1').status, 'warn', '90% of the limit is close');
  assert.equal(nodeOf('del:d2').status, 'ok');
  assert.equal(nodeOf('del:d3').status, 'crit', 'over it');
});

test('links are as thick as the money through them, between a floor and a ceiling', () => {
  const w = (from, to) => el.edges.find((e) => e.data.source === from && e.data.target === to).data.w;
  assert.ok(Math.abs(w('acct:A1', 'ch:bulk') - 10.8) < 0.05);
  assert.equal(w('acct:A1', 'ch:card'), 2, 'never thinner than 2');
  assert.ok(w('ch:bulk', 'fd') < w('acct:A1', 'ch:bulk'));
  assert.ok(el.edges.every((e) => e.data.w <= 18));
});

test('an empty slice has nothing to draw', () => {
  assert.deepEqual(elementsOf({ dir: 'out', total: 0, nodes: [], edges: [] }), { nodes: [], edges: [] });
});
