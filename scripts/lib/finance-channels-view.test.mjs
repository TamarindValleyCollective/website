// Run with: node --test scripts/lib/finance-channels-view.test.mjs
//
// The layout of the Channels view, which needs no browser: where each box and band goes, from the flow. (The drawing itself places this
// layout in the page.) Every figure is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutFlow, moneyText, monthName, statusOf } from './finance-channels-view.mjs';
import { channelCube, flowOf } from './finance-channels.mjs';

const line = (id, tran_date, direction, amount_paise, narration, bank_account_id = 'A1') => ({ id, tran_date, direction, amount_paise, narration, bank_account_id });
const alloc = (bank_line_id, category_id, amount_paise) => ({ bank_line_id, category_id, amount_paise, project_id: null });
const categories = [
  { id: 'c-sal', type: 'opex', head: 'farm', is_salary: true }, { id: 'c-farm', type: 'opex', head: 'farm', is_salary: false },
  { id: 'c-sink', type: 'sinking_fund', head: 'investment', is_salary: false }, { id: 'c-maint', type: 'member_contribution', head: null, is_salary: false },
];
const lines = [
  line('l1', '2026-10-05', 'debit', 9_000_000, 'NEFT/0101102630472/10/'), line('l2', '2026-10-06', 'debit', 2_000_000, 'UPI/P2A/600000000001/Shop/Bank'),
  line('l3', '2026-10-07', 'debit', 300_000, 'POS/SHOP'), line('l4', '2026-10-08', 'debit', 4_000_000, 'INB/NEFT/X/FD/Bank'), line('l5', '2026-10-09', 'credit', 20_000_000, 'INB/NEFT/Y/Household/Bank'),
  line('l6', '2026-10-10', 'credit', 500_000, 'Razorpay Software Pvt Ltd Fund', 'A2'), line('l7', '2026-10-11', 'credit', 1_500_000, 'INB/NEFT/Z/Deposit/Bank'),
];
const allocations = [alloc('l1', 'c-sal', 9_000_000), alloc('l2', 'c-farm', 2_000_000), alloc('l3', 'c-farm', 300_000), alloc('l4', 'c-sink', 4_000_000), alloc('l5', 'c-maint', 20_000_000), alloc('l7', 'c-sink', 1_500_000)];
const cube = channelCube({ lines, upiAppByLine: new Map([['l2', 'paytm']]), allocations, categories });
const accounts = [{ id: 'A1', label: 'Current account' }, { id: 'A2', label: 'Second account' }];
const layouts = [['channel', 'channel'], ['purpose', 'purpose'], ['channel', 'purpose'], ['purpose', 'channel']].map(([groupIn, groupOut]) => layoutFlow(flowOf({ cube, accounts, months: ['2026-10'], groupIn, groupOut })));
const L = layouts[0];

test('money is written in lakh once it is large enough to matter, and in rupees below that', () => {
  assert.equal(moneyText(10_000_000), '₹1.00 L');
  assert.equal(moneyText(2_305_000), '₹0.23 L');
  assert.equal(moneyText(96_700), '₹967');
  assert.equal(moneyText(500_000), '₹5,000');
});

test('a delegate is fine until 80% of their month, warned until the limit, then over', () => {
  assert.equal(statusOf(100, 1000), 'ok');
  assert.equal(statusOf(800, 1000), 'warn');
  assert.equal(statusOf(1000, 1000), 'warn');
  assert.equal(statusOf(1001, 1000), 'crit');
  assert.equal(statusOf(5000, null), 'ok');
});

test('the months are named', () => {
  assert.equal(monthName('2026-04'), 'April');
  assert.equal(monthName('2027-03'), 'March');
});

test('one scale for everything: the same money is the same height, and a band is as wide as its money', () => {
  for (const l of layouts) {
    for (const n of l.nodes) assert.ok(Math.abs(n.h - Math.max(4, n.paise * l.scale)) < 1e-6, `${n.id} height`);
    for (const x of l.links) assert.ok(Math.abs(x.w - Math.max(1.5, x.paise * l.scale)) < 1e-6, `${x.from} -> ${x.to} width`);
  }
});

test('boxes in a column never overlap and all sit inside the picture', () => {
  for (const l of layouts) {
    for (const col of [0, 1, 2]) {
      const box = l.nodes.filter((n) => n.col === col).sort((a, b) => a.y - b.y);
      for (let i = 1; i < box.length; i++) assert.ok(box[i].y >= box[i - 1].y + box[i - 1].h, `${box[i - 1].id} and ${box[i].id} overlap`);
      for (const n of box) assert.ok(n.y >= 0 && n.y + n.h <= l.height, `${n.id} is outside the picture`);
    }
  }
});

test('the bands on a box fit inside it, none on top of another', () => {
  for (const l of layouts) {
    for (const n of l.nodes) {
      const used = (side) => l.links.filter((x) => (side === 'out' ? x.from : x.to) === n.id).sort((a, b) => (side === 'out' ? a.sy : a.ty) - (side === 'out' ? b.sy : b.ty));
      for (const side of ['out', 'in']) {
        const ls = used(side);
        let at = n.y;
        for (const x of ls) { const y = side === 'out' ? x.sy : x.ty; assert.ok(y >= at - 1e-6, `${n.id} ${side} bands overlap`); at = y + x.w; }
        assert.ok(at <= n.y + n.h + 1.5 * ls.length, `${n.id} ${side} bands run past the box`);
      }
    }
  }
});

test('the fixed deposits are last in their column, whichever grouping is chosen', () => {
  for (const l of layouts) for (const col of [0, 2]) {
    const box = l.nodes.filter((n) => n.col === col).sort((a, b) => a.y - b.y);
    assert.equal(box.at(-1).kind, 'fd', `column ${col}`);
  }
});

test('every band is a curve from the right edge of its source to the left edge of its target', () => {
  const byId = new Map(L.nodes.map((n) => [n.id, n]));
  for (const x of L.links) {
    const a = byId.get(x.from), b = byId.get(x.to);
    assert.ok(x.d.startsWith(`M${a.x + a.w},`), x.d);
    assert.ok(x.d.endsWith(`${b.x},${x.ty + x.w / 2}`), x.d);
  }
});

test('what an account kept is a strip beside it, on the side that has the room', () => {
  const kept = L.kept;
  const a1 = kept.find((k) => k.account === 'A:A1');
  assert.equal(a1.side, 'right', 'more came in than went out on the current account');
  assert.equal(a1.paise, 21_500_000 - 15_300_000);
  const a2 = kept.find((k) => k.account === 'A:A2');
  assert.equal(a2.side, 'right');
  assert.ok(a1.h > 0 && a2.h > 0);
});

test('an empty period has nothing to lay out and does not fail', () => {
  const empty = layoutFlow(flowOf({ cube, accounts, months: ['2026-01'], groupIn: 'channel', groupOut: 'channel' }));
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.links.length, 0);
});
