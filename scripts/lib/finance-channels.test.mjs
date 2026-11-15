// Run with: node --test scripts/lib/finance-channels.test.mjs
//
// The Channels view: money by account and channel (what the ledger already calls an origin), sliced by what it was for. Every name,
// number and amount here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IN_PURPOSES, OUT_PURPOSES, channelCube, graphOf, monthsOfPeriod, usedFor } from './finance-channels.mjs';

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
];
const allocations = [
  alloc('l1', 'c-sal', 70000), alloc('l1', 'c-farm', 30000), alloc('l2', 'c-farm', 50000, 'P1'),
  alloc('l4', 'c-sink', 400000), alloc('l5', 'c-maint', 300000), alloc('l6', 'c-rev', 20000), alloc('l7', 'c-farm', 10000),
];
const cube = channelCube({ lines, upiAppByLine: new Map([['l1', 'paytm']]), allocations, categories });
const cell = (filter) => cube.filter((c) => Object.entries(filter).every(([k, v]) => c[k] === v));
const sum = (cells) => cells.reduce((t, c) => t + c.paise, 0);
const accounts = [{ id: 'A1', label: 'Current account' }, { id: 'A2', label: 'Second account' }];
const node = (g, id) => g.nodes.find((n) => n.id === id);
const g = (filters = {}, extra = {}) => graphOf({ cube, accounts, delegates: [], delegatePayments: [], fd: { balances: {} }, projects: [{ id: 'P1', name: 'Water tank' }], filters: { months: ['2026-10', '2026-11'], dir: 'out', account: 'all', purpose: 'all', ...filters }, ...extra });

test('the aggregate splits a line by its allocations and names the channel the way the ledger does', () => {
  assert.equal(sum(cell({ c: 'paytm', g: 'salary' })), 70000);
  assert.equal(sum(cell({ c: 'paytm', g: 'farm' })), 30000);
  assert.equal(sum(cell({ c: 'paypro', p: 'P1' })), 50000);
  assert.equal(sum(cell({ c: 'gateway', d: 'in' })), 20000);
  assert.equal(sum(cell({ c: 'card' })), 10000);
  // money is never lost: out and in each add up to the bank lines
  assert.equal(sum(cell({ d: 'out' })), 100000 + 50000 + 40000 + 400000 + 10000);
  assert.equal(sum(cell({ d: 'in' })), 300000 + 20000);
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
  assert.equal(sum(cell({ d: 'in', g: 'other' })), 20000);
  const back = channelCube({ lines: [line('r1', '2026-11-10', 'credit', 90000, 'INB/NEFT/X/Deposit/Bank')], upiAppByLine: new Map(), allocations: [alloc('r1', 'c-sink', 90000)], categories });
  assert.equal(back[0].g, 'sinking');
  assert.deepEqual(IN_PURPOSES.map((p) => p.id), ['maintenance', 'sinking', 'other']);
  assert.deepEqual(OUT_PURPOSES.map((p) => p.id), ['salary', 'farm', 'projects', 'company', 'sinking', 'other']);
});

test('the graph: accounts feed channels, and the channels add up to the account and to the bank', () => {
  const r = g();
  assert.equal(r.total, 100000 + 50000 + 40000 + 400000 + 10000);
  assert.equal(node(r, 'acct:A1').paise, 590000 - 0);
  assert.equal(node(r, 'acct:A2').paise, 10000);
  const channels = r.nodes.filter((n) => n.kind === 'channel');
  assert.equal(sum(channels.map((n) => ({ paise: n.paise }))), r.total);
  assert.deepEqual(channels.map((n) => n.id).sort(), ['ch:bank', 'ch:card', 'ch:paypro', 'ch:paytm']);
  assert.equal(r.edges.find((e) => e.from === 'acct:A1' && e.to === 'ch:paytm').paise, 100000);
  assert.ok(r.edges.every((e) => e.paise > 0));
});

test('idle channels are left out of the picture', () => {
  assert.ok(!g().nodes.some((n) => n.id === 'ch:gateway'), 'nothing went out through the gateway');
  assert.ok(g({ dir: 'in' }).nodes.some((n) => n.id === 'ch:gateway'));
});

test('money in flows the other way: from the channel into the account', () => {
  const r = g({ dir: 'in' });
  assert.equal(r.total, 320000);
  assert.ok(r.edges.some((e) => e.from === 'ch:gateway' && e.to === 'acct:A1'));
});

test('the period: only the months asked for are counted', () => {
  assert.equal(g({ months: ['2026-11'] }).total, 40000 + 400000 + 10000);
  assert.equal(g({ months: ['2026-10'] }).total, 150000);
  assert.deepEqual(monthsOfPeriod({ fy: 2026, today: '2026-11-10', period: 'ytd' }), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  assert.deepEqual(monthsOfPeriod({ fy: 2026, today: '2026-11-10', period: 'm3' }), ['2026-09', '2026-10', '2026-11']);
  assert.deepEqual(monthsOfPeriod({ fy: 2026, today: '2026-11-10', period: 'm1' }), ['2026-11']);
  assert.equal(monthsOfPeriod({ fy: 2025, today: '2026-11-10', period: 'm3' }).length, 12, 'a closed year has only the whole year');
});

test('the account filter keeps one account', () => {
  const r = g({ account: 'A2' });
  assert.equal(r.total, 10000);
  assert.deepEqual(r.nodes.filter((n) => n.kind === 'account').map((n) => n.id), ['acct:A2']);
});

test('the purpose filter keeps only that money, through the channels it used', () => {
  const sal = g({ purpose: 'salary' });
  assert.equal(sal.total, 70000);
  assert.deepEqual(sal.nodes.filter((n) => n.kind === 'channel').map((n) => n.id), ['ch:paytm']);
  const farm = g({ purpose: 'farm' });
  assert.equal(farm.total, 30000 + 10000, 'money that names a project counts under projects, not farm');
  assert.equal(g({ purpose: 'projects' }).total, 50000);
  assert.equal(g({ purpose: 'project:P1' }).total, 50000);
  assert.equal(g({ purpose: 'project:P2' }).total, 0);
  assert.equal(g({ dir: 'in', purpose: 'maintenance' }).total, 300000);
  assert.equal(g({ purpose: 'maintenance' }).total, g().total, 'a purpose that does not apply to this direction is ignored');
});

test('lines with no category are counted on their channel, and only when no purpose is chosen', () => {
  const att = node(g(), 'ch:bank').attention;
  assert.deepEqual(att, [{ tone: 'warn', text: '1 line has no category' }]);
  assert.deepEqual(node(g({ purpose: 'farm' }), 'ch:paytm').attention, []);
});

test('fixed deposits: a circle outside the accounts, with the money put in through the channel that carried it', () => {
  const r = g({}, { fd: { balances: { '2026-10': 1000000, '2026-11': 1400000 } } });
  const fd = node(r, 'fd');
  assert.equal(fd.paise, 1400000, 'the balance at the end of the last month in the period');
  assert.deepEqual(r.edges.find((e) => e.to === 'fd'), { from: 'ch:bank', to: 'fd', paise: 400000 });
  assert.equal(r.total, 100000 + 50000 + 40000 + 400000 + 10000, 'the deposits are not an account and do not change the total');
  assert.ok(!node(g({ account: 'A1' }, { fd: { balances: { '2026-11': 1 } } }), 'fd'), 'hidden when one account is chosen');
  assert.ok(!node(g({ purpose: 'farm' }, { fd: { balances: { '2026-11': 1 } } }), 'fd'), 'hidden unless the purpose is the sinking fund');
  assert.ok(node(g({ purpose: 'sinking' }, { fd: { balances: { '2026-11': 1400000 } } }), 'fd'));
});

test('delegates: they pay through a UPI app, so they hang off the channel, and only in the unfiltered money-out view', () => {
  const delegates = [{ id: 'd1', label: '5550100001', number: '5550100001', capPaise: 1500000 }, { id: 'd2', label: 'Test Person', number: '5550100002', capPaise: 500000 }];
  const delegatePayments = [{ m: '2026-10', d: 'd1', app: 'paytm', paise: 60000, n: 3 }, { m: '2026-11', d: 'd1', app: 'paytm', paise: 20000, n: 1 }, { m: '2026-11', d: 'd2', app: 'paytm', paise: 10000, n: 1 }, { m: '2026-11', d: null, app: 'paytm', paise: 5000, n: 1 }];
  const r = g({}, { delegates, delegatePayments });
  const d1 = node(r, 'del:d1');
  assert.equal(d1.paise, 80000);
  assert.equal(d1.monthPaise, 20000, 'what they paid in the last month of the period, against their limit');
  assert.equal(d1.capPaise, 1500000);
  assert.equal(node(r, 'del:d2').label, 'Test Person');
  assert.equal(node(r, 'del:none').label, 'No delegate yet');
  assert.deepEqual(r.edges.filter((e) => e.to === 'del:d1'), [{ from: 'ch:paytm', to: 'del:d1', paise: 80000 }]);
  assert.ok(!g({ dir: 'in' }, { delegates, delegatePayments }).nodes.some((n) => n.kind === 'delegate'));
  assert.ok(!g({ purpose: 'farm' }, { delegates, delegatePayments }).nodes.some((n) => n.kind === 'delegate'), 'their spend is not split by purpose');
});

test('what a channel was used for: its money by purpose, biggest first, ignoring any purpose filter', () => {
  const f = { months: ['2026-10', '2026-11'], dir: 'out', account: 'all', purpose: 'salary' };
  assert.deepEqual(usedFor({ cube, filters: f, channelId: 'paytm' }), [{ id: 'salary', label: 'Salary', paise: 70000 }, { id: 'farm', label: 'Farm and household', paise: 30000 }]);
  assert.deepEqual(usedFor({ cube, filters: f, channelId: 'paypro' }), [{ id: 'projects', label: 'Projects', paise: 50000 }]);
  assert.deepEqual(usedFor({ cube, filters: { ...f, dir: 'in' }, channelId: 'gateway' }), [{ id: 'other', label: 'Everything else', paise: 20000 }]);
  assert.deepEqual(usedFor({ cube, filters: { ...f, account: 'A2' }, channelId: 'paytm' }), []);
});
