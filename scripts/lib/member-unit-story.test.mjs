// Run with: node --test scripts/lib/member-unit-story.test.mjs
// Made-up people and text only: this repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnitStory, addPhoto, mergeDraftEdit, MAX_PHOTOS } from './member-unit-story.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const copy = (over = {}) => ({ bio: 'We grow millets.', family: 'Two children.', why: 'Quiet land.', social: '', photo: '', ...over });
const row = (person_id, over = {}) => ({
  person_id, draft: {}, draft_public: false, status: 'approved', submitted: null, submitted_public: null, submitted_at: null,
  approved: copy(), approved_public: true, approved_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...over,
});

test('a unit with one person keeps their approved story, their quote under their id', () => {
  const { story, diverged } = buildUnitStory([row(A)]);
  assert.deepEqual(story.approved, { bio: 'We grow millets.', family: 'Two children.', social: '', photos: [], quotes: { [A]: 'Quiet land.' } });
  assert.equal(story.approvedPublic, true);
  assert.equal(story.status, 'approved');
  assert.equal(diverged, false);
});

test('a couple with identical text becomes one story with both quotes, and is not diverged', () => {
  const { story, diverged } = buildUnitStory([row(A), row(B, { approved: copy({ why: 'Shade and birds.' }) })]);
  assert.equal(story.approved.bio, 'We grow millets.');
  assert.deepEqual(story.approved.quotes, { [A]: 'Quiet land.', [B]: 'Shade and birds.' });
  assert.equal(diverged, false);
});

test('when the text differs, the most recently approved copy wins, whichever person it is, and the unit is flagged diverged', () => {
  const old = row(A); // the seed
  const edited = row(B, { approved: copy({ bio: 'We now run a seed bank.', why: 'Seeds.' }), approved_at: '2026-10-20T00:00:00Z' });
  for (const rows of [[old, edited], [edited, old]]) {
    const { story, diverged } = buildUnitStory(rows);
    assert.equal(story.approved.bio, 'We now run a seed bank.');
    assert.deepEqual(story.approved.quotes, { [A]: 'Quiet land.', [B]: 'Seeds.' }); // each person's own quote is kept
    assert.equal(diverged, true);
  }
});

const C = '33333333-3333-4333-8333-333333333333';
const P1 = '44444444-4444-4444-8444-444444444444';
const P2 = '55555555-5555-4555-8555-555555555555';
const P3 = '66666666-6666-4666-8666-666666666666';

test('photos are collected across the unit newest first, each remembering who uploaded it (it sits under their id in storage)', () => {
  const rows = [
    row(A, { approved: copy({ photo: P1 }), approved_at: '2026-10-01T00:00:00Z' }),
    row(B, { approved: copy({ photo: P2 }), approved_at: '2026-10-10T00:00:00Z' }),
  ];
  assert.deepEqual(buildUnitStory(rows).story.approved.photos, [{ ref: P2, personId: B }, { ref: P1, personId: A }]);
});

test('a photo the whole unit shares (the seeded card photo on every person) is listed once', () => {
  const shared = '/images/members/example-card.jpg';
  const rows = [row(A, { approved: copy({ photo: shared }) }), row(B, { approved: copy({ photo: shared }) })];
  assert.deepEqual(buildUnitStory(rows).story.approved.photos, [{ ref: shared, personId: A }]);
});

test('a unit keeps at most two photos: the two newest', () => {
  const rows = [
    row(A, { approved: copy({ photo: P1 }), approved_at: '2026-10-01T00:00:00Z' }),
    row(B, { approved: copy({ photo: P2 }), approved_at: '2026-10-03T00:00:00Z' }),
    row(C, { approved: copy({ photo: P3 }), approved_at: '2026-10-02T00:00:00Z' }),
  ];
  assert.deepEqual(buildUnitStory(rows).story.approved.photos.map((p) => p.ref), [P2, P3]);
});

test('an empty draft (the column default) is no draft; a real one is the unit draft, newest edit winning', () => {
  const rows = [row(A), row(B, { draft: copy({ bio: 'Half-written bio.', why: '' }), draft_public: true, updated_at: '2026-10-15T00:00:00Z' })];
  const { story } = buildUnitStory(rows);
  assert.equal(story.draft.bio, 'Half-written bio.');
  assert.equal(story.draftPublic, true);
  assert.equal(buildUnitStory([row(A)]).story.draft, null);
});

test('only a copy actually in review is the unit\'s submission, and it makes the unit in_review', () => {
  const rows = [
    row(A, { status: 'in_review', submitted: copy({ bio: 'Submitted bio.', why: 'My quote.' }), submitted_public: false, submitted_at: '2026-10-18T00:00:00Z' }),
    row(B, { submitted: copy({ bio: 'Old decided snapshot.' }), submitted_at: '2026-09-01T00:00:00Z' }), // approved since; not in review
  ];
  const { story } = buildUnitStory(rows);
  assert.equal(story.status, 'in_review');
  assert.equal(story.submitted.bio, 'Submitted bio.');
  assert.deepEqual(story.submitted.quotes, { [A]: 'My quote.' });
  assert.equal(story.submittedAt, '2026-10-18T00:00:00Z');
  assert.equal(story.submittedPublic, false);
});

test('a unit may add photos up to the limit, each once', () => {
  assert.equal(MAX_PHOTOS, 2);
  const one = addPhoto([], { ref: P1, personId: A });
  assert.deepEqual(one, { ok: true, photos: [{ ref: P1, personId: A }] });
  const two = addPhoto(one.photos, { ref: P2, personId: B });
  assert.deepEqual(two.photos.map((p) => p.ref), [P1, P2]);
  assert.deepEqual(addPhoto(two.photos, { ref: P3, personId: A }), { ok: false, error: 'full' });
  assert.deepEqual(addPhoto(one.photos, { ref: P1, personId: B }), { ok: false, error: 'duplicate' });
});

// The shared draft as the server holds it: the fields, the version, and the version at which each field last changed.
const draftAt = (over = {}) => ({
  version: 5,
  fields: { bio: 'Our bio.', family: 'Our family.', social: '', photos: [], quotes: { [A]: 'A quote.', [B]: 'B quote.' }, public: false },
  changed: { bio: 2, family: 5 },
  ...over,
});

test('two owners editing different fields both land: the edit merges into the newer draft', () => {
  // A started from version 3 and edits the bio; B has since changed the family (version 5).
  const r = mergeDraftEdit({ current: draftAt(), changes: { bio: 'A new bio.' }, baseVersion: 3, personId: A });
  assert.equal(r.ok, true);
  assert.equal(r.fields.bio, 'A new bio.');
  assert.equal(r.fields.family, 'Our family.');
  assert.equal(r.version, 6);
  assert.equal(r.changed.bio, 6);
  assert.equal(r.changed.family, 5);
});

test('editing a field the other owner changed since your version is a conflict naming the field, and nothing is applied', () => {
  const r = mergeDraftEdit({ current: draftAt(), changes: { family: 'My version of family.', bio: 'Fine bio.' }, baseVersion: 3, personId: A });
  assert.deepEqual(r, { ok: false, error: 'conflict', fields: ['family'] });
});

test('saving a value the draft already holds is never a conflict and does not bump the version', () => {
  const r = mergeDraftEdit({ current: draftAt(), changes: { family: 'Our family.' }, baseVersion: 3, personId: A });
  assert.equal(r.ok, true);
  assert.equal(r.version, 5);
  assert.equal(r.changed.family, 5);
});

test('"quote" is the editor\'s own quote: it sets only their entry, and the other owner\'s quote editing never conflicts with it', () => {
  const current = draftAt({ changed: { bio: 2, [`quote:${B}`]: 5 } }); // B changed their quote at version 5
  const r = mergeDraftEdit({ current, changes: { quote: 'A better quote.' }, baseVersion: 3, personId: A });
  assert.equal(r.ok, true);
  assert.deepEqual(r.fields.quotes, { [A]: 'A better quote.', [B]: 'B quote.' });
  assert.equal(r.changed[`quote:${A}`], 6);
  // the same person colliding with their own newer quote (say, from a second device) is a conflict
  const again = mergeDraftEdit({ current: draftAt({ changed: { [`quote:${A}`]: 5 } }), changes: { quote: 'Other.' }, baseVersion: 3, personId: A });
  assert.deepEqual(again, { ok: false, error: 'conflict', fields: ['quote'] });
});

test('a save cannot set someone else\'s quote, or anything that is not a story field', () => {
  assert.deepEqual(mergeDraftEdit({ current: draftAt(), changes: { quotes: { [B]: 'Mine now.' } }, baseVersion: 5, personId: A }), { ok: false, error: 'unknown', fields: ['quotes'] });
  assert.deepEqual(mergeDraftEdit({ current: draftAt(), changes: { version: 99, bio: 'x' }, baseVersion: 5, personId: A }), { ok: false, error: 'unknown', fields: ['version'] });
});

test('photos in a save must fit the limit and be distinct', () => {
  const ph = (ref, personId = A) => ({ ref, personId });
  assert.deepEqual(mergeDraftEdit({ current: draftAt(), changes: { photos: [ph(P1), ph(P2), ph(P3)] }, baseVersion: 5, personId: A }), { ok: false, error: 'invalid', fields: ['photos'] });
  assert.deepEqual(mergeDraftEdit({ current: draftAt(), changes: { photos: [ph(P1), ph(P1, B)] }, baseVersion: 5, personId: A }), { ok: false, error: 'invalid', fields: ['photos'] });
  assert.equal(mergeDraftEdit({ current: draftAt(), changes: { photos: [ph(P1), ph(P2)] }, baseVersion: 5, personId: A }).ok, true);
});

test('the result says whose copy supplied the shared text, so a diverged unit can be reviewed', () => {
  const old = row(A);
  const edited = row(B, { approved: copy({ bio: 'We now run a seed bank.' }), approved_at: '2026-10-20T00:00:00Z' });
  const { winners } = buildUnitStory([old, edited]);
  assert.deepEqual(winners, { approved: B, draft: null, submitted: null });
});
