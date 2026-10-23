// Run with: node --test scripts/lib/staff-tour.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOURS, TOUR_PAGES, fullTourFor, tourLatest, tourStepsFor } from './staff-tour.mjs';

test('every tool, Access, Security and Home has a tour', () => {
  for (const page of ['home', 'photo-pool', 'whatsapp', 'event-payments', 'accommodation', 'members', 'usage', 'access', 'security']) {
    assert.ok(TOUR_PAGES.includes(page), `no tour for ${page}`);
    assert.ok(TOURS[page].length > 0);
  }
});

test('on each page steps are unique, ordered by since, and since starts at 1 with no gaps', () => {
  for (const page of TOUR_PAGES) {
    const steps = TOURS[page];
    assert.equal(new Set(steps.map((s) => s.id)).size, steps.length, `${page}: duplicate step id`);
    const sinces = steps.map((s) => s.since);
    assert.deepEqual(sinces, [...sinces].sort((a, b) => a - b), `${page}: steps out of order`);
    for (let n = 1; n <= tourLatest(page); n++) assert.ok(sinces.includes(n), `${page}: no step has since ${n}`);
    for (const s of steps) {
      assert.ok(s.target && s.title && s.text && s.tag, `${page}/${s.id}: missing field`);
      assert.ok(['all', 'super'].includes(s.audience), `${page}/${s.id}: bad audience`);
    }
  }
});

test('a brand new super admin gets every step on a page', () => {
  for (const page of TOUR_PAGES) assert.deepEqual(tourStepsFor({ page, isSuperAdmin: true, seenThrough: null }), TOURS[page]);
});

test('an existing admin gets only what was added after what they saw', () => {
  for (const page of TOUR_PAGES) {
    assert.deepEqual(tourStepsFor({ page, isSuperAdmin: true, seenThrough: tourLatest(page) }), []);
    assert.ok(tourStepsFor({ page, isSuperAdmin: true, seenThrough: 0 }).length > 0);
    assert.ok(tourStepsFor({ page, isSuperAdmin: true, seenThrough: 1 }).every((s) => s.since > 1));
  }
});

test('super-admin steps are never shown to other admins', () => {
  for (const page of TOUR_PAGES) {
    for (const isSuperAdmin of [false, undefined]) {
      assert.ok(tourStepsFor({ page, isSuperAdmin, seenThrough: null }).every((s) => s.audience === 'all'));
      assert.ok(fullTourFor(page, isSuperAdmin).every((s) => s.audience === 'all'));
    }
  }
  assert.equal(fullTourFor('home', true).length, TOURS.home.length);
  assert.ok(fullTourFor('home', false).length < TOURS.home.length);
  assert.equal(fullTourFor('access', false).length, 0);
});

test('a page with no tour, or a failed or odd read of what was seen, shows nothing', () => {
  assert.deepEqual(fullTourFor('nope', true), []);
  assert.deepEqual(tourStepsFor({ page: 'nope', isSuperAdmin: true, seenThrough: null }), []);
  assert.equal(tourLatest('nope'), 0);
  for (const seenThrough of [undefined, NaN, '1', 1.5]) assert.deepEqual(tourStepsFor({ page: 'home', isSuperAdmin: true, seenThrough }), []);
});

// A step points at `data-tour="<target>"`; if someone renames or removes that attribute the tour quietly
// degrades to a centred card, so pin each target to the file that must carry it.
test('every step target exists in the page (or the shell) it points at', () => {
  const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const shell = read('src/layouts/StaffLayout.astro');
  const files = {
    home: 'src/pages/internal/index.astro',
    'photo-pool': 'src/pages/internal/photo-pool.astro',
    whatsapp: 'src/pages/internal/whatsapp.astro',
    'event-payments': 'src/pages/internal/event-payments.astro',
    accommodation: 'src/pages/internal/accommodation-calendar.astro',
    members: 'src/pages/internal/members.astro',
    usage: 'src/pages/internal/usage.astro',
    access: 'src/pages/internal/access.astro',
    security: 'src/pages/internal/security.astro',
  };
  assert.deepEqual(Object.keys(files).sort(), [...TOUR_PAGES].sort(), 'a page with a tour has no file listed here');
  for (const page of TOUR_PAGES) {
    const source = read(files[page]);
    for (const step of TOURS[page]) {
      const marker = `data-tour="${step.target}"`;
      assert.ok(source.includes(marker) || shell.includes(marker), `${page}/${step.id}: no element with ${marker}`);
    }
  }
});
