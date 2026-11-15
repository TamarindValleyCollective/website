// Run with: node --test scripts/lib/finance-channels-view.test.mjs
//
// The layout of the Channels view, which needs no browser: where each box and band goes, from the flow. (The drawing itself places this
// layout in the page.) Every figure is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SLIDE, layoutDrill, layoutFlow, moneyText, monthName, statusOf } from './finance-channels-view.mjs';
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

test('the fixed deposits are an account: last in the accounts column, whichever grouping is chosen, and the outer columns have none', () => {
  for (const l of layouts) {
    const accounts = l.nodes.filter((n) => n.col === 1).sort((a, b) => a.y - b.y);
    assert.equal(accounts.at(-1).kind, 'fd');
    assert.ok(l.nodes.filter((n) => n.col !== 1).every((n) => n.kind !== 'fd'));
  }
});

test('every band is a curve from the right edge of its source to the left edge of its target; a transfer is a loop beside the two accounts', () => {
  const byId = new Map(L.nodes.map((n) => [n.id, n]));
  for (const x of L.links) {
    const a = byId.get(x.from), b = byId.get(x.to);
    if (x.transfer) {
      const into = b.kind === 'fd', edge = into ? a.x + a.w : a.x;
      assert.ok(x.d.startsWith(`M${edge},${x.sy + x.w / 2}`), x.d);
      assert.ok(x.d.endsWith(`${edge},${x.ty + x.w / 2}`), x.d);
      assert.ok(into ? x.d.includes(`C${edge + 70},`) : x.d.includes(`C${edge - 70},`), 'bulges to the right going in, to the left coming back');
      continue;
    }
    assert.ok(x.d.startsWith(`M${a.x + a.w},`), x.d);
    assert.ok(x.d.endsWith(`${b.x},${x.ty + x.w / 2}`), x.d);
  }
});

test('the deposits open to the right, straight to their lines, like a box on the money-out side', () => {
  const fd = L.nodes.find((n) => n.kind === 'fd');
  const d = layoutDrill(L, { nodeId: fd.id, columns: [], lineCount: 2 });
  assert.equal(d.side, 'out');
  assert.equal(d.dx, -SLIDE);
  assert.equal(d.card.x, fd.x + SLIDE);
  assert.equal(L.kept.some((k) => k.account === fd.id), false, 'a strip of what stayed is for the bank accounts only');
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

// ---- the columns beyond the picture: a box's breakdowns, level by level, and then its lines -----------------------------------------------

const outBox = L.nodes.find((n) => n.col === 2 && n.kind === 'out' && n.paise > 1_000_000);
const inBox = L.nodes.find((n) => n.col === 0 && n.kind === 'in');
const split = (box, shares) => shares.map(([id, name, s], i) => ({ id, name, paise: Math.round(box.paise * s), n: i + 1 }));
const outRows = split(outBox, [['p1', 'Asha', 0.58], ['p2', 'Ravi', 0.42]]);
const inRows = split(inBox, [['u1', 'Unit 12', 0.5], ['u2', 'Unit 7', 0.3], ['u3', 'Unit 3', 0.2]]);
const col = (rows, pickId = null) => ({ rows, pickId });

test('opening a money-out box slides the picture left one column and puts its breakdown to the right of it', () => {
  const d = layoutDrill(L, { nodeId: outBox.id, columns: [col(outRows)] });
  assert.equal(d.side, 'out');
  assert.equal(d.level, 1);
  assert.equal(d.dx, -SLIDE);
  assert.ok(d.columns[0].rows.every((r) => r.x === outBox.x + SLIDE), 'one column to the right');
  assert.equal(d.card, null, 'no lines until a row is chosen');
  // the same scale as the picture: a band is as wide as its money, and the bands fit the box they leave
  for (const r of d.columns[0].rows) assert.ok(Math.abs(r.band.w - Math.max(1.5, r.paise * L.scale)) < 1e-6);
  assert.ok(d.columns[0].rows.reduce((t, r) => t + r.band.w, 0) <= outBox.h + 1.5 * outRows.length);
});

test('opening a money-in box slides the picture right and puts its breakdown to the left', () => {
  const d = layoutDrill(L, { nodeId: inBox.id, columns: [col(inRows)] });
  assert.equal(d.side, 'in');
  assert.equal(d.dx, SLIDE);
  assert.ok(d.columns[0].rows.every((r) => r.x === inBox.x - SLIDE));
  assert.ok(d.columns[0].rows[0].band.d.startsWith(`M${inBox.x - SLIDE + 14},`), 'bands run from the row into the box');
});

test('choosing a row slides one column further and shows its lines, a column on from the breakdown', () => {
  const out = layoutDrill(L, { nodeId: outBox.id, columns: [col(outRows, 'p2')], lineCount: 6 });
  assert.equal(out.level, 2);
  assert.equal(out.dx, -2 * SLIDE);
  assert.equal(out.card.x, outBox.x + 2 * SLIDE);
  assert.equal(out.card.h, 62 + 6 * 40);
  assert.ok(out.bottom >= out.card.y + out.card.h);
  const inn = layoutDrill(L, { nodeId: inBox.id, columns: [col(inRows, 'u1')], lineCount: 4 });
  assert.equal(inn.dx, 2 * SLIDE);
  assert.ok(inn.card.x + inn.card.w <= inBox.x - 2 * SLIDE + 14 + 1e-6, 'the card ends at the column, to the left');
});

test('a tree opens one column per level: operator, then person, then the lines, the picture sliding a column each time', () => {
  const operators = split(outBox, [['OA', 'Test operator A', 0.7], ['OB', 'Test operator B', 0.3]]);
  const pickedA = operators[0];
  const people = [{ id: 'own', name: 'Direct', paise: Math.round(pickedA.paise * 0.6), n: 3 }, { id: 'D1', name: 'UPI circle · Number 5550100001', paise: Math.round(pickedA.paise * 0.4), n: 2 }];
  const one = layoutDrill(L, { nodeId: outBox.id, columns: [col(operators)] });
  assert.deepEqual([one.level, one.dx, one.columns.length], [1, -SLIDE, 1]);
  const two = layoutDrill(L, { nodeId: outBox.id, columns: [col(operators, 'OA'), col(people)] });
  assert.deepEqual([two.level, two.dx, two.columns.length, two.card], [2, -2 * SLIDE, 2, null]);
  assert.equal(two.columns[1].x, outBox.x + 2 * SLIDE);
  const chosenA = two.columns[0].rows.find((r) => r.id === 'OA');
  assert.ok(two.columns[1].rows[0].band.d.startsWith(`M${chosenA.x + 14},`), 'the second level opens from the row chosen in the first');
  assert.ok(two.columns[1].rows.reduce((t, r) => t + r.band.w, 0) <= chosenA.h + 1.5 * people.length, 'and fits inside it');
  const three = layoutDrill(L, { nodeId: outBox.id, columns: [col(operators, 'OA'), col(people, 'D1')], lineCount: 3 });
  assert.deepEqual([three.level, three.dx], [3, -3 * SLIDE]);
  assert.equal(three.card.x, outBox.x + 3 * SLIDE);
  // the money-in side mirrors it
  const inTwo = layoutDrill(L, { nodeId: inBox.id, columns: [col(inRows, 'u1'), col(split(inRows[0], [['x', 'X', 1]]))] });
  assert.equal(inTwo.dx, 2 * SLIDE);
  assert.ok(inTwo.columns[1].x < inTwo.columns[0].x);
});

test('what has no breakdown (the deposits, an account) goes straight to its lines, in the breakdown column', () => {
  const direct = layoutDrill(L, { nodeId: outBox.id, columns: [], lineCount: 3 });
  assert.equal(direct.level, 1);
  assert.equal(direct.dx, -SLIDE);
  assert.equal(direct.columns.length, 0);
  assert.equal(direct.card.x, outBox.x + SLIDE);
  const fromIn = layoutDrill(L, { nodeId: inBox.id, columns: [], lineCount: 3 });
  assert.equal(fromIn.dx, SLIDE);
  assert.equal(fromIn.card.x + fromIn.card.w, inBox.x - SLIDE + 14, 'the card ends at the column, on the left');
});

test('while a breakdown loads there is nothing to place yet, and the picture has already slid', () => {
  const d = layoutDrill(L, { nodeId: outBox.id, columns: [col(null)] });
  assert.deepEqual([d.columns[0].rows.length, d.card, d.level, d.dx], [0, null, 1, -SLIDE]);
});

test('the breakdown rows never overlap, stay on the page, and many of them make the picture taller', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ id: `r${i}`, name: `Row ${i}`, paise: Math.round(outBox.paise / 14), n: 1 }));
  const d = layoutDrill(L, { nodeId: outBox.id, columns: [col(many)] });
  const rs = d.columns[0].rows.slice().sort((a, b) => a.y - b.y);
  for (let i = 1; i < rs.length; i++) assert.ok(rs[i].y >= rs[i - 1].y + rs[i - 1].h, 'overlap');
  assert.ok(rs[0].y >= 0);
  assert.ok(d.bottom > 14 * 34, 'room for 14 rows');
});
