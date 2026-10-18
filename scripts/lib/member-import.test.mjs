// Run with: node --test scripts/lib/member-import.test.mjs
// All people, units and patta numbers in these fixtures are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberRegister } from './member-import.mjs';

const MASTER_HEADER = ['#', 'Name', 'Farm Unit #', 'Cluster', 'House #', 'Unit Type', 'Farm Patta #', 'House Patta #', 'Email ID', 'Patta issues'];
const FARM_HEADER = ['Member', 'Farm #', 'House #', 'Reference Number', 'Patta #', 'Survey #', 'Area (H)', 'Area (Acres)', 'Settlement'];
const HOUSE_HEADER = ['Member', 'Patta #', 'Farm #', 'House #', 'Reference Number', 'Survey #', 'Area (H)x100', 'Area (sq.ft.)', 'Settlement'];

const tabs = (master, farm = [], house = []) => ({
  'Member Master': [MASTER_HEADER, ...master],
  'Farm Patta Details': [FARM_HEADER, ...farm],
  'House Patta Details': [HOUSE_HEADER, ...house],
});

test('groups people into households and keeps real emails only', () => {
  const r = buildMemberRegister(
    tabs([
      ['1', 'Asha Rao', 'F-27', 'H1-A', 'H-17', 'DG1', '1234', '', 'Asha'],
      ['2', 'Ravi Rao', 'F-27', 'H1-A', 'H-17', 'DG1', '1234', '', 'Ravi@Example.com'],
    ]),
  );
  assert.equal(r.households.length, 1);
  assert.deepEqual(r.households[0], { farm_unit: 'F-27', house_no: 'H-17', cluster: 'H1-A', unit_type: 'DG1' });
  assert.equal(r.people.length, 2);
  assert.equal(r.people[0].email, null); // "Asha" is a name, not an email
  assert.equal(r.people[1].email, 'ravi@example.com');
});

test('a household with no house number is reported, not dropped', () => {
  const r = buildMemberRegister(tabs([['58', 'Meena Iyer', 'F-09', '', '', '', '1958', '', '']]));
  assert.equal(r.households[0].house_no, null);
  assert.ok(r.anomalies.some((a) => a.kind === 'household_without_house' && a.farmUnit === 'F-09'));
});

test('merges a confirmed duplicate person (passed in as a fix) and keeps the email', () => {
  const fixes = { mergePeople: [{ farmUnit: 'F-47', names: ['A B Kumar', 'Asok Kumar'], into: 'A B Kumar' }] };
  const r = buildMemberRegister(
    tabs(
      [
        ['25', 'A B Kumar', 'F-47', 'H1-B', 'H-51', 'S1', '2011', '', 'mailbox@example.com'],
        ['42', 'Asok Kumar', 'F-47', 'H1-B', 'H-51', 'S1', '', '', 'Asok K'],
        ['51', 'Lata Nair', 'F-47', 'H1-B', 'H-51', 'S1'],
      ],
    ),
    fixes,
  );
  const people = r.people.filter((p) => p.farmUnit === 'F-47');
  assert.equal(people.length, 2);
  assert.equal(people.find((p) => p.full_name === 'A B Kumar').email, 'mailbox@example.com');
  assert.ok(!r.anomalies.some((a) => a.kind === 'household_over_two_people'));
});

test('without that fix the same three rows are flagged as more than two people', () => {
  const r = buildMemberRegister(
    tabs([
      ['25', 'A B Kumar', 'F-47', 'H1-B', 'H-51', 'S1'],
      ['42', 'Asok Kumar', 'F-47', 'H1-B', 'H-51', 'S1'],
      ['51', 'Lata Nair', 'F-47', 'H1-B', 'H-51', 'S1'],
    ]),
  );
  assert.ok(r.anomalies.some((a) => a.kind === 'household_over_two_people' && a.farmUnit === 'F-47'));
});

test('a patta row for "A B Kumar" goes to that household, not to another Kumar', () => {
  const r = buildMemberRegister(
    tabs(
      [
        ['25', 'A B Kumar', 'F-47', 'H1-B', 'H-51', 'S1'],
        ['43', 'Suresh Kumar Menon', 'F-46', 'H1-B', 'H-46', 'S1'],
      ],
      [['A B Kumar', 'F-47', 'H-51', '31/12/081/02011/90134', '2011', '485/3A1', '0.06', '0.15', '']],
    ),
  );
  assert.equal(r.plots[0].farmUnit, 'F-47');
});

test('flags a household with more than two people when not a known duplicate', () => {
  const r = buildMemberRegister(
    tabs([
      ['1', 'A One', 'F-01', 'H2', 'H-10', 'S1'],
      ['2', 'B Two', 'F-01', 'H2', 'H-10', 'S1'],
      ['3', 'C Three', 'F-01', 'H2', 'H-10', 'S1'],
    ]),
  );
  assert.ok(r.anomalies.some((a) => a.kind === 'household_over_two_people' && a.farmUnit === 'F-01'));
});

test('attaches patta rows by house number even when the patta sheet uses another farm number', () => {
  const r = buildMemberRegister(
    tabs(
      [['46', 'Leela Menon', 'F-13', 'H1-B', 'H-49', 'S1']],
      [['Leela V Menon', 'F-09', 'H-49', '31/12/081/01958/80103', '1958', '455/1B', '0.5183', '1.28', '']],
    ),
  );
  assert.equal(r.plots.length, 1);
  assert.equal(r.plots[0].farmUnit, 'F-13');
  assert.equal(r.plots[0].area_acres, 1.28);
  assert.ok(r.anomalies.some((a) => a.kind === 'patta_sheet_farm_number_differs' && a.farmUnit === 'F-13'));
});

test("another household's patta column does not override names and house", () => {
  // The Member Master patta column for F-09 holds a patta that belongs to F-13.
  const r = buildMemberRegister(
    tabs(
      [
        ['46', 'Leela Menon', 'F-13', 'H1-B', 'H-49', 'S1'],
        ['58', 'Meena Iyer', 'F-09', '', '', '', '1958'],
      ],
      [['Leela V Menon', 'F-09', 'H-49', '31/12/081/01958/80103', '1958', '455/1B', '0.5183', '1.28', '']],
    ),
  );
  assert.equal(r.plots[0].farmUnit, 'F-13');
});

test('a patta row whose sheet farm number and names agree with a household needs no warning', () => {
  const r = buildMemberRegister(
    tabs(
      [['57', 'Tanvi Pillai', 'F-24', '', '', '', '', '', '']],
      [['Tanvi Pillai & Nita Joseph', 'F-24', '', '31/12/081/01988/80106', '1988', '467/2A2', '0.5177', '1.28', '']],
    ),
  );
  assert.equal(r.plots[0].farmUnit, 'F-24');
  assert.ok(!r.anomalies.some((a) => a.kind === 'patta_matched_by_name'));
});

test('falls back to name matching when neither farm number nor house helps, and says so', () => {
  const r = buildMemberRegister(
    tabs(
      [['57', 'Tanvi Pillai', 'F-24', '', '', '', '', '', '']],
      [['Tanvi Pillai & Nita Joseph', 'F-99', '', '31/12/081/01988/80106', '1988', '467/2A2', '0.5177', '1.28', '']],
    ),
  );
  assert.equal(r.plots[0].farmUnit, 'F-24');
  assert.ok(r.anomalies.some((a) => a.kind === 'patta_matched_by_name'));
});

// Two households swapped houses by agreement. Units F-60 and F-61 are made up.
// Current state: one household lives at H-22, the other at H-21, while
// patta rows still carry the old house numbers on some lines.
const SWAP_MASTER = [
  ['12', 'Dev Sethi', 'F-60', 'H1-A', 'H-22', 'DF1-V2'],
  ['56', 'Rina Sethi', 'F-60', 'H1-A', 'H-22', 'DF1-V2'],
  ['26', 'Omar Qureshi', 'F-61', 'H1-A', 'H-21', 'DF1-V2'],
];

test('after a house swap, farm patta stays with the farm even if its row still carries the old house number', () => {
  const r = buildMemberRegister(
    tabs(SWAP_MASTER, [
      // The Sethis' plots, one still listed against H-21, which is the other household's house now.
      ['Dev & Rina Sethi', 'F-60', 'H-21', '31/12/081/01981/80139', '1981', '457/1', '0.2955', '0.73', ''],
      ['Dev & Rina Sethi', 'F-60', 'H-22', '31/12/081/01886/80183', '1886', '443/2', '0.2200', '0.54', ''],
    ]),
  );
  assert.equal(r.plots.length, 2);
  assert.ok(r.plots.every((p) => p.farmUnit === 'F-60'), 'both plots belong to F-60');
  assert.ok(!r.plots.some((p) => p.farmUnit === 'F-61'));
});

test('after a house swap, a placeholder row under the old house goes to the right household by name', () => {
  const r = buildMemberRegister(tabs(SWAP_MASTER, [['Omar Qureshi', '', 'H-22', '', '', '', '', '0.00', '']]));
  assert.ok(r.anomalies.some((a) => a.kind === 'household_without_farm_patta' && a.farmUnit === 'F-61'));
  assert.ok(!r.plots.some((p) => p.farmUnit === 'F-60'));
});

test("house patta follows the house, and a previous owner's name is flagged for a transfer", () => {
  const r = buildMemberRegister(
    tabs(SWAP_MASTER, [], [['Dev & Rina Sethi', '2200', 'F-60', 'H-21', 'P/31/12/081/02200/90100', '478 / 3B', '1.0', '1000', '']]),
  );
  assert.equal(r.housePattas[0].farmUnit, 'F-61'); // H-21 is the other household's house now
  assert.ok(r.anomalies.some((a) => a.kind === 'house_patta_owner_differs' && a.farmUnit === 'F-61'));
});

test("a placeholder house patta in a previous owner's name does not raise a transfer flag", () => {
  const r = buildMemberRegister(tabs(SWAP_MASTER, [], [['Dev & Rina Sethi', '', 'F-60', 'H-21', '', '', '', '0.00', '']]));
  assert.ok(!r.anomalies.some((a) => a.kind === 'house_patta_owner_differs'));
});

test('a setHouse fix corrects a stale house only while the sheet still has the old one', () => {
  const fixes = {
    setHouse: [
      { farmUnit: 'F-12', houseNo: 'H-22', was: 'H-21' },
      { farmUnit: 'F-52', houseNo: 'H-21', was: 'H-22' },
    ],
  };
  const stale = buildMemberRegister(
    tabs([
      ['12', 'Dev Sethi', 'F-12', 'H1-A', 'H-21', 'DF1-V2'],
      ['26', 'Omar Qureshi', 'F-52', 'H1-A', 'H-22', 'DF1-V2'],
    ]),
    fixes,
  );
  const house = (r, unit) => r.households.find((h) => h.farm_unit === unit).house_no;
  assert.equal(house(stale, 'F-12'), 'H-22');
  assert.equal(house(stale, 'F-52'), 'H-21');
  assert.equal(stale.anomalies.filter((a) => a.kind === 'house_corrected').length, 2);

  const fixed = buildMemberRegister(
    tabs([
      ['12', 'Dev Sethi', 'F-12', 'H1-A', 'H-22', 'DF1-V2'],
      ['26', 'Omar Qureshi', 'F-52', 'H1-A', 'H-21', 'DF1-V2'],
    ]),
    fixes,
  );
  assert.ok(!fixed.anomalies.some((a) => a.kind === 'house_corrected'));
  assert.equal(house(fixed, 'F-12'), 'H-22');
});

test('a setCluster fix moves a household into the right cluster only while the sheet is wrong', () => {
  const fixes = { setCluster: [{ farmUnit: 'F-36', cluster: 'H2', was: 'H1-B' }] };
  const wrong = buildMemberRegister(tabs([['10', 'Tara Bose', 'F-36', 'H1-B', 'H-14', 'DO1']]), fixes);
  assert.equal(wrong.households[0].cluster, 'H2');
  assert.ok(wrong.anomalies.some((a) => a.kind === 'cluster_corrected' && a.farmUnit === 'F-36'));
  const right = buildMemberRegister(tabs([['10', 'Tara Bose', 'F-36', 'H2', 'H-14', 'DO1']]), fixes);
  assert.equal(right.households[0].cluster, 'H2');
  assert.ok(!right.anomalies.some((a) => a.kind === 'cluster_corrected'));
});

test('no fixes are applied unless they are passed in', () => {
  const r = buildMemberRegister(tabs([['12', 'Dev Sethi', 'F-12', 'H1-A', 'H-21', 'DF1-V2']]));
  assert.equal(r.households[0].house_no, 'H-21');
  assert.ok(!r.anomalies.some((a) => a.kind === 'house_corrected' || a.kind === 'cluster_corrected'));
});

test('an unmatchable patta row is an error, not silently attached', () => {
  const r = buildMemberRegister(
    tabs(
      [['1', 'A One', 'F-01', 'H2', 'H-10', 'S1']],
      [['Zed Unknown', 'F-99', 'H-99', '', '1', '1/1', '', '1.00', '']],
    ),
  );
  assert.equal(r.plots.length, 0);
  assert.ok(r.anomalies.some((a) => a.kind === 'patta_unmatched' && a.severity === 'error'));
});

test('placeholder patta rows (all blank, area 0.00) add no plot but flag the gap', () => {
  const r = buildMemberRegister(
    tabs([['1', 'A One', 'F-01', 'H2', 'H-10', 'S1']], [['A One', 'F-01', 'H-10', '', '', '', '', '0.00', '']]),
  );
  assert.equal(r.plots.length, 0);
  assert.ok(r.anomalies.some((a) => a.kind === 'household_without_farm_patta' && a.farmUnit === 'F-01'));
});

test('a repeated unit + survey + patta row is kept once', () => {
  const row = ['A One', 'F-01', 'H-10', '', '1971', '466/2A', '0.4', '1.00', ''];
  const r = buildMemberRegister(tabs([['1', 'A One', 'F-01', 'H2', 'H-10', 'S1']], [row, row]));
  assert.equal(r.plots.length, 1);
  assert.ok(r.anomalies.some((a) => a.kind === 'patta_duplicate_row'));
});

test('flags a patta number that disagrees with its reference number', () => {
  const r = buildMemberRegister(
    tabs([['1', 'A One', 'F-01', 'H2', 'H-10', 'S1']], [['A One', 'F-01', 'H-10', 'P/31/12/081/02741/90134', '2417', '457/2', '0.5', '1.26', '']]),
  );
  assert.ok(r.anomalies.some((a) => a.kind === 'patta_number_mismatch' && a.farmUnit === 'F-01'));
});

test('house patta rows and the patta-issue flag come through', () => {
  const r = buildMemberRegister(
    tabs(
      [['29', 'Gita Kapoor', 'F-42', 'H1-B', 'H-50', 'S3', '2010', '', 'Gita K', 'Yes']],
      [],
      [['Gita K', '2015', 'F-42', 'H-50', 'P/31/12/081/02015/90111', '478 / 3B', '1.59', '1711.46', '']],
    ),
  );
  assert.equal(r.housePattas.length, 1);
  assert.equal(r.housePattas[0].area_sq_ft, 1711.46);
  assert.deepEqual(r.notes, [{ farmUnit: 'F-42', kind: 'patta_issue', note: null }]);
});

test('anomaly text never contains an email address', () => {
  const r = buildMemberRegister(tabs([['1', 'A One', 'F-01', 'H2', 'H-10', 'S1', '', '', 'secret@example.com']]));
  assert.ok(!JSON.stringify(r.anomalies).includes('secret@example.com'));
});
