// Run with: node --test scripts/lib/member-directory.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectory } from './member-directory.mjs';

const story = { bio: 'Asha is an engineer.', family: 'Lives in Bengaluru.', why: 'The soil.', social: 'https://www.linkedin.com/in/asha' };
const data = {
  people: [
    { id: 'p1', full_name: 'Asha Rao', active: true, directory_visible: true },
    { id: 'p2', full_name: 'Bo Chen', active: true, directory_visible: true },
    { id: 'p3', full_name: 'Cy Dutt', active: true, directory_visible: false }, // opted out
    { id: 'p4', full_name: 'Di Eze', active: false, directory_visible: true }, // inactive
    { id: 'p5', full_name: 'Ed Fox', active: true, directory_visible: false }, // alone in a household, opted out
  ],
  memberships: [
    { household_id: 'h12', person_id: 'p2' },
    { household_id: 'h2', person_id: 'p1' },
    { household_id: 'h2', person_id: 'p3' },
    { household_id: 'h2', person_id: 'p4' },
    { household_id: 'h9', person_id: 'p5' },
  ],
  households: [
    { id: 'h12', farm_unit: 'F-12', house_no: null, cluster: null },
    { id: 'h2', farm_unit: 'F-02', house_no: 'H-07', cluster: 'H1-A' },
    { id: 'h9', farm_unit: 'F-09', house_no: 'H-30', cluster: 'H2' },
  ],
  stories: [
    { person_id: 'p1', approved: story, approved_public: true },
    { person_id: 'p3', approved: story, approved_public: true }, // opted out: must not leak
  ],
};

test('households come out in farm-plot order with their listed people only', () => {
  const d = buildDirectory(data, 'p2');
  assert.deepEqual(d.map((h) => h.farmUnit), ['F-02', 'F-12']);
  assert.deepEqual(d[0].people.map((p) => p.name), ['Asha Rao']);
  assert.equal(d[0].cluster, 'H1-A');
  assert.equal(d[1].cluster, null);
  // the house number comes with the household, and is null when no house is built yet
  assert.equal(d[0].houseNo, 'H-07');
  assert.equal(d[1].houseNo, null);
});

test('someone who opted out, or is inactive, is not listed, and nor is their story', () => {
  const json = JSON.stringify(buildDirectory(data, 'p2'));
  for (const hidden of ['Cy Dutt', 'Di Eze', 'Ed Fox']) assert.ok(!json.includes(hidden), hidden);
  assert.equal(buildDirectory(data, 'p2').find((h) => h.farmUnit === 'F-09'), undefined); // nobody listed
});

test('only an approved story is shown, with whether it is also public', () => {
  const [h2, h12] = buildDirectory(data, 'p2');
  assert.deepEqual(h2.people[0].story, { ...story, onPublicSite: true });
  assert.equal(h2.hasStory, true);
  assert.equal(h12.people[0].story, null);
  assert.equal(h12.hasStory, false);
  // a draft or in-review copy never reaches the directory: only `approved` is read
  const inReviewOnly = { ...data, stories: [{ person_id: 'p1', approved: null, approved_public: null }] };
  assert.equal(buildDirectory(inReviewOnly, 'p2')[0].people[0].story, null);
});

test('inside a household the viewer comes first, then people by name', () => {
  const two = { ...data, people: [{ id: 'p1', full_name: 'Zed Z', active: true, directory_visible: true }, { id: 'p9', full_name: 'Amy A', active: true, directory_visible: true }], memberships: [{ household_id: 'h2', person_id: 'p1' }, { household_id: 'h2', person_id: 'p9' }], stories: [] };
  assert.deepEqual(buildDirectory(two, 'p1')[0].people.map((p) => p.name), ['Zed Z', 'Amy A']);
  assert.deepEqual(buildDirectory(two, 'someone-else')[0].people.map((p) => p.name), ['Amy A', 'Zed Z']);
});

test('the viewer is told which person is them', () => {
  assert.equal(buildDirectory(data, 'p1')[0].people[0].isYou, true);
  assert.equal(buildDirectory(data, 'p2')[0].people[0].isYou, false);
});

test('a profile link is only passed on if it is a web address', () => {
  const bad = { ...data, stories: [{ person_id: 'p1', approved: { ...story, social: 'javascript:alert(1)' }, approved_public: false }] };
  assert.equal(buildDirectory(bad, 'p2')[0].people[0].story.social, '');
});

test('an approved story with nothing in it is treated as no story', () => {
  const empty = { ...data, stories: [{ person_id: 'p1', approved: { bio: ' ', family: '', why: '', social: '' }, approved_public: false }] };
  assert.equal(buildDirectory(empty, 'p2')[0].people[0].story, null);
});

test('the output carries no contact or land fields, whatever the input rows hold', () => {
  const noisy = { ...data, people: data.people.map((p) => ({ ...p, email: 'x@example.com', phone: '+919845012345' })) };
  const json = JSON.stringify(buildDirectory(noisy, 'p1'));
  assert.ok(!json.includes('example.com') && !json.includes('9845'));
});

test('identical bio and family on both people become one section, with their own quote and link', () => {
  const shared = { bio: 'Sree is a director. Prameela designs.', family: 'One son.' };
  const d = buildDirectory(
    {
      people: [{ id: 'a', full_name: 'Prameela K' }, { id: 'b', full_name: 'Sree K' }],
      memberships: [{ household_id: 'h', person_id: 'a' }, { household_id: 'h', person_id: 'b' }],
      households: [{ id: 'h', farm_unit: 'F-77', house_no: null, cluster: null }],
      stories: [
        { person_id: 'a', approved: { ...shared, why: 'Giving back.', social: 'https://example.org/p' }, approved_public: true },
        { person_id: 'b', approved: { ...shared, why: 'Retirement years.', social: 'https://example.org/s' }, approved_public: true },
      ],
    },
    'a',
  );
  const [hh] = d;
  assert.equal(hh.groups.length, 1);
  const g = hh.groups[0];
  assert.deepEqual(g.people.map((p) => p.name), ['Prameela K', 'Sree K']);
  assert.equal(g.bio, shared.bio);
  assert.deepEqual(g.quotes, [{ name: 'Prameela K', why: 'Giving back.' }, { name: 'Sree K', why: 'Retirement years.' }]);
  assert.deepEqual(g.links.map((l) => l.name), ['Prameela K', 'Sree K']);
  assert.deepEqual(hh.withoutStory, []);
});

test('the same quote on everyone is shown once, and people with different text stay apart', () => {
  const mk = (id, bio, why) => ({ person_id: id, approved: { bio, family: '', why, social: '' }, approved_public: false });
  const base = {
    people: [{ id: 'a', full_name: 'A' }, { id: 'b', full_name: 'B' }, { id: 'c', full_name: 'C' }],
    memberships: ['a', 'b', 'c'].map((person_id) => ({ household_id: 'h', person_id })),
    households: [{ id: 'h', farm_unit: 'F-01', house_no: null, cluster: null }],
  };
  const same = buildDirectory({ ...base, stories: [mk('a', 'Same.', 'We love it.'), mk('b', 'Same.', 'We love it.')] }, 'a')[0];
  assert.equal(same.groups.length, 1);
  assert.deepEqual(same.groups[0].quotes, [{ name: null, why: 'We love it.' }]);
  assert.deepEqual(same.withoutStory.map((p) => p.name), ['C']);

  const apart = buildDirectory({ ...base, stories: [mk('a', 'One.', 'x'), mk('b', 'Two.', 'y')] }, 'a')[0];
  assert.equal(apart.groups.length, 2);
  // quote-only stories are never merged: there is no shared text to show once
  const quotesOnly = buildDirectory({ ...base, stories: [mk('a', '', 'x'), mk('b', '', 'x')] }, 'a')[0];
  assert.equal(quotesOnly.groups.length, 2);
});

test('the approved photo is passed on, alone or with a story, and anything odd is dropped', () => {
  const UP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const base = {
    people: [{ id: 'a', full_name: 'A' }, { id: 'b', full_name: 'B' }, { id: 'c', full_name: 'C' }],
    memberships: ['a', 'b', 'c'].map((person_id) => ({ household_id: 'h', person_id })),
    households: [{ id: 'h', farm_unit: 'F-01', house_no: null, cluster: null }],
  };
  const d = buildDirectory({
    ...base,
    stories: [
      { person_id: 'a', approved: { bio: 'x', family: '', why: '', social: '', photo: UP }, approved_public: false },
      { person_id: 'b', approved: { bio: '', family: '', why: '', social: '', photo: '/images/members/b-and-c.jpg' }, approved_public: true }, // a photo and no text
      { person_id: 'c', approved: { bio: 'z', family: '', why: '', social: '', photo: 'https://evil.test/x.jpg' }, approved_public: false },
    ],
  }, 'a')[0];
  assert.deepEqual(d.people.map((p) => p.photo), [UP, '/images/members/b-and-c.jpg', '']);
  assert.equal(d.people[1].story, null); // a photo alone is not a story
  // a draft or submitted photo is never read: only `approved`
  const draftOnly = buildDirectory({ ...base, stories: [{ person_id: 'a', approved: null, draft: { photo: UP }, submitted: { photo: UP } }] }, 'a')[0];
  assert.equal(draftOnly.people[0].photo, '');
});

test('primary members (owners) lead and are the ones a card names; the rest are the family section', () => {
  const data = {
    people: ['Zed Z', 'Amy A', 'Kid K', 'Bo B'].map((full_name, i) => ({ id: `p${i}`, full_name })),
    memberships: [
      { household_id: 'h', person_id: 'p0', role: 'owner' },
      { household_id: 'h', person_id: 'p1', role: 'owner' },
      { household_id: 'h', person_id: 'p2', role: 'family' },
      { household_id: 'h', person_id: 'p3', role: 'non_owner' },
    ],
    households: [{ id: 'h', farm_unit: 'F-01', house_no: null, cluster: null }],
    stories: [{ person_id: 'p0', approved: { bio: 'Hi.', family: '', why: '', social: '' }, approved_public: true }],
  };
  const [hh] = buildDirectory(data, 'someone-else');
  assert.deepEqual(hh.people.map((p) => [p.name, p.primary]), [['Amy A', true], ['Zed Z', true], ['Bo B', false], ['Kid K', false]]);
  assert.deepEqual(hh.familyMembers.map((p) => p.name), ['Bo B', 'Kid K']);
  assert.deepEqual(hh.withoutStory.map((p) => p.name), ['Amy A']); // only primary members "have not shared"
  // the viewer still comes first, even if they are family
  assert.equal(buildDirectory(data, 'p2')[0].people[0].name, 'Kid K');
});

test('a household with no listed owner treats everyone as primary, so a card is never nameless', () => {
  const data = {
    people: [{ id: 'a', full_name: 'A' }, { id: 'b', full_name: 'B' }],
    memberships: [{ household_id: 'h', person_id: 'a', role: 'family' }, { household_id: 'h', person_id: 'b', role: 'non_owner' }],
    households: [{ id: 'h', farm_unit: 'F-01', house_no: null, cluster: null }],
    stories: [],
  };
  const [hh] = buildDirectory(data, 'x');
  assert.ok(hh.people.every((p) => p.primary));
  assert.deepEqual(hh.familyMembers, []);
});
