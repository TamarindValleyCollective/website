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
  resendAutomaticIsFresh,
  r2AutomaticIsFresh,
  nextCollectorRun,
  decideNotifications,
  sumDaily,
  addDays,
  daysUntilDate,
  MANUAL_METERS,
  projectDbGrowth,
  typesafeCreditEstimate,
  netlifyDeployUsage,
  alertAction,
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

// A reading every 6 hours for `days` days ending at NOW, growing `mbPerDay` from `startMb`.
const MB = 1024 * 1024;
const sizeHistory = (days, startMb, mbPerDay) =>
  Array.from({ length: days * 4 + 1 }, (_, i) => ({
    captured_at: new Date(NOW.getTime() - (days * 4 - i) * 6 * 3600_000).toISOString(),
    value: (startMb + (i / 4) * mbPerDay) * MB,
  }));
const LIMIT = 500 * MB;

test('projectDbGrowth: reads the pace and the days left from a steady climb', () => {
  const g = projectDbGrowth(sizeHistory(10, 100, 2), LIMIT, NOW); // 2 MB/day, ends at 120 MB
  assert.ok(Math.abs(g.bytesPerDay / MB - 2) < 0.01);
  assert.ok(Math.abs(g.daysToFull - 190) < 1); // (500 - 120) / 2
  assert.ok(g.spanDays >= 9.9);
});

test('projectDbGrowth: flat or shrinking has no days-to-full', () => {
  assert.equal(projectDbGrowth(sizeHistory(10, 100, 0), LIMIT, NOW).daysToFull, null);
  assert.equal(projectDbGrowth(sizeHistory(10, 100, -1), LIMIT, NOW).daysToFull, null);
});

test('projectDbGrowth: too little history says nothing, rather than guessing', () => {
  assert.equal(projectDbGrowth([], LIMIT, NOW), null);
  assert.equal(projectDbGrowth(sizeHistory(3, 100, 5), LIMIT, NOW), null); // under 5 days
  assert.equal(projectDbGrowth(sizeHistory(10, 100, 2).slice(0, 5), LIMIT, NOW), null); // under 8 readings
  assert.equal(projectDbGrowth(sizeHistory(10, 100, 2), 0, NOW), null); // no limit to measure against
});

test('projectDbGrowth: only the last two weeks count, and junk readings are ignored', () => {
  // 10 MB readings from 15-30 days ago: if the window let them in, the climb to 100 MB would look huge
  const old = sizeHistory(30, 10, 0)
    .filter((p) => new Date(p.captured_at).getTime() < NOW.getTime() - 15 * 24 * 3600_000)
    .map((p) => ({ ...p, value: 10 * MB }));
  assert.ok(old.length > 8);
  const recent = sizeHistory(10, 100, 2);
  const g = projectDbGrowth([...old, ...recent, { captured_at: 'not a date', value: 1 }, { captured_at: recent[0].captured_at, value: 'x' }], LIMIT, NOW);
  assert.ok(Math.abs(g.bytesPerDay / MB - 2) < 0.2);
});

test('evaluateAlerts: database growth warns inside 60 days to full, critical inside 21, quiet beyond', () => {
  const snapshots = { 'supabase.db_size_bytes': { value: 120 * MB, limit_value: LIMIT, captured_at: '2026-10-10T06:00:00Z' } };
  const keys = (history) => evaluateAlerts({ now: NOW, snapshots, dbHistory: history }).filter((a) => a.key === 'supabase:db-growth');
  // 120 MB now: 380 MB left. 5 MB/day -> 76 days (quiet); 8 MB/day -> 47 days (warn); 20 MB/day -> 19 days (critical)
  assert.equal(keys(sizeHistory(10, 70, 5)).length, 0);
  assert.equal(keys(sizeHistory(10, 40, 8))[0].level, 'warn');
  assert.equal(keys(sizeHistory(10, -80, 20))[0].level, 'critical');
  assert.equal(keys([]).length, 0); // no history: no growth alert
});

test('evaluateAlerts: no growth alert once the database is already at the limit (the size alert covers it), and "1 day" is singular', () => {
  const full = { 'supabase.db_size_bytes': { value: 505 * MB, limit_value: LIMIT, captured_at: '2026-10-10T06:00:00Z' } };
  const keys = evaluateAlerts({ now: NOW, snapshots: full, dbHistory: sizeHistory(10, 400, 10) }).map((a) => a.key);
  assert.deepEqual(keys, ['supabase:db-size']);

  // 499 MB with 10 MB/day -> about a tenth of a day left: reads as "1 day", not "1 days"
  const nearly = { 'supabase.db_size_bytes': { value: 499 * MB, limit_value: LIMIT, captured_at: '2026-10-10T06:00:00Z' } };
  const growth = evaluateAlerts({ now: NOW, snapshots: nearly, dbHistory: sizeHistory(10, 399, 10) }).find((a) => a.key === 'supabase:db-growth');
  assert.match(growth.title, /about 1 day$/);
  assert.match(growth.detail, /roughly 1 day\./);
});

test('the Supabase egress balance is a typed-in "used" meter that warns near its limit', () => {
  assert.equal(MANUAL_METERS['supabase.egress_gb'].kind, 'used');
  const snapshots = { 'supabase.egress_gb': { value: 4, limit_value: 5, captured_at: '2026-10-09T00:00:00Z' } };
  const alerts = evaluateAlerts({ now: NOW, snapshots });
  assert.equal(alerts[0].key, 'manual:supabase.egress_gb');
  assert.equal(alerts[0].level, 'warn'); // 80%
});

test('evaluateAlerts: TypeSafe errors alert only when many AND a large share of today\'s calls failed', () => {
  const key = (daily) => evaluateAlerts({ now: NOW, daily }).map((a) => a.key);
  assert.deepEqual(key([row('2026-10-10', 'typesafe', 'requests', 20), row('2026-10-10', 'typesafe', 'errors', 8)]), ['typesafe:errors']);
  assert.deepEqual(key([row('2026-10-10', 'typesafe', 'requests', 100), row('2026-10-10', 'typesafe', 'errors', 8)]), []); // 8%: noise
  assert.deepEqual(key([row('2026-10-10', 'typesafe', 'requests', 4), row('2026-10-10', 'typesafe', 'errors', 4)]), []); // too few to mean anything
  assert.deepEqual(key([row('2026-10-09', 'typesafe', 'requests', 20), row('2026-10-09', 'typesafe', 'errors', 20)]), []); // yesterday
});

test('the TypeSafe credit balance is typed in once, and the website\'s own metered spend comes off it', () => {
  assert.equal(MANUAL_METERS['typesafe.credit_remaining_usd'].kind, 'remaining');
  const reading = { value: 5, limit_value: 5, captured_at: '2026-10-09T08:00:00Z' };

  // 50M input tokens at $0.042 per million = $2.10, counted from the reading's own day
  const half = typesafeCreditEstimate(reading, [row('2026-10-09', 'typesafe', 'input_tokens', 20_000_000), row('2026-10-10', 'typesafe', 'input_tokens', 30_000_000)], NOW);
  assert.ok(Math.abs(half.spent - 2.1) < 1e-9);
  assert.ok(Math.abs(half.remaining - 2.9) < 1e-9);
  assert.equal(half.level, null); // 58% left

  // usage from before the reading is already in the typed-in number; it must not come off again
  const before = typesafeCreditEstimate(reading, [row('2026-10-08', 'typesafe', 'input_tokens', 90_000_000)], NOW);
  assert.equal(before.spent, 0);

  // never negative, and nothing to estimate without a reading
  assert.equal(typesafeCreditEstimate(reading, [row('2026-10-10', 'typesafe', 'input_tokens', 500_000_000)], NOW).remaining, 0);
  assert.equal(typesafeCreditEstimate(null, [], NOW), null);
});

test('evaluateAlerts: TypeSafe credit levels from the estimate (and no duplicate generic alert)', () => {
  const snapshots = { 'typesafe.credit_remaining_usd': { value: 5, limit_value: 5, captured_at: '2026-10-09T08:00:00Z' } };
  const run = (tokens) => evaluateAlerts({ now: NOW, snapshots, daily: [row('2026-10-10', 'typesafe', 'input_tokens', tokens)] });
  assert.equal(run(90_000_000).find((a) => a.key === 'typesafe:credit').level, 'warn'); // $3.78 spent, $1.22 left = 24%
  assert.equal(run(115_000_000).find((a) => a.key === 'typesafe:credit').level, 'critical'); // $4.83 spent, $0.17 left = 3%
  assert.equal(run(115_000_000).filter((a) => a.key.startsWith('manual:typesafe')).length, 0);
});

// ---- Netlify: what production deploys have cost this cycle ----
const CYCLE_START = '2026-10-19T00:00:00.000-07:00';
const CYCLE_END = '2026-11-19T00:00:00.000-08:00';
const NF_NOW = new Date('2026-10-22T12:00:00Z'); // 3.2 days into a 31-day cycle
const plan = { value: 1000, limit_value: 1000, captured_at: '2026-10-22T11:00:00Z', detail: { period_start: CYCLE_START, next_period_start: CYCLE_END } };
const activity = (deploys, periodStart = CYCLE_START) => ({ value: deploys * 15, limit_value: null, captured_at: '2026-10-22T11:00:00Z', detail: { period_start: periodStart, production_ok: deploys } });

test('netlifyDeployUsage: 15 credits a deploy, against the allowance, with a projection to the cycle end', () => {
  const u = netlifyDeployUsage(activity(33), plan, NF_NOW);
  assert.equal(u.credits, 495);
  assert.equal(u.deploys, 33);
  assert.ok(Math.abs(u.fraction - 0.495) < 1e-9);
  assert.equal(u.level, null); // under 70%
  assert.ok(u.elapsedDays > 3 && u.elapsedDays < 3.5);
  assert.ok(u.projected > 4000 && u.projected < 5500); // 495 over ~3.2 days, scaled to 31
  assert.equal(u.onPaceToExceed, true);
});

test('netlifyDeployUsage: no projection in the first days, and none from an earlier cycle', () => {
  const early = netlifyDeployUsage(activity(10), plan, new Date('2026-10-20T12:00:00Z'));
  assert.equal(early.projected, null);
  assert.equal(early.onPaceToExceed, false);
  assert.equal(netlifyDeployUsage(activity(33, '2026-09-19T00:00:00.000-07:00'), plan, NF_NOW), null); // last cycle's count
  assert.equal(netlifyDeployUsage(null, plan, NF_NOW), null);
  assert.equal(netlifyDeployUsage(activity(33), null, NF_NOW), null);
});

test('netlifyDeployUsage: names the day the allowance would run out at this pace, only when it would', () => {
  const u = netlifyDeployUsage(activity(33), plan, NF_NOW); // 495 credits in about 3.2 days, 1,000 included
  const day = u.exhaustsAt.slice(0, 10);
  assert.ok(day >= '2026-10-25' && day <= '2026-10-27', day); // about 3.3 more days at ~154 credits a day
  assert.equal(netlifyDeployUsage(activity(2), plan, NF_NOW).exhaustsAt, null); // 30 credits: nowhere near
  assert.equal(netlifyDeployUsage(activity(10), plan, new Date('2026-10-20T12:00:00Z')).exhaustsAt, null); // too early to project
  assert.match(evaluateAlerts({ now: NF_NOW, snapshots: { 'netlify.plan_credits': plan, 'netlify.deploy_activity': activity(33) } })[0].title, /^Netlify credits are on pace to run out around 2[567] Oct$/);
});

test('every alert says what to do, in words a non-technical reader can act on', () => {
  // a page that is on fire everywhere, so every rule that can speak does
  const snapshots = {
    'supabase.db_size_bytes': { value: 480 * MB, limit_value: LIMIT, captured_at: '2026-10-10T06:00:00Z' },
    'supabase.db_connections': { value: 58, limit_value: 60, captured_at: '2026-10-10T06:00:00Z' },
    'supabase.egress_gb': { value: 4.8, limit_value: 5, captured_at: '2026-10-09T00:00:00Z' },
    'anthropic.credit_remaining_usd': { value: 1, limit_value: 50, captured_at: '2026-10-09T00:00:00Z', detail: { expires_on: '2026-10-12' } },
    'typesafe.credit_remaining_usd': { value: 0.2, limit_value: 5, captured_at: '2026-10-09T00:00:00Z' },
    'netlify.plan_credits': { value: 1000, limit_value: 1000, captured_at: '2026-10-10T00:00:00Z', detail: { period_start: '2026-10-01T00:00:00.000Z', next_period_start: '2026-11-01T00:00:00.000Z' } },
    'netlify.deploy_activity': { value: 960, limit_value: null, captured_at: '2026-10-10T00:00:00Z', detail: { period_start: '2026-10-01T00:00:00.000Z', production_ok: 64 } },
    'netlify.credits_remaining': { value: 50, limit_value: 1000, captured_at: '2026-10-09T00:00:00Z' },
    'cloudflare.r2_storage_gb': { value: 9.5, limit_value: 10, captured_at: '2026-10-09T00:00:00Z' },
  };
  const daily = [
    row('2026-10-10', 'anthropic', 'billing_errors', 3), row('2026-10-10', 'anthropic', 'chat_cap_hits', 2), row('2026-10-10', 'anthropic', 'search_fallback_cap_hits', 2),
    row('2026-10-10', 'gemini', 'quota_exhausted', 4), row('2026-10-10', 'typesafe', 'requests', 20), row('2026-10-10', 'typesafe', 'errors', 9),
  ];
  const alerts = evaluateAlerts({ now: NOW, snapshots, daily, settings: { anthropic_prices: { input: 3, output: 15 } }, dbHistory: sizeHistory(10, 400, 8) });
  assert.ok(alerts.length >= 8, `expected many alerts, got ${alerts.map((a) => a.key)}`);
  for (const a of alerts) {
    assert.ok(typeof a.action === 'string' && a.action.length > 30, `no guidance for ${a.key}`);
    assert.ok(!/[{}]|undefined|NaN/.test(a.action), `bad guidance text for ${a.key}`);
  }
  assert.equal(alertAction('manual:some.future_meter').length > 30, true); // new typed-in meters get the generic advice
  assert.equal(alertAction('not:a-real-alert'), null);
});

test('evaluateAlerts: deploy credits warn at 70% / critical at 90%; a pace warning only while still under 70%', () => {
  const run = (deploys, now = NF_NOW) => evaluateAlerts({ now, snapshots: { 'netlify.plan_credits': plan, 'netlify.deploy_activity': activity(deploys) } });
  const keys = (deploys) => run(deploys).map((a) => `${a.key}:${a.level}`);
  assert.deepEqual(keys(33), ['netlify:deploy-pace:warn']); // 495 credits: under 70%, but on pace to blow past 1,000
  assert.deepEqual(keys(50), ['netlify:deploys:warn']); // 750 credits = 75%; the level alert covers it, no extra pace warning
  assert.deepEqual(keys(62), ['netlify:deploys:critical']); // 930 credits = 93%
  assert.deepEqual(keys(2), []); // 30 credits, tiny pace: quiet
  assert.match(run(50).find((a) => a.key === 'netlify:deploys').detail, /50 production deploys at 15 credits each is 750 of 1,000/);
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
    'resend.emails_used': { value: 2400, limit_value: 3000, captured_at: '2026-10-09T00:00:00Z' },
    'anthropic.credit_remaining_usd': { value: 1, limit_value: 50, captured_at: '2026-10-09T00:00:00Z' },
  };
  const alerts = evaluateAlerts({ now: NOW, snapshots, settings: {} });
  assert.deepEqual(alerts.map((a) => a.key), ['manual:resend.emails_used']);
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
const leftSnap = (captured_at, limit_value = 300) => ({ value: 200, limit_value, unit: 'credits', captured_at, detail: { source: 'manual' } });

test('mergeNetlifyPlan: the allowance read from Netlify replaces the typed limit', () => {
  const out = mergeNetlifyPlan({ 'netlify.plan_credits': planSnap, 'netlify.credits_remaining': leftSnap('2026-10-04T11:41:00Z') });
  assert.equal(out['netlify.credits_remaining'].limit_value, 1000);
  assert.equal(out['netlify.credits_remaining'].detail.stale_for_cycle, false);
  assert.equal(out['netlify.credits_remaining'].detail.cycle_end, '2026-10-19T00:00:00.000-07:00');
});

test('mergeNetlifyPlan: a reading from before the cycle began is stale, and does not alert', () => {
  const snapshots = { 'netlify.plan_credits': planSnap, 'netlify.credits_remaining': leftSnap('2026-09-10T00:00:00Z') };
  assert.equal(mergeNetlifyPlan(snapshots)['netlify.credits_remaining'].detail.stale_for_cycle, true);
  assert.equal(evaluateAlerts({ now: NOW, snapshots }).some((a) => a.key === 'manual:netlify.credits_remaining'), false);
});

test('mergeNetlifyPlan: no plan snapshot leaves the typed reading untouched', () => {
  const snapshots = { 'netlify.credits_remaining': leftSnap('2026-10-04T11:41:00Z') };
  assert.equal(mergeNetlifyPlan(snapshots), snapshots);
});

test('Netlify plan data older than 2 days warns once; fresh or never-recorded does not', () => {
  const old = { ...planSnap, captured_at: '2026-10-05T00:00:00Z' }; // 5 days before NOW
  const has = (snapshots) => evaluateAlerts({ now: NOW, snapshots }).some((a) => a.key === 'netlify:plan-stale');
  assert.equal(has({ 'netlify.plan_credits': old }), true);
  assert.equal(has({ 'netlify.plan_credits': planSnap }), false);
  assert.equal(has({}), false);
  const merged = mergeNetlifyPlan({ 'netlify.plan_credits': old, 'netlify.credits_remaining': leftSnap('2026-10-04T11:41:00Z') }, NOW);
  assert.equal(merged['netlify.credits_remaining'].detail.plan_stale, true);
});

test('Netlify credits remaining: warns at 30% / critical at 10% left, nothing above, silent when stale', () => {
  const at = (value, captured_at = '2026-10-10T00:00:00Z') => evaluateAlerts({ now: NOW, snapshots: { 'netlify.plan_credits': planSnap, 'netlify.credits_remaining': { ...leftSnap(captured_at), value } } }).find((a) => a.key === 'manual:netlify.credits_remaining');
  assert.equal(at(403), undefined);
  assert.equal(at(300).level, 'warn');
  assert.equal(at(100).level, 'critical');
  assert.equal(at(50, '2026-09-10T00:00:00Z'), undefined);
});

const resendSnap = (value, limit, captured_at = '2026-10-10T06:00:00Z') => ({ value, limit_value: limit, unit: 'emails', captured_at, detail: { source: 'resend-api' } });

test('Resend API readings alert at 70% / 90% of either quota, and supersede the typed-in meter', () => {
  const snapshots = {
    'resend.emails_monthly': resendSnap(2400, 3000), // 80%
    'resend.emails_daily': resendSnap(95, 100), // 95%
    'resend.emails_used': { value: 3000, limit_value: 3000, captured_at: '2026-10-01T00:00:00Z' }, // typed-in: would be critical
  };
  const alerts = evaluateAlerts({ now: NOW, snapshots });
  assert.equal(alerts.find((a) => a.key === 'resend:monthly').level, 'warn');
  assert.equal(alerts.find((a) => a.key === 'resend:daily').level, 'critical');
  assert.equal(alerts.some((a) => a.key === 'manual:resend.emails_used'), false);
});

test('Resend API readings that stop refreshing warn once, and the typed-in meter takes over again', () => {
  const stale = resendSnap(10, 3000, '2026-10-05T00:00:00Z');
  const snapshots = { 'resend.emails_monthly': stale, 'resend.emails_used': { value: 2700, limit_value: 3000, captured_at: '2026-10-09T00:00:00Z' } };
  assert.equal(resendAutomaticIsFresh(snapshots, NOW), false);
  const keys = evaluateAlerts({ now: NOW, snapshots }).map((a) => a.key);
  assert.ok(keys.includes('resend:stale'));
  assert.ok(keys.includes('manual:resend.emails_used'));
  assert.equal(keys.includes('resend:monthly'), false);
});

test('Resend: no API readings ever recorded means no Resend API alerts', () => {
  const keys = evaluateAlerts({ now: NOW, snapshots: {} }).map((a) => a.key);
  assert.equal(keys.some((k) => k.startsWith('resend:')), false);
});

const r2Snap = (bytes, captured_at = '2026-10-10T06:00:00Z') => ({ value: bytes, limit_value: 10_000_000_000, unit: 'bytes', captured_at, detail: { source: 'cloudflare-graphql', buckets: 1, objects: 120 } });

test('R2 API reading alerts at 70% / 90%, supersedes the typed-in meter, quiet below', () => {
  const at = (bytes) => evaluateAlerts({ now: NOW, snapshots: { 'cloudflare.r2_storage_bytes': r2Snap(bytes), 'cloudflare.r2_storage_gb': { value: 10, limit_value: 10, captured_at: '2026-10-01T00:00:00Z' } } });
  assert.equal(at(1e9).length, 0); // 10%, and the typed-in 100% is superseded
  assert.equal(at(7.5e9).find((a) => a.key === 'cloudflare:r2-storage').level, 'warn');
  assert.equal(at(9.5e9).find((a) => a.key === 'cloudflare:r2-storage').level, 'critical');
});

test('R2 readings that stop refreshing warn once and hand back to the typed-in meter; none ever recorded is silent', () => {
  const stale = r2Snap(1e9, '2026-10-05T00:00:00Z');
  const snapshots = { 'cloudflare.r2_storage_bytes': stale, 'cloudflare.r2_storage_gb': { value: 9.5, limit_value: 10, captured_at: '2026-10-09T00:00:00Z' } };
  assert.equal(r2AutomaticIsFresh(snapshots, NOW), false);
  const keys = evaluateAlerts({ now: NOW, snapshots }).map((a) => a.key);
  assert.ok(keys.includes('cloudflare:r2-stale'));
  assert.ok(keys.includes('manual:cloudflare.r2_storage_gb'));
  assert.equal(evaluateAlerts({ now: NOW, snapshots: {} }).some((a) => a.key.startsWith('cloudflare:')), false);
});

test('nextCollectorRun: the next 6-hourly UTC slot strictly after now', () => {
  assert.equal(nextCollectorRun(new Date('2026-10-10T13:20:00Z')).toISOString(), '2026-10-10T18:00:00.000Z');
  assert.equal(nextCollectorRun(new Date('2026-10-10T18:00:00Z')).toISOString(), '2026-10-11T00:00:00.000Z'); // exactly on a run: the following one
  assert.equal(nextCollectorRun(new Date('2026-10-10T23:59:59Z')).toISOString(), '2026-10-11T00:00:00.000Z');
});

test('Supabase connections: warn at 70% / critical at 90% of the limit, quiet below', () => {
  const at = (n) => evaluateAlerts({ now: NOW, snapshots: { 'supabase.db_connections': { value: n, limit_value: 60, captured_at: '2026-10-10T06:00:00Z' } } }).find((a) => a.key === 'supabase:connections');
  assert.equal(at(7), undefined);
  assert.equal(at(45).level, 'warn');
  assert.equal(at(55).level, 'critical');
});
