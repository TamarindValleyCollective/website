// Run with: node --test scripts/lib/member-unit-story.test.mjs
// Made-up people and text only: this repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnitStory, addPhoto, mergeDraftEdit, validateUnitSave, validateUnitSubmit, draftState, draftColumns, unitStoryView, unitPhotoHolder, unitPhotoAccess, riskCopy, decisionApplies, decisionColumns, replacedPhotos, queueItem, unitRiskRow, unitSwitchLive, saveChanges, conflictedDraftKeys, MAX_PHOTOS } from './member-unit-story.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const copy = (over = {}) => ({ bio: 'We grow millets.', family: 'Two children.', why: 'Quiet land.', social: '', photo: '', ...over });
const row = (person_id, over = {}) => ({
  person_id, draft: {}, draft_public: false, status: 'approved', submitted: null, submitted_public: null, submitted_at: null,
  approved: copy(), approved_public: true, approved_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...over,
});

test('a unit with one person keeps their approved story, their quote under their id', () => {
  const { story, diverged } = buildUnitStory([row(A)]);
  assert.deepEqual(story.approved, { bio: 'We grow millets.', family: 'Two children.', photos: [], quotes: { [A]: 'Quiet land.' }, links: {} });
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
  fields: { bio: 'Our bio.', family: 'Our family.', photos: [], quotes: { [A]: 'A quote.', [B]: 'B quote.' }, links: {}, public: false },
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

test('each person keeps their own profile link, so a couple whose links differ is not diverged and loses neither', () => {
  const rows = [row(A, { approved: copy({ social: 'https://example.org/asha' }) }), row(B, { approved: copy({ social: 'https://example.org/ravi' }) })];
  const { story, diverged, winners } = buildUnitStory(rows);
  assert.deepEqual(story.approved.links, { [A]: 'https://example.org/asha', [B]: 'https://example.org/ravi' });
  assert.equal(diverged, false);
  assert.equal(story.approved.bio, 'We grow millets.');
  assert.ok(winners.approved); // still names a copy for the shared text
});

test('"link" is the editor\'s own profile link, like their quote; "social" is no longer a shared field', () => {
  const r = mergeDraftEdit({ current: draftAt(), changes: { link: 'https://example.org/mine' }, baseVersion: 5, personId: A });
  assert.equal(r.ok, true);
  assert.deepEqual(r.fields.links, { [A]: 'https://example.org/mine' });
  assert.equal(r.changed[`link:${A}`], 6);
  const clash = mergeDraftEdit({ current: draftAt({ changed: { [`link:${A}`]: 5 } }), changes: { link: 'https://example.org/other' }, baseVersion: 3, personId: A });
  assert.deepEqual(clash, { ok: false, error: 'conflict', fields: ['link'] });
  assert.deepEqual(mergeDraftEdit({ current: draftAt(), changes: { social: 'https://example.org/x' }, baseVersion: 5, personId: A }), { ok: false, error: 'unknown', fields: ['social'] });
});

// ---- what an owner may send when saving ----

test('a save names the version it started from and only the fields it changes; the public switch is "public"', () => {
  assert.deepEqual(validateUnitSave({ baseVersion: 4, bio: ' New bio. ', quote: 'Mine.', showOnPublicSite: true }), {
    ok: true, baseVersion: 4, changes: { bio: 'New bio.', quote: 'Mine.', public: true },
  });
  assert.deepEqual(validateUnitSave({ baseVersion: 0, link: '' }), { ok: true, baseVersion: 0, changes: { link: '' } });
});

test('a save without a version, with nothing to change, or with an unknown or photo field is refused', () => {
  assert.deepEqual(validateUnitSave({ bio: 'x' }), { ok: false, error: 'Reload the page and try again.' });
  assert.deepEqual(validateUnitSave({ baseVersion: -1, bio: 'x' }), { ok: false, error: 'Reload the page and try again.' });
  assert.deepEqual(validateUnitSave({ baseVersion: 1 }), { ok: false, error: 'Nothing to do.' });
  assert.deepEqual(validateUnitSave({ baseVersion: 1, bio: 'x', photos: [] }), { ok: false, error: 'Unknown field.' });
  assert.deepEqual(validateUnitSave(null), { ok: false, error: 'Nothing to do.' });
});

test('save keeps the existing limits: lengths, link addresses, at most ten links in the text', () => {
  assert.match(validateUnitSave({ baseVersion: 1, bio: 'x'.repeat(2501) }).error, /too long/);
  assert.match(validateUnitSave({ baseVersion: 1, quote: 'x'.repeat(401) }).error, /too long/);
  assert.match(validateUnitSave({ baseVersion: 1, link: 'not a web address' }).error, /https/);
  assert.match(validateUnitSave({ baseVersion: 1, link: 'ftp://example.org/x' }).error, /https/);
  assert.equal(validateUnitSave({ baseVersion: 1, link: 'https://example.org/me' }).ok, true);
  const many = Array.from({ length: 11 }, (_, i) => `[a${i}](https://example.org/${i})`).join(' ');
  assert.match(validateUnitSave({ baseVersion: 1, bio: many }).error, /up to 10 links/);
  assert.match(validateUnitSave({ baseVersion: 1, bio: 5 }).error, /text/);
  assert.match(validateUnitSave({ baseVersion: 1, showOnPublicSite: 'yes' }).error, /on or off/);
});

// ---- the shared draft in the database, and what the page shows ----

const unitRow = (over = {}) => ({
  household_id: 'h1', status: 'draft', draft_version: 5, draft_public: false,
  draft_changed: { bio: 2, family: 5 },
  draft: { bio: 'Our bio.', family: 'Our family.', photos: [{ ref: P1, personId: A }], quotes: { [A]: 'A quote.', [B]: 'B quote.' }, links: { [B]: 'https://example.org/b' } },
  submitted: null, submitted_public: null, submitted_at: null, submitted_by: null,
  approved: null, approved_public: null, approved_at: null, reviewer_note: null, ...over,
});
const names = [{ id: A, firstName: 'Asha' }, { id: B, firstName: 'Ravi' }];

test('a row becomes the draft state mergeDraftEdit works on, and back again, losing nothing', () => {
  const state = draftState(unitRow());
  assert.equal(state.version, 5);
  assert.deepEqual(state.changed, { bio: 2, family: 5 });
  assert.equal(state.fields.public, false);
  assert.deepEqual(state.fields.photos, [{ ref: P1, personId: A }]);
  const saved = mergeDraftEdit({ current: state, changes: { bio: 'Edited.', public: true }, baseVersion: 5, personId: A });
  assert.deepEqual(draftColumns(saved), {
    draft: { bio: 'Edited.', family: 'Our family.', photos: [{ ref: P1, personId: A }], quotes: { [A]: 'A quote.', [B]: 'B quote.' }, links: { [B]: 'https://example.org/b' } },
    draft_public: true, draft_version: 6, draft_changed: { bio: 6, family: 5, public: 6 },
  });
});

test('a unit with no row yet starts from an empty draft at version 0', () => {
  assert.deepEqual(draftState(null), { version: 0, fields: { bio: '', family: '', photos: [], quotes: {}, links: {}, public: false }, changed: {} });
});

test('a unit story needs at least one "why TVC" quote, from anyone in the unit, not one from each person or from the one submitting', () => {
  const draft = draftState(unitRow()).fields; // A and B each have one
  assert.deepEqual(validateUnitSubmit({ fields: draft }), { ok: true });
  // a joint quote written by one person is enough for the whole unit, so a housemate with none of their own can submit
  assert.deepEqual(validateUnitSubmit({ fields: { ...draft, quotes: { [B]: 'The only quote.' } } }), { ok: true });
  const needsOne = { ok: false, error: 'Your unit\'s story needs at least one "why TVC" line before it can be submitted.' };
  assert.deepEqual(validateUnitSubmit({ fields: { ...draft, quotes: {} } }), needsOne);
  assert.deepEqual(validateUnitSubmit({ fields: { ...draft, quotes: { [A]: '   ', [B]: '' } } }), needsOne); // blanks are not quotes
  assert.deepEqual(validateUnitSubmit({ fields: { ...draft, quotes: undefined } }), needsOne);
});

test('the page shows the editor their own quote and link to edit and their housemates\' beside the story, read-only', () => {
  const view = unitStoryView(unitRow(), { personId: A, people: names });
  assert.equal(view.version, 5);
  assert.deepEqual(view.draft, { bio: 'Our bio.', family: 'Our family.', quote: 'A quote.', link: '', photos: [{ ref: P1, personId: A }] });
  assert.deepEqual(view.others, [{ firstName: 'Ravi', quote: 'B quote.', link: 'https://example.org/b' }]);
  assert.equal(view.showOnPublicSite, false);
  assert.equal(view.status, 'draft');
  assert.equal(view.hasUnsubmittedChanges, true);
  assert.equal(view.hasApproved, false);
});

test('everyone else in the unit is named on the card, whether or not they have written a line of their own', () => {
  // Ravi has a quote; a third person in the unit has written nothing. The card title still names both housemates.
  const view = unitStoryView(unitRow(), { personId: A, people: [...names, { id: C, firstName: 'Cy' }] });
  assert.deepEqual(view.housemates, ['Ravi', 'Cy']);
  assert.deepEqual(view.others.map((o) => o.firstName), ['Ravi']); // only those with something to read are listed with their lines
  assert.deepEqual(unitStoryView(null, { personId: A, people: names }).housemates, ['Ravi']); // and before any story exists
  assert.deepEqual(unitStoryView(unitRow(), { personId: A, people: [{ id: A, firstName: 'Asha' }] }).housemates, []); // alone in the unit
});

test('the card names the unit\'s owners, not its children or other family', () => {
  const people = [{ id: A, firstName: 'Asha', primary: true }, { id: B, firstName: 'Ravi', primary: true }, { id: C, firstName: 'Kid', primary: false }];
  assert.deepEqual(unitStoryView(unitRow(), { personId: A, people }).housemates, ['Ravi']);
});

test('no row yet: an empty story, nothing to submit', () => {
  const view = unitStoryView(null, { personId: A, people: names });
  assert.deepEqual(view.draft, { bio: '', family: '', quote: '', link: '', photos: [] });
  assert.deepEqual([view.version, view.status, view.hasUnsubmittedChanges, view.hasApproved], [0, 'draft', false, false]);
});

test('an unchanged draft over live text has no unsubmitted changes; an edit does; a sent-back story shows its note', () => {
  const live = { bio: 'Our bio.', family: 'Our family.', photos: [], quotes: { [A]: 'A quote.' }, links: {} };
  const same = unitRow({ status: 'approved', approved: live, approved_public: true, draft_public: true, draft: live });
  assert.equal(unitStoryView(same, { personId: A, people: names }).hasUnsubmittedChanges, false);
  const edited = unitRow({ ...same, draft: { ...live, bio: 'Changed.' } });
  assert.equal(unitStoryView(edited, { personId: A, people: names }).hasUnsubmittedChanges, true);
  const sentBack = unitRow({ status: 'rejected', reviewer_note: 'Please remove the phone number.' });
  assert.equal(unitStoryView(sentBack, { personId: A, people: names }).reviewerNote, 'Please remove the phone number.');
  assert.equal(unitStoryView(edited, { personId: A, people: names }).reviewerNote, null);
});

// ---- who may see a unit's photo ----

const photoRow = () => unitRow({
  household_id: 'h1',
  draft: { photos: [{ ref: P1, personId: A }, { ref: P2, personId: B }] },
  submitted: { photos: [{ ref: P1, personId: A }] },
  approved: { photos: [{ ref: P3, personId: B }] },
});

test('a unit photo is found in whichever copy holds it, with the person it is stored under', () => {
  assert.deepEqual(unitPhotoHolder(photoRow(), P2), { ref: P2, personId: B });
  assert.deepEqual(unitPhotoHolder(photoRow(), P3), { ref: P3, personId: B });
  assert.equal(unitPhotoHolder(photoRow(), 'nope'), null);
});

test('housemates see any copy; everyone else only an approved photo of a listed member', () => {
  const row = photoRow();
  const ask = (photoId, viewerHouseholdIds, listed = true) => unitPhotoAccess({ viewerHouseholdIds, row, photoId, listed });
  assert.equal(ask(P2, ['h1']), true); // a draft photo, to the unit's own people
  assert.equal(ask(P2, ['h9']), false); // not another unit's draft
  assert.equal(ask(P1, ['h9']), false); // nor one in review
  assert.equal(ask(P3, ['h9']), true); // approved: the directory
  assert.equal(ask(P3, ['h9'], false), false); // unless they opted out of the directory
  assert.equal(ask(P3, ['h1'], false), true); // the unit itself always sees its own
  assert.equal(ask('nope', ['h1']), false);
});

// ---- the admin queue ----

test('a unit copy is shown to the risk rules in the per-person shape they already read, deterministically', () => {
  const copy = { bio: 'Our bio.', family: 'Our family.', photos: [{ ref: P2, personId: B }, { ref: P1, personId: A }], quotes: { [B]: 'B quote.', [A]: 'A quote.' }, links: { [A]: 'https://example.org/a', [B]: 'https://example.org/b' } };
  const a = riskCopy(copy);
  assert.deepEqual(a, { bio: 'Our bio.', family: 'Our family.', why: 'A quote.\n\nB quote.', social: 'https://example.org/a\nhttps://example.org/b', photo: `${P1},${P2}` });
  // the same content in another order is the same copy, so reordering is never read as a change
  assert.deepEqual(riskCopy({ ...copy, photos: [...copy.photos].reverse(), quotes: { [A]: 'A quote.', [B]: 'B quote.' } }), a);
  assert.equal(riskCopy(null), null);
  assert.deepEqual(riskCopy({ bio: '', family: '', photos: [], quotes: {}, links: {} }), { bio: '', family: '', why: '', social: '', photo: '' });
});

const inReview = (over = {}) => unitRow({
  status: 'in_review', submitted_at: '2026-10-20T10:00:00.123456Z', submitted_public: true, submitted_by: A,
  submitted: { bio: 'New bio.', family: 'Our family.', photos: [{ ref: P2, personId: B }], quotes: { [A]: 'A quote.' }, links: {} },
  approved: { bio: 'Old bio.', family: 'Our family.', photos: [{ ref: P1, personId: A }], quotes: { [A]: 'Old quote.' }, links: {} }, approved_public: false,
  draft: { bio: 'New bio.', family: 'Our family.', photos: [{ ref: P2, personId: B }], quotes: { [A]: 'A quote.' }, links: {} },
  ...over,
});
const NOW = '2026-10-21T08:00:00.000Z';

test('approving makes the submitted copy the live one and clears any earlier note; the live text is otherwise never touched', () => {
  assert.deepEqual(decisionColumns({ action: 'approve', row: inReview(), staffId: 's1', now: NOW }), {
    ok: true,
    columns: { status: 'approved', approved: inReview().submitted, approved_public: true, approved_at: NOW, reviewed_by: 's1', reviewer_note: null, updated_at: NOW },
  });
});

test('sending a story back needs a note for the members and leaves the live copy alone', () => {
  assert.deepEqual(decisionColumns({ action: 'reject', row: inReview(), staffId: 's1', now: NOW, note: '  Please remove the phone number. ' }), {
    ok: true, columns: { status: 'rejected', reviewed_by: 's1', reviewer_note: 'Please remove the phone number.', updated_at: NOW },
  });
  assert.deepEqual(decisionColumns({ action: 'reject', row: inReview(), staffId: 's1', now: NOW, note: '   ' }), { ok: false, error: 'A note for the members is needed when sending a story back.' });
  assert.equal(decisionColumns({ action: 'maybe', row: inReview(), staffId: 's1', now: NOW }).ok, false);
});

test('a decision applies only to the submission the reviewer saw, and only while it is in review', () => {
  assert.equal(decisionApplies(inReview(), '2026-10-20T10:00:00.123456Z'), true);
  assert.equal(decisionApplies(inReview(), '2026-10-20T10:00:00.123Z'), true); // the same instant at another precision
  assert.equal(decisionApplies(inReview(), '2026-10-20T11:00:00Z'), false); // resubmitted since
  assert.equal(decisionApplies(inReview({ status: 'approved' }), '2026-10-20T10:00:00.123456Z'), false); // already decided
  assert.equal(decisionApplies(null, '2026-10-20T10:00:00Z'), false);
});

test('approving replaces the live photos: those only the old live copy held are due for deletion', () => {
  assert.deepEqual(replacedPhotos(inReview()), [{ ref: P1, personId: A }]);
  const kept = inReview({ draft: { ...inReview().draft, photos: [{ ref: P1, personId: A }, { ref: P2, personId: B }] } }); // the draft still uses P1
  assert.deepEqual(replacedPhotos(kept), []);
  assert.deepEqual(replacedPhotos(inReview({ approved: null })), []);
});

const who = [{ id: A, name: 'Asha Example' }, { id: B, name: 'Ravi Example' }];

test('the queue shows a unit with whose submission it is and every quote and link under the person who wrote it', () => {
  const item = queueItem(inReview({
    submitted: { bio: 'Bio.', family: 'Fam.', photos: [{ ref: P2, personId: B }], quotes: { [B]: 'B quote.', [A]: 'A quote.' }, links: { [B]: 'https://example.org/b' } },
  }), { people: who, farmUnit: 'F-12' });
  assert.equal(item.householdId, 'h1');
  assert.equal(item.farmUnit, 'F-12');
  assert.equal(item.submittedAt, '2026-10-20T10:00:00.123456Z');
  assert.equal(item.submittedBy, 'Asha Example');
  assert.equal(item.submittedPublic, true);
  assert.deepEqual(item.submitted.quotes, [{ name: 'Asha Example', text: 'A quote.' }, { name: 'Ravi Example', text: 'B quote.' }]); // in the unit's order, not the object's
  assert.deepEqual(item.submitted.links, [{ name: 'Ravi Example', url: 'https://example.org/b' }]);
  assert.deepEqual(item.submitted.photos, [{ ref: P2, personId: B }]);
});

test('a first story is "new"; an edit lists exactly what changed against the live copy', () => {
  assert.deepEqual(queueItem(inReview({ approved: null }), { people: who, farmUnit: 'F-12' }).changes, [{ kind: 'new' }]);
  const edited = queueItem(inReview(), { people: who, farmUnit: 'F-12' }); // bio, photo and Asha's quote differ; public false -> true
  assert.deepEqual(edited.changes, [{ kind: 'bio' }, { kind: 'photos' }, { kind: 'quote', name: 'Asha Example' }, { kind: 'public' }]);
  assert.equal(edited.approved.bio, 'Old bio.');
  assert.equal(edited.approvedPublic, false);
  const same = inReview({ approved: inReview().submitted, approved_public: true });
  assert.deepEqual(queueItem(same, { people: who, farmUnit: 'F-12' }).changes, []);
});

test('a link change and an unknown person are shown, not dropped', () => {
  const row = inReview({
    approved: { bio: 'Old bio.', family: 'Our family.', photos: [], quotes: {}, links: { [A]: 'https://example.org/old' } },
    submitted: { bio: 'Old bio.', family: 'Our family.', photos: [], quotes: { [C]: 'Someone gone.' }, links: { [A]: 'https://example.org/new' } },
    submitted_public: false,
  });
  const item = queueItem(row, { people: who, farmUnit: 'F-12' });
  assert.deepEqual(item.changes, [{ kind: 'quote', name: 'Unknown' }, { kind: 'link', name: 'Asha Example' }]);
  assert.equal(item.submitted.quotes[0].name, 'Unknown');
});

// ---- risk assessment ----

test('a unit submission is shown to the risk code as one row keyed by the unit, with its copies in the shape the rules read', () => {
  const row = inReview();
  const risk = unitRiskRow(row);
  assert.equal(risk.person_id, 'h1'); // the risk code names its subject person_id; for a unit that is the unit's id
  assert.equal(risk.submitted_at, row.submitted_at);
  assert.equal(risk.submitted_public, true);
  assert.equal(risk.approved_public, false);
  assert.deepEqual(risk.submitted, riskCopy(row.submitted));
  assert.deepEqual(risk.approved, riskCopy(row.approved));
  assert.deepEqual(risk.draft, riskCopy(row.draft));
});

test('a first story has no live copy for the rules to compare with', () => {
  const risk = unitRiskRow(inReview({ approved: null, approved_public: null }));
  assert.equal(risk.approved, null);
  assert.equal(risk.approved_public, null);
});

// ---- the cutover switch ----

test('stories follow the unit model only when the setting says so explicitly; anything missing or odd means the old path', () => {
  assert.equal(unitSwitchLive({ value: { live: true } }), true);
  for (const bad of [undefined, null, {}, { value: null }, { value: {} }, { value: { live: false } }, { value: { live: 'true' } }, { value: { live: 1 } }, { value: 'live' }]) {
    assert.equal(unitSwitchLive(bad), false, JSON.stringify(bad));
  }
});

// ---- the editor ----

const onScreen = (over = {}) => ({ bio: 'Our bio.', family: 'Our family.', why: 'My quote.', social: 'https://example.org/me', isPublic: false, ...over });

test('a save carries only what changed since the last save, named the way the server expects', () => {
  const saved = onScreen();
  assert.deepEqual(saveChanges(saved, onScreen()), {});
  assert.deepEqual(saveChanges(saved, onScreen({ bio: 'New bio.' })), { bio: 'New bio.' });
  assert.deepEqual(saveChanges(saved, onScreen({ why: 'New quote.', social: '', isPublic: true })), { quote: 'New quote.', link: '', showOnPublicSite: true });
  assert.deepEqual(saveChanges(saved, onScreen({ family: '', bio: 'B.' })), { bio: 'B.', family: '' });
});

test('a conflict reply names the server\'s fields; the page needs the on-screen ones, and ignores what it does not show', () => {
  assert.deepEqual(conflictedDraftKeys(['bio', 'quote']), ['bio', 'why']);
  assert.deepEqual(conflictedDraftKeys(['link', 'public', 'family']), ['social', 'isPublic', 'family']);
  assert.deepEqual(conflictedDraftKeys(['photos']), ['photos']);
  assert.deepEqual(conflictedDraftKeys([]), []);
  assert.deepEqual(conflictedDraftKeys(undefined), []);
  assert.deepEqual(conflictedDraftKeys(['nonsense']), []);
});
