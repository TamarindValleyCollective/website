// Run with: node --test scripts/lib/finance-channels.test.mjs
//
// The Channels view: the cashflow (money in, the accounts, money out), each side grouped by channel (what the ledger already calls an
// origin) or by purpose, with the fixed deposits kept apart from Received and Spent. Every name, number and amount here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FD, GROUPINGS, IN_PURPOSES, UPI_APPS, channelGroupOf, drillDims, OUT_PURPOSES, breakdownOf, cellMatches, channelCube, channelPieces, flowOf, fyMonths, groupPieces, monthBars, monthsSoFar, presetMonths, previousMonths, projectsOf, purposesOf, rangeOf, specOf, totalsOf,
} from './finance-channels.mjs';

const categories = [
  { id: 'c-sal', name: 'Salary', type: 'opex', head: 'farm', is_salary: true },
  { id: 'c-farm', name: 'Farm operations', type: 'opex', head: 'farm', is_salary: false },
  { id: 'c-co', name: 'Filings', type: 'opex', head: 'company', is_salary: false },
  { id: 'c-sink', name: 'Sinking fund', type: 'sinking_fund', head: 'investment', is_salary: false },
  { id: 'c-maint', name: 'Maintenance', type: 'member_contribution', head: null, is_salary: false },
  { id: 'c-rev', name: 'Stays', type: 'revenue', head: null, is_salary: false },
];
const line = (id, tran_date, direction, amount_paise, narration, bank_account_id = 'A1') => ({ id, tran_date, direction, amount_paise, narration, bank_account_id });
const alloc = (bank_line_id, category_id, amount_paise, project_id = null) => ({ bank_line_id, category_id, amount_paise, project_id });

const lines = [
  line('l1', '2026-10-05', 'debit', 100000, 'UPI/P2A/600000000001/Shop/Bank'),      // paytm (joined), 70% salary, 30% farm
  line('l2', '2026-10-09', 'debit', 50000, 'NEFT/0101102630472/10/'),               // paypro, all farm, for project P1
  line('l3', '2026-11-02', 'debit', 40000, 'INB/NEFT/AXODH28201632867/Someone/Bank'), // bank direct, nothing allocated yet
  line('l4', '2026-11-03', 'debit', 400000, 'INB/NEFT/AXODH28201632868/FD/Bank'),    // bank direct, into the sinking fund
  line('l5', '2026-10-20', 'credit', 300000, 'INB/NEFT/AXODH28201632869/Household/Bank'), // maintenance
  line('l6', '2026-11-08', 'credit', 20000, 'Razorpay Software Pvt Ltd Fund'),         // gateway, stays
  line('l7', '2026-11-09', 'debit', 10000, 'POS/SHOP', 'A2'),                          // card, on the other account
  line('l8', '2026-11-12', 'credit', 150000, 'INB/NEFT/AXODH28201632870/Deposit/Bank'), // back from the deposits
];
const allocations = [
  alloc('l1', 'c-sal', 70000), alloc('l1', 'c-farm', 30000), alloc('l2', 'c-farm', 50000, 'P1'),
  alloc('l4', 'c-sink', 400000), alloc('l5', 'c-maint', 300000), alloc('l6', 'c-rev', 20000), alloc('l7', 'c-farm', 10000), alloc('l8', 'c-sink', 150000),
];
const source = { lines, upiAppByLine: new Map([['l1', 'paytm']]), allocations, categories };
const cube = channelCube(source);
const cell = (filter) => cube.filter((c) => Object.entries(filter).every(([k, v]) => c[k] === v));
const sum = (xs, f = (x) => x.paise) => xs.reduce((t, x) => t + f(x), 0);
const accounts = [{ id: 'A1', label: 'Current account' }, { id: 'A2', label: 'Second account' }, { id: 'A3', label: 'Unused account' }];
const MONTHS = ['2026-10', '2026-11'];
const flow = (o = {}) => flowOf({ cube, accounts, months: MONTHS, groupIn: 'channel', groupOut: 'channel', ...o });
const node = (f, id) => f.nodes.find((n) => n.id === id);

test('the aggregate splits a line by its allocations and names the channel the way the ledger does', () => {
  assert.equal(sum(cell({ c: 'paytm', g: 'salary' })), 70000);
  assert.equal(sum(cell({ c: 'paytm', g: 'farm' })), 30000);
  assert.equal(sum(cell({ c: 'paypro', p: 'P1' })), 50000);
  assert.equal(sum(cell({ c: 'gateway', d: 'in' })), 20000);
  assert.equal(sum(cell({ c: 'card' })), 10000);
  // money is never lost: out and in each add up to the bank lines
  assert.equal(sum(cell({ d: 'out' })), 100000 + 50000 + 40000 + 400000 + 10000);
  assert.equal(sum(cell({ d: 'in' })), 300000 + 20000 + 150000);
});

test('a line nobody has allocated is "other", flagged as having no category, and counted once', () => {
  const none = cell({ c: 'bank', d: 'out', u: 1 });
  assert.equal(none.length, 1);
  assert.equal(none[0].g, 'other');
  assert.equal(none[0].paise, 40000);
  assert.equal(none[0].n, 1);
});

test('what came in is maintenance, money back from the sinking fund, or everything else', () => {
  assert.equal(sum(cell({ d: 'in', g: 'maintenance' })), 300000);
  assert.equal(sum(cell({ d: 'in', g: 'sinking' })), 150000);
  assert.equal(sum(cell({ d: 'in', g: 'other' })), 20000);
  assert.deepEqual(IN_PURPOSES.map((p) => p.id), ['maintenance', 'sinking', 'other']);
  assert.deepEqual(OUT_PURPOSES.map((p) => p.id), ['salary', 'farm', 'projects', 'company', 'sinking', 'other']);
  assert.deepEqual(GROUPINGS, ['channel', 'purpose']);
});

test('the pieces and the cube agree: the pieces add up to the same money, one per allocation', () => {
  const pieces = channelPieces(source);
  assert.equal(sum(pieces), sum(cube));
  assert.equal(pieces.filter((p) => p.lineId === 'l1').length, 2, 'a line split in two allocations is two pieces');
  assert.ok(pieces.every((p) => p.date && p.lineId));
});

test('the months: the year so far, the presets, a range, and the months before', () => {
  assert.deepEqual(fyMonths(2026), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']);
  const so = monthsSoFar({ fy: 2026, today: '2026-11-10' });
  assert.equal(so.length, 8);
  assert.equal(so.at(-1), '2026-11');
  assert.equal(monthsSoFar({ fy: 2025, today: '2026-11-10' }).length, 12, 'a closed year has all twelve');
  assert.deepEqual(presetMonths(so, 'm1'), ['2026-11']);
  assert.deepEqual(presetMonths(so, 'prev'), ['2026-10']);
  assert.deepEqual(presetMonths(so, 'm3'), ['2026-09', '2026-10', '2026-11']);
  assert.deepEqual(presetMonths(so, 'ytd'), so);
  assert.deepEqual(rangeOf(so, '2026-09', '2026-06'), ['2026-06', '2026-07', '2026-08', '2026-09'], 'either order');
  assert.deepEqual(rangeOf(so, '2026-10', '2027-02'), ['2026-10', '2026-11'], 'months that have not begun are left out');
  assert.deepEqual(previousMonths(fyMonths(2026), ['2026-07', '2026-08']), ['2026-05', '2026-06']);
  assert.equal(previousMonths(fyMonths(2026), ['2026-05', '2026-06', '2026-07']), null, 'the year does not reach back that far');
  assert.equal(previousMonths(fyMonths(2026), []), null);
});

test('received and spent leave the fixed deposits out, and everything reconciles to the bank', () => {
  const t = totalsOf(cube, MONTHS);
  assert.equal(t.received, 300000 + 20000);
  assert.equal(t.spent, 100000 + 50000 + 40000 + 10000);
  assert.equal(t.toFd, 400000);
  assert.equal(t.fromFd, 150000);
  assert.equal(t.moved, 250000, 'net moved into the deposits');
  assert.equal(t.left, 320000 - 200000 - 250000, 'received less spent less what moved to the deposits');
  assert.equal(t.left, sum(cell({ d: 'in' })) - sum(cell({ d: 'out' })), 'the same as the bank: money in less money out');
  assert.deepEqual(totalsOf(cube, ['2026-11']), totalsOf(cube.filter((c) => c.m === '2026-11'), ['2026-11']));
});

test('the strip: received and spent for each month, without the deposits', () => {
  const bars = monthBars(cube, ['2026-10', '2026-11', '2026-12']);
  assert.deepEqual(bars.find((b) => b.m === '2026-10'), { m: '2026-10', in: 300000, out: 150000 });
  assert.deepEqual(bars.find((b) => b.m === '2026-11'), { m: '2026-11', in: 20000, out: 40000 + 10000 });
  assert.deepEqual(bars.find((b) => b.m === '2026-12'), { m: '2026-12', in: 0, out: 0 });
});

test('by channel: channels in, the accounts (the fixed deposits too), channels out, each ordered and labelled', () => {
  const f = flow();
  assert.deepEqual(f.nodes.filter((n) => n.col === 0).map((n) => n.id).sort(), ['L:bank', 'L:gateway']);
  assert.deepEqual(f.nodes.filter((n) => n.col === 1).map((n) => n.id), ['A:A1', 'A:A2', 'A:__fd'], 'an account with no money in the months is left out; the deposits come last');
  assert.deepEqual(f.nodes.filter((n) => n.col === 2).map((n) => n.id).sort(), ['R:bank', 'R:card', 'R:paypro', 'R:upi']);
  assert.equal(node(f, 'R:upi').label, 'UPI');
  assert.equal(node(f, 'R:upi').paise, 100000, 'Paytm and BHIM are apps of the one UPI channel');
  assert.equal(node(f, 'R:bank').paise, 40000, 'the bank direct line to the deposits is a transfer, not money out');
});

test('by purpose: what the money was for, with the deposits still an account and not a purpose', () => {
  const f = flow({ groupIn: 'purpose', groupOut: 'purpose' });
  assert.deepEqual(f.nodes.filter((n) => n.col === 0).map((n) => n.id).sort(), ['L:maintenance', 'L:other']);
  assert.deepEqual(f.nodes.filter((n) => n.col === 2).map((n) => n.id).sort(), ['R:farm', 'R:other', 'R:projects', 'R:salary']);
  assert.equal(node(f, 'R:salary').paise, 70000);
  assert.equal(node(f, 'R:farm').paise, 30000 + 10000, 'money that names a project counts under projects, not farm');
  assert.equal(node(f, 'A:__fd').label, 'Fixed deposits');
  assert.equal(node(f, 'A:__fd').kind, 'fd');
});

test('the two sides can be grouped differently', () => {
  const f = flow({ groupIn: 'channel', groupOut: 'purpose' });
  assert.ok(node(f, 'L:gateway') && node(f, 'R:salary') && !node(f, 'R:paytm'));
});

test('every box and band adds up: the money into an account and out of it, the transfers, and what each side shows', () => {
  for (const [groupIn, groupOut] of [['channel', 'channel'], ['purpose', 'purpose'], ['channel', 'purpose'], ['purpose', 'channel']]) {
    const f = flow({ groupIn, groupOut });
    for (const n of f.nodes.filter((x) => x.col === 1)) {
      assert.equal(sum(f.links.filter((l) => l.to === n.id)), n.inPaise);
      assert.equal(sum(f.links.filter((l) => l.from === n.id)), n.outPaise);
      if (n.kind === 'account') assert.equal(n.paise, Math.max(n.inPaise, n.outPaise));
      else assert.ok(n.paise >= Math.max(n.inPaise, n.outPaise), 'the deposits box is at least as tall as what moved');
    }
    for (const n of f.nodes.filter((x) => x.col === 0)) assert.equal(sum(f.links.filter((l) => l.from === n.id)), n.paise);
    for (const n of f.nodes.filter((x) => x.col === 2)) assert.equal(sum(f.links.filter((l) => l.to === n.id)), n.paise);
    const noDeposits = (c) => c.g !== 'sinking' && MONTHS.includes(c.m);
    assert.equal(sum(f.nodes.filter((n) => n.col === 0)), sum(cell({ d: 'in' }).filter(noDeposits)));
    assert.equal(sum(f.nodes.filter((n) => n.col === 2)), sum(cell({ d: 'out' }).filter(noDeposits)));
    assert.ok(f.links.every((l) => l.paise > 0));
  }
});

test('transfers to and from the deposits are green bands between accounts; the rest follow the money: in is blue, out is orange', () => {
  const f = flow();
  const transfers = f.links.filter((l) => l.transfer);
  assert.deepEqual(transfers.map((l) => [l.from, l.to, l.paise, l.kind]), [['A:A1', 'A:__fd', 400000, 'fd'], ['A:__fd', 'A:A1', 150000, 'fd']]);
  assert.ok(f.links.filter((l) => !l.transfer && l.from.startsWith('L:')).every((l) => l.kind === 'in'));
  assert.ok(f.links.filter((l) => !l.transfer && l.to.startsWith('R:')).every((l) => l.kind === 'out'));
});

test('the deposits box is as tall as what they hold, or what moved if that is more, and is left out when nothing is held or moved', () => {
  assert.equal(node(flow({ fdHeld: 1_000_000 }), 'A:__fd').paise, 1_000_000);
  assert.equal(node(flow({ fdHeld: 0 }), 'A:__fd').paise, 400000, 'what moved in is more than what is held');
  assert.equal(node(flow({ fdHeld: 1_000_000 }), 'A:__fd').held, 1_000_000);
  assert.ok(!node(flow({ months: ['2026-12'], fdHeld: 0 }), 'A:__fd'));
  assert.ok(node(flow({ months: ['2026-12'], fdHeld: 500 }), 'A:__fd'), 'they are held even if nothing moved');
});

test('the accounts keep what came in beyond what went out', () => {
  const f = flow();
  assert.equal(node(f, 'A:A1').inPaise - node(f, 'A:A1').outPaise, 470000 - 590000);
  assert.equal(node(f, 'A:A2').outPaise, 10000);
  assert.equal(f.left, f.received - f.spent - f.moved);
});

test('the period: only the months asked for are counted', () => {
  assert.equal(flow({ months: ['2026-10'] }).spent, 150000);
  assert.equal(flow({ months: ['2026-11'] }).received, 20000);
  assert.equal(flow({ months: ['2026-09'] }).hasData, false);
});

test('lines with no category are counted on their box', () => {
  assert.equal(node(flow(), 'R:bank').noCategory, 1);
  assert.equal(node(flow({ groupOut: 'purpose' }), 'R:other').noCategory, 1);
  assert.equal(node(flow(), 'R:upi').noCategory, 0);
});

test('clicking a box or band: the lines behind it add up to the figure on it', () => {
  for (const [groupIn, groupOut] of [['channel', 'channel'], ['purpose', 'purpose'], ['channel', 'purpose'], ['purpose', 'channel']]) {
    const f = flow({ groupIn, groupOut });
    const behind = (spec) => sum(cube.filter((c) => cellMatches(c, spec, MONTHS)));
    for (const n of f.nodes) {
      const spec = specOf({ node: n, nodes: f.nodes, groupIn, groupOut });
      assert.equal(behind(spec), n.col === 1 ? n.inPaise + n.outPaise : n.paise, `${n.id} (${groupIn}/${groupOut})`);
    }
    for (const l of f.links) {
      const spec = specOf({ link: l, nodes: f.nodes, groupIn, groupOut });
      assert.equal(behind(spec), l.paise, `${l.from} -> ${l.to} (${groupIn}/${groupOut})`);
    }
  }
});

test('the deposits mean the lines moved between an account and them, and a channel box leaves those out', () => {
  const f = flow();
  assert.deepEqual(specOf({ node: node(f, 'A:__fd'), nodes: f.nodes, groupIn: 'channel', groupOut: 'channel' }), { fd: 'only' });
  assert.deepEqual(specOf({ link: f.links.find((l) => l.to === 'A:__fd'), nodes: f.nodes, groupIn: 'channel', groupOut: 'channel' }), { fd: 'only', dir: 'out', account: 'A1' }, 'into the deposits');
  assert.deepEqual(specOf({ link: f.links.find((l) => l.from === 'A:__fd'), nodes: f.nodes, groupIn: 'channel', groupOut: 'channel' }), { fd: 'only', dir: 'in', account: 'A1' }, 'back out of them');
  assert.deepEqual(specOf({ node: node(f, 'R:bank'), nodes: f.nodes, groupIn: 'channel', groupOut: 'channel' }), { dir: 'out', channel: 'bank', fd: 'exclude' });
  assert.deepEqual(specOf({ node: { kind: 'out', col: 2, key: 'salary' }, nodes: f.nodes, groupIn: 'channel', groupOut: 'purpose' }), { dir: 'out', purpose: 'salary', fd: 'exclude' });
  assert.equal(FD, '__fd');
});

test('a month outside the chosen ones never matches', () => {
  assert.equal(cellMatches(cell({ c: 'paytm' })[0], {}, ['2026-01']), false);
  assert.equal(cellMatches(cell({ c: 'paytm' })[0], { dir: 'in' }, MONTHS), false);
});

test('Projects opens by project: each project, then money for projects that names none, adding up to the box', () => {
  const cats = [...categories, { id: 'c-proj', name: 'Fencing', type: 'capex', head: 'projects', is_salary: false }];
  const ls = [
    line('p1', '2026-10-03', 'debit', 90000, 'NEFT/0101102630472/10/'), line('p2', '2026-10-04', 'debit', 60000, 'POS/SHOP'),
    line('p3', '2026-10-05', 'debit', 25000, 'POS/SHOP'), line('p4', '2026-11-05', 'debit', 15000, 'POS/SHOP'),
  ];
  const als = [alloc('p1', 'c-farm', 50000, 'P1'), alloc('p1', 'c-farm', 40000, 'P2'), alloc('p2', 'c-farm', 60000, 'P1'), alloc('p3', 'c-proj', 25000), alloc('p4', 'c-proj', 15000, 'P2')];
  const pc = channelCube({ lines: ls, upiAppByLine: new Map(), allocations: als, categories: cats });
  const projects = [{ id: 'P1', name: 'Water tank' }, { id: 'P2', name: 'Perimeter fencing' }];
  const f = flowOf({ cube: pc, accounts, months: MONTHS, groupIn: 'channel', groupOut: 'purpose' });
  const box = node(f, 'R:projects');
  const spec = specOf({ node: box, nodes: f.nodes, groupIn: 'channel', groupOut: 'purpose' });
  assert.equal(spec.purpose, 'projects');
  const rows = projectsOf({ cube: pc, months: MONTHS, spec, projects });
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.paise]), [['P1', 'Water tank', 110000], ['P2', 'Perimeter fencing', 55000], ['', 'No project named', 25000]]);
  assert.equal(sum(rows), box.paise, 'the projects add up to the Projects box');
  assert.equal(rows[0].n, 2, 'two lines went to the water tank');
  // one month, and a link from an account, narrow it the same way
  assert.deepEqual(projectsOf({ cube: pc, months: ['2026-11'], spec, projects }).map((r) => [r.id, r.paise]), [['P2', 15000]]);
  const link = f.links.find((l) => l.to === 'R:projects');
  assert.equal(sum(projectsOf({ cube: pc, months: MONTHS, spec: specOf({ link, nodes: f.nodes, groupIn: 'channel', groupOut: 'purpose' }), projects })), link.paise);
  // choosing a project narrows the lines behind it, and 'none' means the money that names no project
  assert.equal(sum(pc.filter((c) => cellMatches(c, { ...spec, project: 'P1' }, MONTHS))), 110000);
  assert.equal(sum(pc.filter((c) => cellMatches(c, { ...spec, project: 'none' }, MONTHS))), 25000);
  assert.equal(sum(pc.filter((c) => cellMatches(c, { ...spec, project: 'P9' }, MONTHS))), 0);
  assert.deepEqual(projectsOf({ cube: pc, months: MONTHS, spec: { ...spec, project: 'P1' }, projects }).length, 3, 'a project already chosen does not hide the others');
});

test('every purpose breaks down the same way: projects by project, salary and maintenance by person, the rest by category, a channel by purpose', () => {
  assert.equal(breakdownOf({ dir: 'out', purpose: 'projects', fd: 'exclude' }), 'project');
  assert.equal(breakdownOf({ dir: 'out', purpose: 'salary', fd: 'exclude' }), 'party');
  assert.equal(breakdownOf({ dir: 'in', purpose: 'maintenance', fd: 'exclude' }), 'party');
  for (const purpose of ['farm', 'company', 'other']) assert.equal(breakdownOf({ dir: 'out', purpose, fd: 'exclude' }), 'category', purpose);
  assert.equal(breakdownOf({ dir: 'out', channel: 'paytm', fd: 'exclude' }), 'purpose');
  assert.equal(breakdownOf({ account: 'A1' }), null, 'an account goes straight to its lines');
  assert.equal(breakdownOf({ dir: 'out', fd: 'only' }), null, 'so do the fixed deposits');
});

test('a channel is broken down by what its money was for, adding up to the box', () => {
  const f = flow();
  const box = node(f, 'R:upi');
  const spec = specOf({ node: box, nodes: f.nodes, groupIn: 'channel', groupOut: 'channel' });
  const rows = purposesOf({ cube, months: MONTHS, spec });
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.paise]), [['salary', 'Salary', 70000], ['farm', 'Farm and household', 30000]]);
  assert.equal(sum(rows), box.paise);
  const bank = purposesOf({ cube, months: MONTHS, spec: specOf({ node: node(f, 'R:bank'), nodes: f.nodes, groupIn: 'channel', groupOut: 'channel' }) });
  assert.deepEqual(bank.map((r) => r.id), ['other'], 'the bank direct line to the deposits is not here');
});

test('pieces are grouped by person or by category, with what has none named, counting each line once', () => {
  const ps = [
    { lineId: 'a', paise: 500, party: 'P1', cat: 'C1' }, { lineId: 'b', paise: 300, party: 'P1', cat: 'C2' }, { lineId: 'b', paise: 100, party: 'P1', cat: 'C2' },
    { lineId: 'c', paise: 200, party: 'P2', cat: 'C1' }, { lineId: 'd', paise: 50, party: '', cat: '' }, { lineId: 'e', paise: 20, party: 'P9', cat: 'C9' },
  ];
  const people = groupPieces(ps, 'party', new Map([['P1', 'Asha'], ['P2', 'Ravi']]));
  assert.deepEqual(people.map((r) => [r.id, r.name, r.paise, r.n]), [['P1', 'Asha', 900, 2], ['P2', 'Ravi', 200, 1], ['', 'No one named', 50, 1], ['P9', 'Someone no longer listed', 20, 1]]);
  const cats = groupPieces(ps, 'category', new Map([['C1', 'Wages'], ['C2', 'Repairs']]));
  assert.deepEqual(cats.map((r) => [r.id, r.name, r.paise]), [['C1', 'Wages', 700], ['C2', 'Repairs', 400], ['', 'No category yet', 50], ['C9', 'Another category', 20]]);
  assert.equal(sum(people), sum(ps));
});

test('a person or category narrows the lines behind a box, and none means nobody named', () => {
  const ps = [{ m: '2026-10', d: 'out', g: 'salary', c: 'bank', a: 'A1', p: '', cat: 'C1', party: 'P1', paise: 1 }, { m: '2026-10', d: 'out', g: 'salary', c: 'bank', a: 'A1', p: '', cat: 'C1', party: '', paise: 1 }];
  const hit = (spec) => ps.filter((p) => cellMatches(p, spec, ['2026-10'])).length;
  assert.equal(hit({ party: 'P1' }), 1);
  assert.equal(hit({ party: 'none' }), 1);
  assert.equal(hit({ category: 'C1' }), 2);
  assert.equal(hit({ category: 'none' }), 0);
  assert.equal(hit({ party: 'P1', category: 'C1' }), 1);
});

test('Paytm and BHIM are channels under UPI: one UPI box, opened by the person behind each payment whichever app they used', () => {
  assert.deepEqual([...UPI_APPS].sort(), ['bhim', 'paytm', 'upi_unknown']);
  assert.equal(channelGroupOf('paytm'), 'upi');
  assert.equal(channelGroupOf('paypro'), 'paypro', 'the other channels are their own');
  const more = channelCube({ lines: [...lines, line('u2', '2026-10-21', 'debit', 25000, 'UPI/P2A/600000000002/Shop/Bank')], upiAppByLine: new Map([['l1', 'paytm'], ['u2', 'bhim']]), allocations: [...allocations, alloc('u2', 'c-farm', 25000)], categories });
  const f = flowOf({ cube: more, accounts, months: MONTHS });
  const box = node(f, 'R:upi');
  assert.equal(box.paise, 100000 + 25000);
  assert.ok(!node(f, 'R:paytm') && !node(f, 'R:bhim'), 'no box of their own');
  const spec = specOf({ node: box, nodes: f.nodes, groupIn: 'channel', groupOut: 'channel' });
  assert.equal(spec.channel, 'upi');
  assert.equal(breakdownOf(spec), 'operator', 'by whose UPI it went through first, not by app');
  assert.equal(breakdownOf({ dir: 'out', channel: 'paypro', fd: 'exclude' }), 'purpose', 'every other channel is broken down by purpose');
  assert.equal(sum(more.filter((c) => cellMatches(c, spec, MONTHS))), box.paise);
  assert.equal(sum(more.filter((c) => cellMatches(c, { ...spec, channel: 'bhim' }, MONTHS))), 25000);
  assert.equal(sum(more.filter((c) => cellMatches(c, { ...spec, channel: 'paypro' }, MONTHS))), 50000);
});

test('UPI by person: direct, and the UPI circle’s delegates under the same UPI ID, whichever app each used', () => {
  const ps = [
    { lineId: 'a', paise: 500, delegate: 'own', c: 'paytm' }, { lineId: 'b', paise: 300, delegate: 'D1', c: 'paytm' }, { lineId: 'c', paise: 100, delegate: 'D1', c: 'bhim' },
    { lineId: 'd', paise: 50, delegate: 'none', c: 'paytm' }, { lineId: 'e', paise: 20, delegate: 'D9', c: 'bhim' },
  ];
  const rows = groupPieces(ps, 'delegate', new Map([['D1', 'UPI circle · Number 5550100001']]));
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.paise, r.n]), [['own', 'Direct', 500, 1], ['D1', 'UPI circle · Number 5550100001', 400, 2], ['none', 'UPI circle · no delegate yet', 50, 1], ['D9', 'UPI circle · a delegate no longer listed', 20, 1]]);
  assert.equal(sum(rows), sum(ps), 'the people add up to the UPI box');
  const hit = (spec) => ps.filter((p) => cellMatches({ m: '2026-10', d: 'out', g: 'farm', a: 'A1', p: '', ...p }, spec, ['2026-10'])).length;
  assert.equal(hit({ delegate: 'D1' }), 2, 'both apps count for the one person');
  assert.equal(hit({ delegate: 'own' }), 1);
  assert.equal(hit({ delegate: 'none' }), 1);
});

test('UPI opens as a tree: by operator, then by person (Direct and each delegate of that operator’s circle), then lines', () => {
  assert.deepEqual(drillDims({ dir: 'out', channel: 'upi', fd: 'exclude' }, { operators: 2 }), ['operator', 'delegate']);
  assert.deepEqual(drillDims({ dir: 'out', channel: 'upi', fd: 'exclude' }, { operators: 0 }), ['delegate'], 'no operators recorded yet: straight to the people');
  assert.deepEqual(drillDims({ dir: 'out', purpose: 'salary', fd: 'exclude' }, { operators: 2 }), ['party'], 'every other box has its one level');
  assert.deepEqual(drillDims({ dir: 'out', channel: 'paypro', fd: 'exclude' }), ['purpose']);
  assert.deepEqual(drillDims({ fd: 'only' }), [], 'the deposits go straight to their lines');
  // the pieces of two operators' UPI: operator A directly and through a delegate, operator B directly
  const ps = [
    { lineId: 'a', paise: 500, operator: 'OA', delegate: 'own' }, { lineId: 'b', paise: 300, operator: 'OA', delegate: 'D1' },
    { lineId: 'c', paise: 200, operator: 'OB', delegate: 'own' }, { lineId: 'd', paise: 40, operator: '', delegate: 'own' },
  ];
  const ops = groupPieces(ps, 'operator', new Map([['OA', 'Test operator A'], ['OB', 'Test operator B']]));
  assert.deepEqual(ops.map((r) => [r.id, r.name, r.paise]), [['OA', 'Test operator A', 800], ['OB', 'Test operator B', 200], ['', 'Operator not recorded', 40]]);
  assert.equal(sum(ops), sum(ps), 'the operators add up to the UPI box');
  const hit = (spec) => ps.filter((p) => cellMatches({ m: '2026-10', d: 'out', g: 'farm', a: 'A1', p: '', ...p }, spec, ['2026-10']));
  const inA = hit({ operator: 'OA' });
  assert.equal(sum(inA), 800);
  assert.deepEqual(groupPieces(inA, 'delegate', new Map([['D1', 'UPI circle · Number 5550100001']])).map((r) => [r.name, r.paise]), [['Direct', 500], ['UPI circle · Number 5550100001', 300]], 'inside operator A: direct and their delegate');
  assert.equal(sum(hit({ operator: 'OB' })), 200);
  assert.equal(sum(hit({ operator: 'none' })), 40);
  assert.equal(sum(hit({ operator: 'OA', delegate: 'D1' })), 300);
});
