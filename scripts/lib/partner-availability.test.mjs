import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidDate, addDays, parseWindow, parseDateRange, toCatalogue, buildAvailability, bookingRange } from './partner-availability.mjs';

const NOW = new Date('2026-10-24T06:00:00Z'); // 11:30 IST, 24 Oct 2026

test('isValidDate rejects impossible and malformed dates', () => {
  assert.equal(isValidDate('2026-12-12'), true);
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-2-3'), false);
  assert.equal(isValidDate('tomorrow'), false);
  assert.equal(isValidDate(null), false);
});

test('addDays crosses month and year ends', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('parseWindow lists each night, excluding the end date', () => {
  assert.deepEqual(parseWindow('2026-12-12', '2026-12-15', NOW), { dates: ['2026-12-12', '2026-12-13', '2026-12-14'] });
});

test('parseWindow enforces the window rules', () => {
  assert.match(parseWindow('2026-12-15', '2026-12-12', NOW).error, /after from/);
  assert.match(parseWindow('2026-12-12', '2026-12-12', NOW).error, /after from/);
  assert.match(parseWindow('2026-12-12', 'x', NOW).error, /YYYY-MM-DD/);
  assert.match(parseWindow('2026-10-23', '2026-10-25', NOW).error, /past/);
  assert.match(parseWindow('2026-11-01', '2027-02-01', NOW).error, /at most 90/);
  assert.match(parseWindow('2027-10-20', '2027-10-26', NOW).error, /days ahead/);
  assert.ok(parseWindow('2026-10-24', '2026-10-25', NOW).dates);
  assert.equal(parseWindow('2026-11-01', '2027-01-30', NOW).dates.length, 90);
});

test('parseWindow uses the date in India, not UTC', () => {
  // 20:00 UTC on the 23rd is already the 24th in India.
  const lateUtc = new Date('2026-10-23T20:00:00Z');
  assert.ok(parseWindow('2026-10-24', '2026-10-25', lateUtc).dates);
  assert.match(parseWindow('2026-10-23', '2026-10-25', lateUtc).error, /past/);
});

test('parseDateRange reads Postgres daterange text', () => {
  assert.deepEqual(parseDateRange('[2026-12-12,2026-12-15)'), { start: '2026-12-12', end: '2026-12-15' });
  assert.deepEqual(parseDateRange('(2026-12-11,2026-12-14]'), { start: '2026-12-12', end: '2026-12-15' });
  assert.equal(parseDateRange('empty'), null);
  assert.equal(parseDateRange(undefined), null);
});

const unit = (id, extra = {}) => ({ id, name: `Unit ${id}`, capacity: 2, active: true, group_name: null, pool_id: null, ...extra });
const dates = ['2026-12-12', '2026-12-13', '2026-12-14'];

test('a unit is unavailable exactly on the nights it is assigned', () => {
  const out = buildAvailability({
    dates,
    units: [unit('Tent01'), unit('Tent02')],
    pools: [],
    assignments: [{ tent_id: 'Tent01', stay_range: '[2026-12-13,2026-12-14)' }],
    blocks: [],
  });
  assert.equal(out.from, '2026-12-12');
  assert.equal(out.to, '2026-12-15');
  assert.deepEqual(out.units[0], { id: 'Tent01', nights: { '2026-12-12': 'free', '2026-12-13': 'unavailable', '2026-12-14': 'free' } });
  assert.deepEqual(Object.values(out.units[1].nights), ['free', 'free', 'free']);
});

test('the checkout night is free again', () => {
  const out = buildAvailability({
    dates,
    units: [unit('Tent01')],
    pools: [],
    assignments: [{ tent_id: 'Tent01', stay_range: '[2026-12-10,2026-12-13)' }],
    blocks: [],
  });
  assert.deepEqual(Object.values(out.units[0].nights), ['unavailable', 'free', 'free']);
});

test('a farm closure or exclusive booking closes every unit', () => {
  const out = buildAvailability({
    dates,
    units: [unit('Tent01'), unit('Tent02')],
    pools: [{ id: 'tents', name: 'Tents', units: [unit('Tent03'), unit('Tent04')] }],
    assignments: [],
    blocks: [bookingRange({ start_date: '2026-12-12', nights: 2 })],
  });
  for (const u of out.units) assert.deepEqual(Object.values(u.nights), ['unavailable', 'unavailable', 'free']);
  assert.deepEqual(out.pools[0].nights['2026-12-12'], { free: 0, total: 2 });
  assert.deepEqual(out.pools[0].nights['2026-12-14'], { free: 2, total: 2 });
});

test('a pool reports how many of its units are free', () => {
  const members = [unit('Tent03'), unit('Tent04'), unit('Tent05')];
  const out = buildAvailability({
    dates,
    units: [],
    pools: [{ id: 'tents', name: 'Tents', units: members }],
    assignments: [
      { tent_id: 'Tent03', stay_range: '[2026-12-12,2026-12-14)' },
      { tent_id: 'Tent04', stay_range: '[2026-12-13,2026-12-15)' },
    ],
    blocks: [],
  });
  assert.deepEqual(out.pools[0].nights, {
    '2026-12-12': { free: 2, total: 3 },
    '2026-12-13': { free: 1, total: 3 },
    '2026-12-14': { free: 2, total: 3 },
  });
});

test('inactive units are left out of units and pool totals', () => {
  const out = buildAvailability({
    dates: ['2026-12-12'],
    units: [unit('Tent01', { active: false })],
    pools: [{ id: 'tents', name: 'Tents', units: [unit('Tent03'), unit('Tent04', { active: false })] }],
    assignments: [],
    blocks: [],
  });
  assert.deepEqual(out.units, []);
  assert.deepEqual(out.pools[0].nights['2026-12-12'], { free: 1, total: 1 });
});

test('the catalogue never reveals ownership or unit kind', () => {
  const catalogue = toCatalogue({
    units: [
      unit('Tent01', { group_name: 'Malabar Hut', kind: 'fixed', owner_type: 'tvc' }),
      unit('M1', { kind: 'member-home', owner_type: 'member', owner_farm_unit: 'F-12', name: 'Garden Home' }),
      unit('Old', { active: false }),
    ],
    pools: [{ id: 'tents', name: 'Tents', active: true, units: [unit('Tent03', { capacity: 2 }), unit('Tent04', { capacity: 3 })] }, { id: 'gone', name: 'Gone', active: false, units: [] }],
  });
  assert.deepEqual(catalogue.units, [
    { id: 'Tent01', name: 'Unit Tent01', capacity: 2, group: 'Malabar Hut' },
    { id: 'M1', name: 'Garden Home', capacity: 2 },
  ]);
  assert.deepEqual(catalogue.pools, [{ id: 'tents', name: 'Tents', size: 2, capacity: { min: 2, max: 3 } }]);
  const text = JSON.stringify(catalogue);
  for (const leak of ['owner', 'kind', 'F-12', 'member']) assert.ok(!text.includes(leak), `catalogue leaks ${leak}`);
});

test('a farm closure does not apply to a unit its owner set to stay open', () => {
  const out = buildAvailability({
    dates,
    units: [unit('Tent01'), unit('M1', { ignores_farm_closure: true })],
    pools: [],
    assignments: [],
    blocks: [{ start: '2026-12-13', end: '2026-12-14' }],
  });
  assert.deepEqual(Object.values(out.units[0].nights), ['free', 'unavailable', 'free']);
  assert.deepEqual(Object.values(out.units[1].nights), ['free', 'free', 'free']);
});

test('a stay-open unit is still unavailable on the nights it is booked', () => {
  const out = buildAvailability({
    dates,
    units: [unit('M1', { ignores_farm_closure: true })],
    pools: [],
    assignments: [{ tent_id: 'M1', stay_range: '[2026-12-12,2026-12-13)' }],
    blocks: [{ start: '2026-12-13', end: '2026-12-14' }],
  });
  assert.deepEqual(Object.values(out.units[0].nights), ['unavailable', 'free', 'free']);
});

test('a paused unit is unavailable every night and does not count in its pool', () => {
  const tent = unit('Tent03');
  const paused = unit('Tent04', { status: 'paused' });
  const out = buildAvailability({
    dates,
    units: [paused],
    pools: [{ id: 'tents', name: 'Tents', units: [tent, paused] }],
    assignments: [],
    blocks: [],
  });
  assert.deepEqual(Object.values(out.units[0].nights), ['unavailable', 'unavailable', 'unavailable']);
  assert.deepEqual(out.pools[0].nights['2026-12-12'], { free: 1, total: 1 });
});

test('a pool of stay-open and closed units counts each correctly on a closure night', () => {
  const out = buildAvailability({
    dates,
    units: [],
    pools: [{ id: '2bhk', name: '2 BHK', units: [unit('A'), unit('B', { ignores_farm_closure: true })] }],
    assignments: [],
    blocks: [{ start: '2026-12-13', end: '2026-12-14' }],
  });
  assert.deepEqual(out.pools[0].nights['2026-12-13'], { free: 1, total: 2 });
  assert.deepEqual(out.pools[0].nights['2026-12-12'], { free: 2, total: 2 });
});

test('the catalogue sizes a pool by units that are offered, not paused ones', () => {
  const catalogue = toCatalogue({
    units: [],
    pools: [{ id: 'tents', name: 'Tents', active: true, units: [unit('Tent03'), unit('Tent04', { status: 'paused' })] }],
  });
  assert.equal(catalogue.pools[0].size, 1);
});
