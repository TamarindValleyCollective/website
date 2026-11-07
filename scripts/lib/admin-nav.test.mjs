// Run with: node --test scripts/lib/admin-nav.test.mjs
// The admin portal's navigation: logical blocks (Operations, Community, Finance, Settings), each holding pages, and who
// sees which. The pane (StaffLayout.astro) is built from this; the tests keep it honest against the permission registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKS, HOME, blockOfPage, visibleNav, firstPage } from './admin-nav.mjs';
import { MODULE_INFO } from '../../netlify/functions/lib/staff-registry.ts';

const admin = (modules, isSuperAdmin = false) => ({ isSuperAdmin, tools: modules.map((module) => ({ module })) });
const pageIds = (blocks) => blocks.flatMap((b) => b.pages.map((p) => p.id));

test('the blocks are Operations, Community, Finance and Settings, in that order', () => {
  assert.deepEqual(BLOCKS.map((b) => [b.id, b.label]), [['operations', 'Operations'], ['community', 'Community'], ['finance', 'Finance'], ['settings', 'Settings']]);
});

test('every registered tool has a page in some block, so nothing falls out of the pane', () => {
  const inNav = new Set(BLOCKS.flatMap((b) => b.pages.map((p) => p.module).filter(Boolean)));
  for (const id of Object.keys(MODULE_INFO)) assert.ok(inNav.has(id), `${id} is in no block`);
  for (const m of inNav) assert.ok(m in MODULE_INFO, `${m} is not a registered module`);
});

test('page ids and paths are unique, and every path is an internal page', () => {
  const pages = BLOCKS.flatMap((b) => b.pages);
  assert.equal(new Set(pages.map((p) => p.id)).size, pages.length);
  assert.equal(new Set(pages.map((p) => p.path)).size, pages.length);
  for (const p of pages) assert.match(p.path, /^\/internal\/.*\/$/);
  assert.equal(HOME.path, '/internal/');
});

test('Finance holds the money pages: Overview, Ledger, UPI, Parties, Import, Rules, Requests and Payments', () => {
  const finance = BLOCKS.find((b) => b.id === 'finance');
  assert.deepEqual(finance.pages.map((p) => p.label), ['Overview', 'Ledger', 'UPI', 'Parties', 'Import', 'Rules', 'Requests', 'Payments']);
});

test('Community holds Members and Photos; Photos moved out of Operations', () => {
  assert.deepEqual(BLOCKS.find((b) => b.id === 'community').pages.map((p) => p.label), ['Members', 'Photos']);
  assert.ok(!BLOCKS.find((b) => b.id === 'operations').pages.some((p) => p.label === 'Photos'));
});

test('a page maps back to its block; Today belongs to none', () => {
  assert.equal(blockOfPage('finance-parties'), 'finance');
  assert.equal(blockOfPage('event-payments'), 'finance');
  assert.equal(blockOfPage('photo-pool'), 'community');
  assert.equal(blockOfPage('security'), 'settings');
  assert.equal(blockOfPage('home'), null);
  assert.equal(blockOfPage('nonsense'), null);
});

test('a person sees only the pages their roles open: no roles, only Today', () => {
  assert.deepEqual(visibleNav(admin([]), 'home'), []);
});

test('a finance person sees the finance pages their module opens, and Requests only with that module', () => {
  const nav = visibleNav(admin(['finance']), 'finance');
  assert.deepEqual(nav.map((b) => b.id), ['finance']);
  assert.deepEqual(pageIds(nav), ['finance', 'finance-ledger', 'finance-upi', 'finance-parties', 'finance-import', 'finance-rules']);
  const withRequests = visibleNav(admin(['finance', 'finance-requests']), 'finance');
  assert.ok(pageIds(withRequests).includes('finance-requests'));
});

test('the farm manager (finance-requests only) sees Requests in Finance and nothing else of it', () => {
  const nav = visibleNav(admin(['finance-requests']), 'finance-requests');
  assert.deepEqual(pageIds(nav), ['finance-requests']);
});

test('a super admin also sees Rent out under Operations and Access, Security, Preview under Settings', () => {
  const ids = pageIds(visibleNav(admin(['whatsapp'], true), 'home'));
  for (const id of ['whatsapp', 'units', 'access', 'security', 'previews']) assert.ok(ids.includes(id), `${id} missing`);
  assert.ok(!pageIds(visibleNav(admin(['whatsapp'], false), 'home')).includes('access'));
});

test('Usage lives in Settings and follows its module, not super-admin status', () => {
  assert.ok(pageIds(visibleNav(admin(['usage']), 'home')).includes('usage'));
  assert.equal(blockOfPage('usage'), 'settings');
});

test('the page you are on is always shown, even without a role in it, so the pane never drops you', () => {
  const nav = visibleNav(admin([]), 'finance-parties');
  assert.deepEqual(pageIds(nav), ['finance-parties']);
  assert.equal(nav[0].pages[0].current, true);
});

test('signed out (no answer yet): only the current page, nothing else', () => {
  assert.deepEqual(pageIds(visibleNav(null, 'members')), ['members']);
});

test('the block link goes to the first page the person can open', () => {
  const nav = visibleNav(admin(['finance-requests', 'event-payments']), 'home');
  const finance = nav.find((b) => b.id === 'finance');
  assert.equal(firstPage(finance).id, 'finance-requests');
});

test('the current page is flagged on exactly one page, and its block on exactly one block', () => {
  const nav = visibleNav(admin(['finance', 'members']), 'finance-import');
  assert.equal(nav.flatMap((b) => b.pages).filter((p) => p.current).length, 1);
  assert.deepEqual(nav.filter((b) => b.current).map((b) => b.id), ['finance']);
});
