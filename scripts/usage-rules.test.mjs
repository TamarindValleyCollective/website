// Run with: node --test scripts/usage-rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  levelForUsed,
  levelForRemaining,
  estimateCostUsd,
  anthropicCreditEstimate,
  evaluateAlerts,
  mergeNetlifyPlan,
  decideNotifications,
  sumDaily,
  addDays,
  daysUntilDate,
} from './lib/usage-rules.mjs';

const NOW = new Date('2026-10-10T12:00:00Z');
const row = (day, service, metric, value) => ({ day, service, metric, value });
const prices = { input: 3, output: 15 }; // USD per million tokens (test numbers)

test('levelForUsed: 70% warns, 90% is critical, below is quiet, bad input is quiet', () => {
  assert.equal(levelForUsed(69, 100), null);
  assert.equal(levelForUsed(70, 100), 'warn');
  assert.equal(levelForUsed(89, 100), 'warn');
  assert.equal(levelForUsed(90, 100), 'critical');
  assert.equal(levelForUsed(150, 100), 'critical');
  assert.equal(levelForUsed(5, 0), null);
  assert.equal(levelForUsed(5, null), null);
  assert.equal(levelForUsed(NaN, 100), null);
});

test('levelForRemaining: 30% left warns, 10% left is critical', () => {
  assert.equal(levelForRemaining(31, 100), null);
  assert.equal(levelForRemaining(30, 100), 'warn');
  assert.equal(levelForRemaining(11, 100), 'warn');
  assert.equal(levelForRemaining(10, 100), 'critical');
  assert.equal(levelForRemaining(0, 100), 'critical');
  assert.equal(levelForRemaining(5, 0), null);
});

test('estimateCostUsd: needs both prices; cache reads cost 0.1x and writes 1.25x of input', () => {
  assert.equal(estimateCostUsd({ input_tokens: 1000 }, null), null);
  assert.equal(estimateCostUsd({ input_tokens: 1000 }, { input: 3 }), null);
  assert.equal(estimateCostUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, prices), 18);
  assert.ok(Math.abs(estimateCostUsd({ cache_read_tokens: 1_000_000 }, prices) - 0.3) < 1e-9);
  assert.ok(Math.abs(estimateCostUsd({ cache_write_tokens: 1_000_000 }, prices) - 3.75) < 1e-9);
  assert.equal(estimateCostUsd({}, prices), 0);
});

test('date helpers', () => {
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(daysUntilDate('2026-10-17', NOW), 7);
  assert.equal(daysUntilDate('2026-10-10', NOW), 0);
  assert.equal(daysUntilDate('2026-10-01', NOW), -9); // counts to the end of the expiry day
});

test('sumDaily only adds the matching service, metric and day range', () => {
  const daily = [row('2026-10-09', 'a', 'm', 2), row('2026-10-10', 'a', 'm', 3), row('2026-10-10', 'a', 'x', 9), row('2026-10-10', 'b', 'm', 9), row('2026-10-11', 'a', 'm', 9)];
  assert.equal(sumDaily(daily, 'a', 'm', '2026-10-09', '2026-10-10'), 5);
  assert.equal(sumDaily(daily, 'a', 'm', '2026-10-10', '2026-10-10'), 3);
  assert.equal(sumDaily([], 'a', 'm', '2026-10-01', '2026-10-31'), 0);
});

test('anthropicCreditEstimate subtracts metered spend from the reading day onwards', () => {
  const snapshot = { value: 10, limit_value: 50, captured_at: '2026-10-08T09:00:00Z' };
  const daily = [
    row('2026-10-07', 'anthropic', 'input_tokens', 99_000_000), // before the reading: ignored
    row('2026-10-08', 'anthropic', 'input_tokens', 1_000_000), // $3
    row('2026-10-09', 'anthropic', 'output_tokens', 200_000), // $3
  ];
  const e = anthropicCreditEstimate(snapshot, daily, prices, NOW);
  assert.ok(Math.abs(e.spent - 6) < 1e-9);
  assert.ok(Math.abs(e.remaining - 4) < 1e-9);
  assert.equal(e.total, 50);
  assert.equal(e.level, 'critical'); // 4/50 = 8% left
});

test('anthropicCreditEstimate: null without a reading or prices, never goes negative', () => {
  const snapshot = { value: 1, limit_value: 50, captured_at: '2026-10-08T09:00:00Z' };
  assert.equal(anthropicCreditEstimate(null, [], prices, NOW), null);
  assert.equal(anthropicCreditEstimate(snapshot, [], null, NOW), null);
  const big = [row('2026-10-09', 'anthropic', 'input_tokens', 50_000_000)];
  assert.equal(anthropicCreditEstimate(snapshot, big, prices, NOW).remaining, 0);
});

test('evaluateAlerts: quiet when nothing is wrong', () => {
  assert.deepEqual(evaluateAlerts({ now: NOW, daily: [row('2026-10-10', 'anthropic', 'requests', 40)], snapshots: {}, settings: {} }), []);
});

test('evaluateAlerts: billing errors today or yesterday are critical, older are not', () => {
  const today = evaluateAlerts({ now: NOW, daily: [row('2026-10-10', 'anthropic', 'billing_errors', 2)] });
  assert.equal(today.length, 1);
  assert.equal(today[0].key, 'anthropic:billing');
  assert.equal(today[0].level, 'critical');
  assert.equal(evaluateAlerts({ now: NOW, daily: [row('2026-10-09', 'anthropic', 'billing_errors', 1)] }).length, 1);
  assert.equal(evaluateAlerts({ now: NOW, daily: [row('2026-10-08', 'anthropic', 'billing_errors', 1)] }).length, 0);
});

test('evaluateAlerts: low estimated credit and an expiry date', () => {
  const snapshots = { 'anthropic.credit_remaining_usd': { value: 12, limit_value: 50, captured_at: '2026-10-09T00:00:00Z', detail: { expires_on: '2026-10-25' } } };
  const daily = [row('2026-10-09', 'anthropic', 'input_tokens', 1_000_000)]; // $3 -> $9 left = 18%
  const alerts = evaluateAlerts({ now: NOW, daily, snapshots, settings: { anthropic_prices: prices } });
  const byKey = Object.fromEntries(alerts.map((a) => [a.key, a]));
  assert.equal(byKey['anthropic:credit'].level, 'warn');
  assert.equal(byKey['anthropic:expiry'].level, 'warn'); // 15 days left: warn from 30, critical from 7
});

test('evaluateAlerts: expiry within 7 days is critical, beyond 30 is quiet', () => {
  const mk = (expires_on) => ({ 'anthropic.credit_remaining_usd': { value: 50, limit_value: 50, captured_at: '2026-10-09T00:00:00Z', detail: { expires_on } } });
  assert.equal(evaluateAlerts({ now: NOW, snapshots: mk('2026-10-15') })[0].level, 'critical');
  assert.equal(evaluateAlerts({ now: NOW, snapshots: mk('2026-10-30') })[0].level, 'warn');
  assert.equal(evaluateAlerts({ now: NOW, snapshots: mk('2026-12-30') }).length, 0);
  assert.match(evaluateAlerts({ now: NOW, snapshots: mk('2026-10-01') })[0].title, /expired/);
});

test('evaluateAlerts: no credit estimate alert without prices', () => {
  const snapshots = { 'anthropic.credit_remaining_usd': { value: 1, limit_value: 50, captured_at: '2026-10-09T00:00:00Z' } };
  assert.equal(evaluateAlerts({ now: NOW, snapshots, settings: {} }).length, 0);
});

test('evaluateAlerts: Gemini quota exhaustion today, and the optional daily limit', () => {
  const quota = evaluateAlerts({ now: NOW, daily: [row('2026-10-10', 'gemini', 'quota_exhausted', 3)] });
  assert.equal(quota[0].key, 'gemini:quota');
  assert.equal(evaluateAlerts({ now: NOW, daily: [row('2026-10-09', 'gemini', 'quota_exhausted', 3)] }).length, 0);

  const daily = [row('2026-10-10', 'gemini', 'requests', 80)];
  assert.equal(evaluateAlerts({ now: NOW, daily, settings: { gemini_daily_requests: 100 } })[0].level, 'warn');
  assert.equal(evaluateAlerts({ now: NOW, daily: [row('2026-10-10', 'gemini', 'requests', 95)], settings: { gemini_daily_requests: 100 } })[0].level, 'critical');
  assert.equal(evaluateAlerts({ now: NOW, daily, settings: {} }).length, 0); // no limit set: stay quiet
});

test('evaluateAlerts: our own caps being hit', () => {
  const keys = evaluateAlerts({
    now: NOW,
    daily: [row('2026-10-10', 'anthropic', 'chat_cap_hits', 4), row('2026-10-10', 'anthropic', 'search_fallback_cap_hits', 1)],
  }).map((a) => a.key);
  assert.deepEqual(keys.sort(), ['site:chat-cap', 'site:search-cap']);
});

test('evaluateAlerts: Supabase size uses the limit stored with the snapshot', () => {
  const mb = 1024 * 1024;
  const at = (used) => ({ 'supabase.db_size_bytes': { value: used * mb, limit_value: 500 * mb, captured_at: '2026-10-10T06:00:00Z' } });
  assert.equal(evaluateAlerts({ now: NOW, snapshots: at(12) }).length, 0);
  assert.equal(evaluateAlerts({ now: NOW, snapshots: at(360) })[0].level, 'warn');
  assert.equal(evaluateAlerts({ now: NOW, snapshots: at(460) })[0].level, 'critical');
});

test('evaluateAlerts: typed-in used-meters alert on their own limit; remaining-kind ones are handled elsewhere', () => {
  const snapshots = {
    'netlify.credits_used': { value: 240, limit_value: 300, captured_at: '2026-10-09T00:00:00Z' },
    'resend.emails_used': { value: 10, limit_value: 3000, captured_at: '2026-10-09T00:00:00Z' },
    'anthropic.credit_remaining_usd': { value: 1, limit_value: 50, captured_at: '2026-10-09T00:00:00Z' },
  };
  const alerts = evaluateAlerts({ now: NOW, snapshots, settings: {} });
  assert.deepEqual(alerts.map((a) => a.key), ['manual:netlify.credits_used']);
  assert.equal(alerts[0].level, 'warn'); // 80%
});

test('decideNotifications: new alerts send, repeats do not, worsening sends, recovery clears', () => {
  const warn = { key: 'k1', level: 'warn', title: 't', detail: 'd' };
  const crit = { ...warn, level: 'critical' };

  let d = decideNotifications([warn], []);
  assert.equal(d.toSend.length, 1);
  assert.deepEqual(d.upsert, [{ alert_key: 'k1', level: 'warn' }]);

  d = decideNotifications([warn], [{ alert_key: 'k1', level: 'warn' }]);
  assert.equal(d.toSend.length, 0, 'same level again is not re-sent');

  d = decideNotifications([crit], [{ alert_key: 'k1', level: 'warn' }]);
  assert.equal(d.toSend.length, 1, 'worse level is sent');

  d = decideNotifications([warn], [{ alert_key: 'k1', level: 'critical' }]);
  assert.equal(d.toSend.length, 0, 'better level is quiet');
  assert.deepEqual(d.upsert, [{ alert_key: 'k1', level: 'warn' }], 'but remembered, so a later rise re-sends');

  d = decideNotifications([], [{ alert_key: 'k1', level: 'warn' }, { alert_key: 'k2', level: 'critical' }]);
  assert.deepEqual(d.clear.sort(), ['k1', 'k2']);
  assert.equal(d.toSend.length, 0);
});

const planSnap = { value: 1000, limit_value: 1000, unit: 'credits', captured_at: '2026-10-10T00:00:00Z', detail: { period_start: '2026-09-19T00:00:00.000-07:00', next_period_start: '2026-10-19T00:00:00.000-07:00' } };
const usedSnap = (captured_at, limit_value = 300) => ({ value: 800, limit_value, unit: 'credits', captured_at, detail: { source: 'manual' } });

test('mergeNetlifyPlan: the allowance read from Netlify replaces the typed limit', () => {
  const out = mergeNetlifyPlan({ 'netlify.plan_credits': planSnap, 'netlify.credits_used': usedSnap('2026-10-04T11:41:00Z') });
  assert.equal(out['netlify.credits_used'].limit_value, 1000);
  assert.equal(out['netlify.credits_used'].detail.stale_for_cycle, false);
  assert.equal(out['netlify.credits_used'].detail.cycle_end, '2026-10-19T00:00:00.000-07:00');
});

test('mergeNetlifyPlan: a reading from before the cycle began is stale, and does not alert', () => {
  const snapshots = { 'netlify.plan_credits': planSnap, 'netlify.credits_used': usedSnap('2026-09-10T00:00:00Z') };
  assert.equal(mergeNetlifyPlan(snapshots)['netlify.credits_used'].detail.stale_for_cycle, true);
  assert.equal(evaluateAlerts({ now: NOW, snapshots }).some((a) => a.key === 'manual:netlify.credits_used'), false);
});

test('mergeNetlifyPlan: no plan snapshot leaves the typed reading untouched', () => {
  const snapshots = { 'netlify.credits_used': usedSnap('2026-10-04T11:41:00Z') };
  assert.equal(mergeNetlifyPlan(snapshots), snapshots);
});

test('Netlify plan data older than 2 days warns once; fresh or never-recorded does not', () => {
  const old = { ...planSnap, captured_at: '2026-10-05T00:00:00Z' }; // 5 days before NOW
  const has = (snapshots) => evaluateAlerts({ now: NOW, snapshots }).some((a) => a.key === 'netlify:plan-stale');
  assert.equal(has({ 'netlify.plan_credits': old }), true);
  assert.equal(has({ 'netlify.plan_credits': planSnap }), false);
  assert.equal(has({}), false);
  const merged = mergeNetlifyPlan({ 'netlify.plan_credits': old, 'netlify.credits_used': usedSnap('2026-10-04T11:41:00Z') }, NOW);
  assert.equal(merged['netlify.credits_used'].detail.plan_stale, true);
});
