// Run with: node --test scripts/lib/member-publish.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPublished, buildPublishedUnits, publishedUnitPhotoHolder, cardNameFor, joinNames, mergePublished, photoFileFor, resolvePhotos, sanitizePublished, uploadedPhotos } from './member-publish.mjs';

const UP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const story = (bio, why = '', extra = {}) => ({ approved: { bio, family: '', why, social: '', photo: '', ...extra }, approved_public: true });
const base = () => ({
  households: [{ id: 'h1' }],
  people: [{ id: 'a', full_name: 'Sreedhar Testname' }, { id: 'b', full_name: 'Prameela Testname' }, { id: 'k', full_name: 'Kid Testname' }],
  memberships: [{ household_id: 'h1', person_id: 'a', role: 'owner' }, { household_id: 'h1', person_id: 'b', role: 'owner' }, { household_id: 'h1', person_id: 'k', role: 'family' }],
  stories: [],
  cards: [{ household_id: 'h1', card_name: 'Sree & Prameela', person_ids: ['a', 'b'] }],
});

test('names: first names for several primary members, the full name for one', () => {
  assert.equal(joinNames(['A', 'B', 'C']), 'A, B & C');
  assert.equal(cardNameFor(['Sreedhar P', 'Prameela J']), 'Sreedhar & Prameela');
  assert.equal(cardNameFor(['Amit Gupta']), 'Amit Gupta');
});

test('only an APPROVED story with the public switch on is published, under the 2017 card name', () => {
  const d = base();
  d.stories = [{ person_id: 'a', ...story('Sree is a director.', 'Retirement.') }, { person_id: 'b', approved: { bio: 'Pram designs.' }, approved_public: false }];
  const { cards, hidden } = buildPublished(d);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, 'Sree & Prameela'); // not "Sreedhar & Prameela"
  assert.equal(cards[0].bio, 'Sree is a director.'); // Prameela's is private, so it is not in the card
  assert.deepEqual(hidden, []);
  // a draft or an in-review copy is never read
  d.stories = [{ person_id: 'a', approved: null, approved_public: null, draft: { bio: 'secret' }, submitted: { bio: 'secret' } }];
  assert.deepEqual(buildPublished(d).cards, []);
});

test('the same bio on two people is one bio; different quotes and links pair with the names by position', () => {
  const d = base();
  d.stories = [
    { person_id: 'a', ...story('Shared text.', 'Retirement.', { social: 'https://x.test/a', photo: UP, family: 'One son.' }) },
    { person_id: 'b', ...story('Shared text.', 'Giving back.', { social: '', photo: '/images/members/p.jpg' }) },
  ];
  const [c] = buildPublished(d).cards;
  assert.equal(c.bio, 'Shared text.');
  assert.equal(c.family, 'One son.');
  assert.deepEqual(c.whyTVC, ['Retirement.', 'Giving back.']);
  assert.deepEqual(c.social, ['https://x.test/a']); // trailing empties dropped
  assert.deepEqual(c.photos, [UP, '/images/members/p.jpg']);
  assert.equal(c.photo, UP);
  assert.deepEqual(c.familyNames, ['Kid']); // the household's non-primary members, for the bold names in the text
  // one quote when everyone says the same, and a shared photo once
  d.stories = [{ person_id: 'a', ...story('x', 'Same.', { photo: UP }) }, { person_id: 'b', ...story('x', 'Same.', { photo: UP }) }];
  const [same] = buildPublished(d).cards;
  assert.equal(same.whyTVC, 'Same.');
  assert.equal(same.photo, UP);
  assert.equal(same.photos, undefined);
});

test('a link or quote stays with its person even when the first person has none', () => {
  const d = base();
  d.stories = [{ person_id: 'a', ...story('x', '') }, { person_id: 'b', ...story('x', 'Mine.', { social: 'https://x.test/b' }) }];
  const [c] = buildPublished(d).cards;
  assert.deepEqual(c.social, ['', 'https://x.test/b']);
  assert.equal(c.whyTVC, 'Mine.');
});

test('someone who is inactive or unlisted is left out entirely; a 2017 card with nothing public is hidden', () => {
  const d = base();
  d.people[1].directory_visible = false;
  d.stories = [{ person_id: 'a', ...story('Sree.') }, { person_id: 'b', ...story('Pram.') }];
  assert.equal(buildPublished(d).cards[0].bio, 'Sree.');
  d.people[0].active = false;
  const r = buildPublished(d);
  assert.deepEqual(r.cards, []); // nobody left with a public story
  assert.deepEqual(r.hidden, ['Sree & Prameela']); // so the 2017 card is reduced to its name, not left in full
  // everyone unlisted: the same, even though nobody in the household is left to look at
  const all = base();
  all.people.forEach((p) => { p.directory_visible = false; });
  assert.deepEqual(buildPublished(all).hidden, ['Sree & Prameela']);
  const e = base();
  e.stories = [{ person_id: 'a', approved: { bio: 'x' }, approved_public: false }];
  assert.deepEqual(buildPublished(e).hidden, ['Sree & Prameela']);
});

test('a household with no card name is named from its primary members, but only once the mapping exists', () => {
  const d = base();
  d.households.push({ id: 'h2' });
  d.people.push({ id: 'n', full_name: 'New Member' });
  d.memberships.push({ household_id: 'h2', person_id: 'n', role: 'owner' });
  d.stories = [{ person_id: 'n', ...story('Hello.') }];
  assert.deepEqual(buildPublished(d).cards.map((c) => c.name), ['New Member']);
  d.cards = []; // the mapping has not been filled in: never invent a name that could duplicate a 2017 card
  const r = buildPublished(d);
  assert.deepEqual(r.cards, []);
  assert.equal(r.mappingReady, false);
});

test('merging: a published card replaces its 2017 card in place and keeps still-valid extras', () => {
  const legacy = [
    { name: 'Sree & Prameela', bio: 'Old.', summary: 'Old summary.', photo: '/images/members/s.jpg', photoFull: '/images/members/s-full.jpg', familyNames: ['Sumant'], family: 'One son.' },
    { name: 'Other One', bio: 'Untouched.', photo: null },
    { name: 'Gone Card', bio: 'Used to be public.', photo: '/images/members/g.jpg', whyTVC: 'x' },
  ];
  const published = {
    cards: [
      { name: 'Sree & Prameela', bio: 'Old.', family: 'One son.', photo: '/images/members/s.jpg', whyTVC: 'New quote.' },
      { name: 'Brand New', bio: 'Newcomer.', photo: null },
    ],
    hidden: ['Gone Card'],
  };
  const m = mergePublished(legacy, published);
  assert.deepEqual(m.map((c) => c.name), ['Sree & Prameela', 'Other One', 'Gone Card', 'Brand New']);
  assert.equal(m[0].whyTVC, 'New quote.');
  assert.equal(m[0].summary, 'Old summary.'); // the bio is unchanged, so the hand-written line still fits
  assert.equal(m[0].photoFull, '/images/members/s-full.jpg'); // the photo is unchanged, so its full version is too
  assert.deepEqual(m[0].familyNames, ['Sumant']);
  assert.equal(m[1].bio, 'Untouched.');
  assert.deepEqual(m[2], { name: 'Gone Card', bio: '', photo: null }); // reduced to a name
  // an edited bio or a new photo drops the stale extras
  const edited = mergePublished(legacy, { cards: [{ name: 'Sree & Prameela', bio: 'Changed.', family: 'Two sons.', photo: '/images/members/new.jpg' }], hidden: [] });
  assert.equal(edited[0].summary, undefined);
  assert.equal(edited[0].photoFull, undefined);
  assert.equal(edited[0].familyNames, undefined);
});

test('merging with nothing published changes nothing', () => {
  const legacy = [{ name: 'A', bio: 'x', photo: null }];
  assert.deepEqual(mergePublished(legacy, undefined), legacy);
  assert.deepEqual(mergePublished(legacy, { cards: [], hidden: [] }), legacy);
});

test('the build drops anything that is not the shape it expects', () => {
  assert.equal(sanitizePublished(null), null);
  assert.equal(sanitizePublished({ cards: 'x', hidden: [] }), null);
  const clean = sanitizePublished({
    cards: [
      { name: 'A & B', bio: 'ok', photo: UP, photos: [UP, 'https://evil.test/x.jpg', '/images/members/b.jpg'], whyTVC: ['one', '', 'two'], social: ['', 'https://x.test/b', 'javascript:alert(1)'], familyNames: ['Kid', '', 5] },
      { name: '', bio: 'nameless' },
      { name: 'C', bio: 'x'.repeat(7000), photo: 'https://evil.test/c.jpg' },
      null,
    ],
    hidden: ['Gone', '', 7],
  });
  assert.equal(clean.cards.length, 2);
  assert.deepEqual(clean.cards[0].photos, [UP, '/images/members/b.jpg']);
  assert.deepEqual(clean.cards[0].whyTVC, ['one', 'two']);
  assert.deepEqual(clean.cards[0].social, ['', 'https://x.test/b', '']);
  assert.deepEqual(clean.cards[0].familyNames, ['Kid']);
  assert.equal(clean.cards[1].bio, ''); // over-long text is dropped, not truncated
  assert.equal(clean.cards[1].photo, null); // a photo that is not a reference is dropped
  assert.deepEqual(clean.hidden, ['Gone']);
});

test('uploaded photos are listed once, and written to a file named from the card and the photo id', () => {
  const cards = [{ name: 'A & B', photo: UP, photos: [UP, '/images/members/b.jpg'] }, { name: 'C', photo: '/images/members/c.jpg' }];
  assert.deepEqual(uploadedPhotos(cards), [UP]);
  assert.deepEqual(photoFileFor('Sree & Prameela', UP), { square: '/images/members/up-sree-and-prameela-aaaaaaaa.jpg', full: '/images/members/up-sree-and-prameela-aaaaaaaa-full.jpg' });
});

test('references become site paths; a photo that could not be downloaded is dropped', () => {
  const got = new Set([UP]);
  const one = resolvePhotos({ name: 'A', bio: 'x', photo: UP }, got);
  assert.equal(one.photo, '/images/members/up-a-aaaaaaaa.jpg');
  assert.equal(one.photoFull, '/images/members/up-a-aaaaaaaa-full.jpg');
  const two = resolvePhotos({ name: 'A & B', bio: 'x', photo: UP, photos: [UP, '/images/members/b.jpg'] }, got);
  assert.deepEqual(two.photos, ['/images/members/up-a-and-b-aaaaaaaa.jpg', '/images/members/b.jpg']);
  assert.deepEqual(two.photosFull, ['/images/members/up-a-and-b-aaaaaaaa-full.jpg', '/images/members/b.jpg']);
  const missing = resolvePhotos({ name: 'A', bio: 'x', photo: UP }, new Set());
  assert.equal(missing.photo, null);
  assert.equal(missing.photoFull, undefined);
  const legacy = resolvePhotos({ name: 'A', bio: 'x', photo: '/images/members/a.jpg' }, new Set());
  assert.equal(legacy.photo, '/images/members/a.jpg'); // already on the site: used as it is
});

test('a card whose bio carries Markdown, even two long bios joined, survives the build\'s check', () => {
  const bio = `**Asha** works on [soil](https://example.com/s). ${'x'.repeat(2400)}`;
  const out = sanitizePublished({ cards: [{ name: 'Asha & Ravi', bio: `${bio} ${bio}`, photo: null }], hidden: [] });
  assert.ok(out.cards[0].bio.startsWith('**Asha** works on [soil]'));
});

// ---- one story per UNIT ----

const unit = (over = {}) => ({
  household_id: 'h1', approved_public: true,
  approved: { bio: 'Sree and Pram run a farm.', family: 'One son.', photos: [], quotes: { a: 'Retirement.', b: 'Giving back.' }, links: {} },
  ...over,
});

test('a unit story is published under the 2017 card name: one bio, each person\'s quote and link by position, only when public', () => {
  const d = { ...base(), unitStories: [unit({ approved: { bio: 'Sree and Pram run a farm.', family: 'One son.', photos: [], quotes: { a: 'Retirement.', b: 'Giving back.' }, links: { b: 'https://x.test/b' } } })] };
  const { cards, hidden } = buildPublishedUnits(d);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, 'Sree & Prameela');
  assert.equal(cards[0].bio, 'Sree and Pram run a farm.');
  assert.equal(cards[0].family, 'One son.');
  assert.deepEqual(cards[0].whyTVC, ['Retirement.', 'Giving back.']); // different quotes: one each, in the order of the names
  assert.deepEqual(cards[0].social, ['', 'https://x.test/b']); // Pram's link stays with Pram though Sree has none
  assert.deepEqual(hidden, []);
});

test('a quote the whole unit shares is one quote; a unit with no public story hides its 2017 card; a draft or one in review is never read', () => {
  const same = { ...base(), unitStories: [unit({ approved: { bio: 'B.', family: '', photos: [], quotes: { a: 'Same.', b: 'Same.' }, links: {} } })] };
  assert.equal(buildPublishedUnits(same).cards[0].whyTVC, 'Same.');
  const off = { ...base(), unitStories: [unit({ approved_public: false })] };
  assert.deepEqual(buildPublishedUnits(off), { mappingReady: true, cards: [], hidden: ['Sree & Prameela'] });
  const draftOnly = { ...base(), unitStories: [{ household_id: 'h1', approved: null, approved_public: null, draft: { bio: 'secret' }, submitted: { bio: 'secret' } }] };
  assert.deepEqual(buildPublishedUnits(draftOnly).cards, []);
});

test('only the unit\'s first photo goes on the public card, and the quote and link of someone unlisted stay out', () => {
  const photos = [{ ref: UP, personId: 'a' }, { ref: '/images/members/p.jpg', personId: 'b' }];
  const d = { ...base(), unitStories: [unit({ approved: { bio: 'B.', family: '', photos, quotes: { a: 'Mine.', b: 'Hers.' }, links: { a: 'https://x.test/a', b: 'https://x.test/b' } } })] };
  d.people = d.people.map((p) => (p.id === 'b' ? { ...p, directory_visible: false } : p));
  const [card] = buildPublishedUnits(d).cards;
  assert.equal(card.photo, UP);
  assert.equal(card.photos, undefined);
  assert.equal(card.whyTVC, 'Mine.');
  assert.deepEqual(card.social, ['https://x.test/a']);
});

test('a unit whose people are all unlisted hides its card; with no card name it is named from its owners, once the mapping exists', () => {
  const none = { ...base(), unitStories: [unit()] };
  none.people = none.people.map((p) => ({ ...p, active: false }));
  assert.deepEqual(buildPublishedUnits(none).hidden, ['Sree & Prameela']);
  const noMap = { ...base(), cards: [], unitStories: [unit()] };
  assert.deepEqual(buildPublishedUnits(noMap), { mappingReady: false, cards: [], hidden: [] });
  const named = { ...base(), cards: [{ household_id: 'other', card_name: 'Other', person_ids: [] }], unitStories: [unit()] };
  assert.equal(buildPublishedUnits(named).cards[0].name, 'Prameela & Sreedhar'); // no card means no name order: by name, as for a person's
});

test('the family members of a unit are named, not given a block each', () => {
  const [card] = buildPublishedUnits({ ...base(), unitStories: [unit()] }).cards;
  assert.deepEqual(card.familyNames, ['Kid']);
});

// ---- a unit's public photo ----

test('a public unit photo comes from the uploader\'s files, only if it is in the approved, public copy and the uploader is a listed owner of the unit', () => {
  const d = base();
  const row = unit({ approved: { bio: 'B.', family: '', photos: [{ ref: UP, personId: 'a' }], quotes: {}, links: {} } });
  const ask = (over = {}) => publishedUnitPhotoHolder({ row: over.row ?? row, photoId: over.photoId ?? UP, people: over.people ?? d.people, memberships: over.memberships ?? d.memberships });
  assert.equal(ask(), 'a');
  assert.equal(ask({ photoId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), null); // not one of the unit's photos
  assert.equal(ask({ row: { ...row, approved_public: false } }), null); // the switch is off
  assert.equal(ask({ row: { ...row, approved: null, draft: row.approved, submitted: row.approved } }), null); // a draft or a submission is never public
  assert.equal(ask({ people: d.people.map((p) => (p.id === 'a' ? { ...p, directory_visible: false } : p)) }), null); // opted out
  assert.equal(ask({ people: d.people.map((p) => (p.id === 'a' ? { ...p, active: false } : p)) }), null);
  assert.equal(ask({ memberships: d.memberships.map((m) => (m.person_id === 'a' ? { ...m, role: 'family' } : m)) }), null); // not an owner
  assert.equal(ask({ memberships: d.memberships.map((m) => (m.person_id === 'a' ? { ...m, household_id: 'h9' } : m)) }), null); // of another unit
});
