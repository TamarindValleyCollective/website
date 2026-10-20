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
