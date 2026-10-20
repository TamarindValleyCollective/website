// Run with: node --test scripts/lib/member-story-seed.test.mjs
// The SQL itself (matching cards to people) is checked against a real Postgres with the real
// migrations when it changes; see docs/plans/member-portal.md, "Seeding the cards".
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedSql, cardTokens, normalizeOverrides, seedCards } from './member-story-seed.mjs';
import { members } from '../../src/data/members.ts';

test('card names become lower-case name tokens, first names or full names', () => {
  assert.deepEqual(cardTokens('Sree & Prameela'), ['sree', 'prameela']);
  assert.deepEqual(cardTokens('Amit Gupta'), ['amit gupta']);
  assert.deepEqual(cardTokens('Shalini & Amit Jain'), ['shalini', 'amit jain']);
  assert.deepEqual(cardTokens('  Roopa   PN '), ['roopa pn']);
});

test('only cards with something to say are seeded; an empty card is left alone', () => {
  const cards = seedCards([
    { name: 'Empty One', bio: '', photo: null },
    { name: 'A & B', bio: 'A is a baker.', family: '', whyTVC: 'Soil.' },
    { name: 'C', bio: '', family: 'Two kids.' },
    { name: 'D', bio: ' ', whyTVC: ['one', 'two'], social: ['https://x.test/d1', 'https://x.test/d2'] },
  ]);
  assert.deepEqual(cards.map((c) => c.cardName), ['A & B', 'C', 'D']);
  assert.deepEqual(cards[0].whys, ['Soil.']);
  assert.deepEqual(cards[2].whys, ['one', 'two']);
  assert.deepEqual(cards[2].socials, ['https://x.test/d1', 'https://x.test/d2']);
});

test('the real cards: the ones with text are seeded, the rest are just names', () => {
  const cards = seedCards(members);
  assert.ok(cards.length > 30 && cards.length < members.length);
  assert.ok(cards.every((c) => c.bio || c.family || c.whys.length));
  assert.ok(cards.every((c) => c.tokens.length >= 1));
});

test('each card keeps its own photos: one each when they sent their own, else the shared one; only public-site paths count', () => {
  const cards = seedCards([
    { name: 'A & B', bio: 'x', photo: '/images/members/a-and-b.jpg' },
    { name: 'C & D', bio: 'x', photo: '/images/members/c.jpg', photos: ['/images/members/c1.jpg', '/images/members/d1.jpg'] },
    { name: 'E', bio: 'x', photo: 'https://evil.test/e.jpg' },
    { name: 'F', bio: 'x', photo: null },
  ]);
  assert.deepEqual(cards.map((c) => c.photos), [['/images/members/a-and-b.jpg'], ['/images/members/c1.jpg', '/images/members/d1.jpg'], [], []]);
});

test('the photos script only adds a photo where there is none, and only the photo key', () => {
  const sql = buildSeedSql(seedCards([{ name: 'A & B', bio: 'x', photo: '/images/members/a-and-b.jpg' }]), { mode: 'photos' });
  assert.match(sql, /coalesce\(s\.approved->>'photo', ''\) = ''/);
  assert.match(sql, /s\.draft \|\| jsonb_build_object\('photo', ph\.photo\)/);
  assert.ok(!/insert into member_stories/i.test(sql));
  assert.match(sql, /\$seed\$\/images\/members\/a-and-b\.jpg\$seed\$/);
});

test('preview reads only and apply writes, and neither can be mixed up', () => {
  const cards = seedCards([{ name: 'A & B', bio: 'A is a baker.', whyTVC: 'Soil.' }]);
  const preview = buildSeedSql(cards, { mode: 'preview' });
  const apply = buildSeedSql(cards, { mode: 'apply' });
  assert.ok(!/insert into member_stories|insert into staff_audit_log/i.test(preview));
  assert.match(apply, /insert into member_stories/i);
  assert.match(apply, /on conflict \(person_id\) do nothing/i); // never overwrites a story
  assert.match(apply, /'approved', s\.story, true/); // already approved and published, like the cards
  assert.throws(() => buildSeedSql(cards, { mode: 'oops' }), /mode must be/);
});

test('diagnose reads only and shows plots and counts, not names', () => {
  const sql = buildSeedSql(seedCards([{ name: 'A & B', bio: 'x', whyTVC: 'y' }]), { mode: 'diagnose' });
  assert.ok(!/insert into member_stories|insert into staff_audit_log/i.test(sql));
  assert.match(sql, /plots_exact/);
  assert.ok(!/select[^;]*\bp\.full_name\b[^;]*from seed_cards/i.test(sql.split('-- DIAGNOSE')[1].replace(/\(select[\s\S]*?\)\s+as/g, '')));
});

test('card text that could break out of a quote is refused, and quotes in text are safe', () => {
  const ok = seedCards([{ name: 'A', bio: "It's \"fine\"; drop table x; --", whyTVC: 'x' }]);
  assert.match(buildSeedSql(ok, { mode: 'apply' }), /\$seed\$It's "fine"; drop table x; --\$seed\$/);
  const bad = seedCards([{ name: 'A', bio: 'evil $seed$ text', whyTVC: 'x' }]);
  assert.throws(() => buildSeedSql(bad, { mode: 'apply' }), /contains \$seed\$/);
});

test('overrides pin a card to a farm plot; the SQL names no person', () => {
  const cards = seedCards([{ name: 'A & B', bio: 'x', whyTVC: 'y' }]);
  const sql = buildSeedSql(cards, { mode: 'preview', overrides: { 'A & B': 'F-12' } });
  assert.match(sql, /insert into seed_overrides[\s\S]*\$seed\$A & B\$seed\$, \$seed\$F-12\$seed\$/);
  // matching happens in the database: the file has card text and farm plots, never register names
  assert.match(sql, /join member_people p/);
  assert.ok(!/@/.test(buildSeedSql(seedCards(members), { mode: 'apply' }).replace(/\$seed\$[^$]*\$seed\$/g, '')));
});

test('an override is a farm plot, or a plot plus how a name is spelled in the register', () => {
  const { plots, aliases } = normalizeOverrides({ 'A & B': 'F-12', 'C & D': { plot: 'F-03', names: { Om: ' OmShivaprakash ' } } });
  assert.deepEqual(plots, { 'A & B': 'F-12', 'C & D': 'F-03' });
  assert.deepEqual(aliases, { 'C & D': { om: 'omshivaprakash' } });
  assert.throws(() => normalizeOverrides({ x: 'F12' }), /farm plot/);
  assert.throws(() => normalizeOverrides({ x: { names: { a: 'b' } } }), /farm plot/);
});

test('an alias changes the name matched on, not the card', () => {
  const cards = seedCards([{ name: 'Om & Pavithra', bio: 'x', whyTVC: 'y' }]);
  const sql = buildSeedSql(cards, { mode: 'verify', overrides: { 'Om & Pavithra': { plot: 'F-77', names: { om: 'omshivaprakash' } } } });
  assert.match(sql, /array\[\$seed\$omshivaprakash\$seed\$, \$seed\$pavithra\$seed\$\]/);
  assert.match(sql, /\$seed\$Om & Pavithra\$seed\$/); // the card itself keeps its name
});

test('verify reads only, and says that it shows register names', () => {
  const sql = buildSeedSql(seedCards([{ name: 'A & B', bio: 'x', whyTVC: 'y' }]), { mode: 'verify' });
  assert.ok(!/insert into member_stories|insert into staff_audit_log/i.test(sql));
  assert.match(sql, /do not paste it anywhere/i);
});

test('the looser match applies only to pinned households, and never uses a person twice', () => {
  const sql = buildSeedSql(seedCards([{ name: 'A & B', bio: 'x', whyTVC: 'y' }]), { mode: 'preview' });
  assert.match(sql, /where r\.pinned and r\.household_id is not null/);
  assert.match(sql, /where r\.household_id is not null and not r\.pinned/);
  assert.match(sql, /count\(distinct person_id\) = 1/);
  assert.match(sql, /b\.person_id = a\.person_id\) = 1/);
});

test('a pinned card with one name and one primary member left over pairs them, nothing broader', () => {
  const sql = buildSeedSql(seedCards([{ name: 'A & B', bio: 'x', whyTVC: 'y' }]), { mode: 'preview' });
  assert.match(sql, /hm\.role = 'owner'/); // only primary members are candidates
  assert.match(sql, /having count\(distinct o\.pos\) = 1 and count\(distinct pp\.person_id\) = 1/);
  assert.match(sql, /where r\.pinned and r\.household_id is not null\s+and not exists \(select 1 from seed_core/);
});
