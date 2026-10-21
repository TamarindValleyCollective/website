// Run with: node --test scripts/lib/member-land-docs.test.mjs
// Made-up people and numbers only: this repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLandPdfText, areaFromHaAres, normalizeExtraction, normalizeSurveyNo, namesMatch, reconcile, documentStatus,
  newRecordColumns, approvalColumns, memberSummary, documentsReplacedBy, surveyKey, landTypeMismatch,
} from './member-land-docs.mjs';

const raw = (over = {}) => ({
  document_type: 'land_record',
  village: 'Examplepuram',
  records: [{ survey_no: ' 123 / 4a ', patta_no: '0777', area_hectares: 0, area_ares: 35.22 }],
  owners: ['ASHA RAO', 'Ravi Rao'],
  digitally_signed: true,
  ...over,
});
const extraction = (over) => normalizeExtraction(raw(over)).extraction;
const people = ['Asha Rao', 'Ravi Rao'];
const run = (existing, extra = {}) => reconcile({
  extraction: extraction(), landType: 'farm', household: { peopleNames: people }, existing, heldElsewhere: new Set(), autoVerify: true, ...extra,
});
const plot = (over = {}) => ({ id: 'r1', survey_no: '123/4A', patta_no: '777', reference_no: null, area_hectares: '0.3522', area_acres: '0.87', settlement: 'Examplepuram', ...over });

test('area is hectare-are, not the tax column', () => {
  assert.deepEqual(areaFromHaAres(0, 35.22), { hectares: 0.3522, acres: 0.87, sqFt: 37910 });
  assert.equal(areaFromHaAres(0, 2.88).sqFt, 3100); // a 3,100 sq ft house plot
  assert.equal(areaFromHaAres(null, null), null);
  assert.equal(areaFromHaAres(1, 50).hectares, 1.5);
});

test('survey numbers compare across spacing, case and dash', () => {
  assert.equal(normalizeSurveyNo(' 450 - 3c '), '450/3C');
  assert.equal(normalizeSurveyNo('471/2A/'), '471/2A');
});

test('normalizeExtraction rejects other documents and files with no survey number', () => {
  assert.equal(normalizeExtraction(raw({ document_type: 'other' })).ok, false);
  assert.equal(normalizeExtraction(raw({ records: [] })).ok, false);
  assert.equal(normalizeExtraction(raw({ records: [{ survey_no: 'n/a' }] })).ok, false);
  assert.equal(normalizeExtraction(null).ok, false);
});

test('normalizeExtraction cleans values and takes the patta number from a reference when blank', () => {
  const e = extraction({ records: [{ survey_no: '9/1', reference_no: 'P/31/12/081/02812/90143', area_ares: 2.88 }, { survey_no: '9/1' }] });
  assert.equal(e.records.length, 1); // duplicate survey number collapsed
  assert.equal(e.records[0].pattaNo, '2812');
  assert.equal(e.records[0].areaSqFt, 3100);
  assert.deepEqual(e.owners, ['ASHA RAO', 'Ravi Rao']);
});

test('names tolerate transliteration and extra words', () => {
  assert.ok(namesMatch('Aravind Krishnan', 'ARAVINDH KRISHNAN KUMAR'));
  assert.ok(namesMatch('Asha Rao', 'ASHA RAO'));
  assert.ok(!namesMatch('Asha Rao', 'Meera Rao'));
  assert.ok(!namesMatch('Sam', 'Samuel')); // short words need an exact match
  assert.ok(!namesMatch('', 'Asha'));
});

test('names written in Tamil and transliterated into English match across the usual spelling variants', () => {
  // Each pair is one name as the register has it and as the e-Services PDF printed it.
  const pairs = [
    ['Omshivaprakash HL', 'OMSIVAPRAKAS'], // sh / s, a dropped final letter, initials
    ['Lakshmi Narayanan', 'LAXMI NARAYANAN'], // ksh / x
    ['Sivakumar', 'Shivakumar'], // sh / s
    ['Pazhani', 'Palani'], // zh / l
    ['Thiagarajan', 'Tyagarajan'], // th / t, i / y
    ['Chandran', 'Sandran'], // ch / s
    ['Krishnamoorthy', 'KRISHNAMURTHI'], // oo / u, y / i
    ['Veeramani', 'Viramani'], // ee / i
    ['Vijayalakshmi', 'VIJAYALAXMI'],
    ['Murugesan', 'MURUGESSAN'], // a doubled letter
  ];
  for (const [a, b] of pairs) assert.ok(namesMatch(a, b), `${a} / ${b}`);
});

test('initials in a name stand for the words they were made from: HS is Hosahalli Subramani', () => {
  // The register keeps "Gopalakrishna HS"; the PDF spells the family names out. Made-up names.
  assert.ok(namesMatch('Gopalakrishna HS', 'GOPALAKRISHNA HOSAHALLI SUBRAMANI'));
  assert.ok(namesMatch('GOPALAKRISHNA HOSAHALLI SUBRAMANI', 'Gopalakrishna HS')); // either way round
  assert.ok(namesMatch('Ravi KS', 'RAVI KOTTUR SUBBU RAO')); // the run of words need not be the last ones
  assert.ok(namesMatch('Ravi S', 'RAVI SUBBU')); // a single initial was already fine
});

test('initials never make a match on their own, and must be the right letters', () => {
  assert.ok(!namesMatch('Ravi KS', 'RAVI HARISH SUBBU')); // K is not H
  assert.ok(!namesMatch('Ravi HS', 'ASHA HARISH SUBBU')); // the first word has to match too
  assert.ok(!namesMatch('Sa', 'SATISH ANAND')); // a short name is not initials
  assert.ok(!namesMatch('Sa Kumar', 'SATISH ANAND')); // 'sa' is not S.A., because 'kumar' matched nothing
  assert.ok(!namesMatch('HS', 'HARISH SUBBU')); // initials alone prove nothing
});

test('names that are actually different people still do not match', () => {
  assert.ok(!namesMatch('Venkatesh Rao', 'Venkatesan Rao')); // two letters apart is a different name
  assert.ok(!namesMatch('Asha Rao', 'Meera Rao'));
  assert.ok(!namesMatch('Ravi', 'Ravindra')); // a short name is not a prefix of a longer one
  assert.ok(!namesMatch('Murugan', 'Muthukumar'));
  assert.ok(!namesMatch('Sam', 'Samuel'));
});

test('an agreeing document verifies the existing record and fills only blanks', () => {
  const [item] = run([plot({ area_hectares: null, area_acres: null, patta_no: '777' })]);
  assert.equal(item.outcome, 'verified');
  assert.equal(item.recordId, 'r1');
  assert.deepEqual(item.fill, { area_hectares: 0.3522, area_acres: 0.87 });
  assert.equal(documentStatus([item]), 'applied');
});

test('values already in the register are never overwritten by a verification', () => {
  const [item] = run([plot({ area_hectares: '0.3530', area_acres: '0.87' })]); // within 1%
  assert.equal(item.outcome, 'verified');
  assert.deepEqual(item.fill, {});
});

test('a different patta number or area is a mismatch and changes nothing', () => {
  const [a] = run([plot({ patta_no: '999' })]);
  assert.equal(a.outcome, 'mismatch');
  assert.deepEqual(a.differences.map((d) => d.field), ['patta_no']);
  const [b] = run([plot({ area_hectares: '0.5', area_acres: null })]);
  assert.deepEqual(b.differences.map((d) => d.field), ['area']);
  assert.equal(documentStatus([a]), 'needs_review');
});

test('owner names that match nobody in the household do not block a record the register already holds', () => {
  // The names on the PDF are a transliteration from Tamil and cannot be trusted to match: the survey number,
  // patta and area are what say this document is about the household's own land.
  const [item] = run([plot()], { household: { peopleNames: ['Someone Else'] } });
  assert.equal(item.outcome, 'verified');
  assert.equal(item.ownerMatch, false); // still recorded, so an admin can see the names did not match
  assert.ok(!item.differences.some((d) => d.field === 'owners'));
});

test('an owner-name difference never hides a real one, and a photo is still never verified on its own', () => {
  const [wrongPatta] = run([plot({ patta_no: '999' })], { household: { peopleNames: ['Someone Else'] } });
  assert.equal(wrongPatta.outcome, 'mismatch');
  assert.deepEqual(wrongPatta.differences.map((d) => d.field), ['patta_no']);
  const [photo] = run([plot()], { household: { peopleNames: ['Someone Else'] }, autoVerify: false });
  assert.equal(photo.outcome, 'check');
});

test('a photo or scan is never verified on its own', () => {
  const [item] = run([plot()], { autoVerify: false });
  assert.equal(item.outcome, 'check');
  assert.equal(documentStatus([item]), 'needs_review');
});

test('no entry in the register: a new pending record that always waits for the core team', () => {
  const [item] = run([]);
  assert.equal(item.outcome, 'pending');
  assert.equal(item.ownerMatch, true);
  assert.equal(documentStatus([item]), 'needs_review');
  assert.equal(documentStatus([{ ...item, decision: 'approved' }]), 'applied'); // admin decided
  const [stranger] = run([], { household: { peopleNames: ['Someone Else'] } });
  assert.equal(stranger.ownerMatch, false);
});

test('a survey number held by another household is a conflict, not a new record', () => {
  const [item] = run([], { heldElsewhere: new Set(['123/4A']) });
  assert.equal(item.outcome, 'conflict');
  assert.equal(documentStatus([item]), 'needs_review');
});

test('a register entry with several survey numbers still matches', () => {
  const [item] = run([plot({ survey_no: '100/1, 123/4A' })]);
  assert.equal(item.outcome, 'verified');
});

test('house records compare square feet', () => {
  const ex = extraction({ records: [{ survey_no: '55/7', patta_no: '12', area_ares: 2.88 }] });
  const house = { id: 'h1', survey_no: '55/7', patta_no: null, reference_no: null, area_sq_ft: '3100.00', settlement: null };
  const [ok] = reconcile({ extraction: ex, landType: 'house', household: { peopleNames: people }, existing: [house], heldElsewhere: new Set(), autoVerify: true });
  assert.equal(ok.outcome, 'verified');
  assert.deepEqual(ok.fill, { patta_no: '12', settlement: 'Examplepuram' });
  const [bad] = reconcile({ extraction: ex, landType: 'house', household: { peopleNames: people }, existing: [{ ...house, area_sq_ft: '1200' }], heldElsewhere: new Set(), autoVerify: true });
  assert.equal(bad.outcome, 'mismatch');
});

test('new-record and approval columns', () => {
  const [item] = run([]);
  const cols = newRecordColumns(item, 'farm', extraction(), 'hh1', 'doc1');
  assert.equal(cols.verification, 'pending_review');
  assert.equal(cols.source_document_id, 'doc1');
  assert.equal(cols.area_hectares, 0.3522);
  const approved = approvalColumns({ ...item, referenceNo: null }, 'farm', 'doc1', '2026-10-19T00:00:00Z');
  assert.equal(approved.verification, 'verified');
  assert.equal(approved.verification_source, 'staff');
  assert.ok(!('reference_no' in approved)); // a missing value never blanks a field
});

test('member summaries name no one', () => {
  const items = [{ outcome: 'verified' }, { outcome: 'pending' }, { outcome: 'mismatch' }];
  assert.equal(memberSummary('needs_review', items), '1 record verified; 1 new record added, waiting for the core team to confirm; 1 sent to the core team to check');
  assert.equal(memberSummary('failed', [], 'Nope'), 'Nope');
  assert.match(memberSummary('applied', [{ outcome: 'pending', decision: 'rejected' }]), /1 record was not accepted by the core team/);
  assert.equal(memberSummary('applied', [{ outcome: 'check', decision: 'approved' }]), '1 record verified');
});

// Text shaped like what the PDFs really give (control characters and lost Tamil signs included),
// with made-up numbers and names.
const ilrPage1 = 'மாவ\u0004ட\u0006 : Integrated Land Record (Integrated Land Record)\n123/4A 0 P ரய&\'வா \u001a ைச - 0 8-8-2 0.76 0.0-35.22 0.76 777 ,பா அெல\u00141\n2019/0105/31/178893 --';
const chitta = [
  'தமிழ்நாடு அரசு\nவருவாய் கிராமம் : தக்கட்டி பட்டா எண் : 888\nஉரிைமயாளர்கள் ெபயர்\n1. Asha Rao மகன் RAMA RAO -\n2. RAVI RAO மைனவி ASHA RAO -\n' +
  'புல எண் உட்பிரிவு\n55 7 0 - 2.88 0.06 -- -- -- --\n2026/0105/31/033286-\nDigitally signed:Someone P\n10/07/2026\n0 - 2.88 0.06\n' +
  'குறிப்பு : https://eservices.tn.gov.in P/31/12/081/00888/90143 என்ற குறிப்பு',
  '',
];

test('reads an Integrated Land Record row, ignoring the assessment columns', () => {
  const raw = parseLandPdfText([ilrPage1, 'page two']);
  assert.deepEqual(raw.records, [{ survey_no: '123/4A', area_hectares: 0, area_ares: 35.22, patta_no: '777' }]);
  const e = normalizeExtraction(raw).extraction;
  assert.equal(e.records[0].areaHectares, 0.3522);
  assert.deepEqual(e.owners, []); // Tamil owner names are not readable
});

test('reads a chitta: patta, English owners, summed area, land reference', () => {
  const raw = parseLandPdfText(chitta);
  assert.equal(raw.records.length, 1);
  assert.deepEqual(raw.records[0], { survey_no: '55/7', patta_no: '888', area_hectares: 0, area_ares: 2.88, reference_no: 'P/31/12/081/00888/90143' });
  assert.deepEqual(raw.owners, ['Asha Rao', 'RAVI RAO']);
});

test('a chitta with dry, wet and other land adds the columns up', () => {
  const t = chitta[0].replace('55 7 0 - 2.88 0.06 -- -- -- --', '55 7 0 - 1.00 0.05 0 - 2.00 0.07 -- --').replace('0 - 2.88 0.06\n', '0 - 3.00 0.12\n');
  assert.equal(parseLandPdfText([t, '']).records[0].area_ares, 3);
});

test('a chitta whose sub-divisions end in a digit (4B2, 4C2) is read: each row is its own survey number', () => {
  // Made-up values in the shape of a real one: letters then a digit in the sub-division, a signature block after each row.
  const t = 'தமிழ்நாடு அரசு\nவருவாய் கிராமம் : தக்கட்டி பட்டா எண் : 1234\nஉரிைமயாளர்கள் ெபயர்\n1. Asha Rao மகன் RAMA RAO -\n' +
    'புல எண் உட்பிரிவு\n260 4B2 0 - 1.20 0.03 -- -- -- --\n2026/0105/31/000001-\nDigitally signed:Someone P\n30/03/2026\n' +
    '260 4C2 0 - 0.50 0.02 -- -- -- --\n2026/0105/31/000001-\nDigitally signed:Someone P\n30/03/2026\n0 - 1.70 0.05\n' +
    'குறிப்பு : https://eservices.tn.gov.in P/31/12/081/01234/90111 என்ற குறிப்பு';
  const raw = parseLandPdfText([t, '']);
  assert.deepEqual(raw.records.map((r) => [r.survey_no, r.area_ares, r.patta_no]), [['260/4B2', 1.2, '1234'], ['260/4C2', 0.5, '1234']]);
  const e = normalizeExtraction(raw).extraction;
  assert.deepEqual(e.records.map((r) => r.surveyNo), ['260/4B2', '260/4C2']);
});

test('an owner whose name wraps onto a second line is read as one name', () => {
  const t = 'தமிழ்நாடு அரசு\nவருவாய் கிராமம் : தக்கட்டி பட்டா எண் : 1234\nஉரிைமயாளர்கள் ெபயர்\n' +
    '1. ASHA RAO மகன் GOPALAKRISHNA HOSAHALLI\nSUBRAMANI\n-\n2. GOPALAKRISHNA HOSAHALLI\nSUBRAMANI மைன&MEERA RAO\n-\n' +
    'புல எண் உட்பிரிவு\n260 4B2 0 - 1.20 0.03 -- -- -- --\n0 - 1.20 0.03\n' +
    'குறிப்பு : https://eservices.tn.gov.in P/31/12/081/01234/90111 என்ற குறிப்பு';
  assert.deepEqual(parseLandPdfText([t, '']).owners, ['ASHA RAO', 'GOPALAKRISHNA HOSAHALLI SUBRAMANI']);
});

test('text that matches no template is not read', () => {
  assert.equal(parseLandPdfText(['Sale deed between two parties', '']), null);
  assert.equal(parseLandPdfText(['']), null);
  assert.equal(normalizeExtraction(null).error.includes('core team'), true);
});

test('unknown owners never block verifying a record the register already holds', () => {
  const ex = normalizeExtraction(parseLandPdfText([ilrPage1, ''])).extraction;
  const plot = { id: 'r1', survey_no: '123/4A', patta_no: '777', area_hectares: '0.3522' };
  const [v] = reconcile({ extraction: ex, landType: 'farm', household: { peopleNames: people }, existing: [plot], heldElsewhere: new Set(), autoVerify: true });
  assert.equal(v.outcome, 'verified');
  assert.equal(v.ownerMatch, null);
  const [n] = reconcile({ extraction: ex, landType: 'farm', household: { peopleNames: people }, existing: [], heldElsewhere: new Set(), autoVerify: true });
  assert.equal(n.outcome, 'pending'); // a new entry still waits for the core team
  assert.equal(documentStatus([n]), 'needs_review');
});

test('an unread file is summarised for the member', () => {
  assert.match(memberSummary('needs_review', []), /core team will check/);
});

// A chitta saved from a phone: the Tamil glyphs are scrambled, the numbers are not. Made-up values.
const phoneChitta = [
  'த"#நா& அர)\nவ+வா, Gராம0 : தNகFM பFடா எ7 : 4321\n1. அெல$ஸா\'ட) வ)+, மக/ 0பா அெல$,\n-\n' +
  '450 3C 0 - 10.50 0.76 -- -- -- --\n2019/0105/31/178893-\nDigitally\nsigned:Someone\n29/11/2019\n' +
  '450 5B 0 - 0.40 0.10 -- -- -- --\n2019/0105/31/162333-\n30/11/2019\n' +
  '471 2A 0 - 16.19 0.35 -- -- -- --\n2018/0105/31/106017-\n29/11/2019\n0 - 27.09 1.21\n' +
  'https://eservices.tn.gov.in எ9ற P/31/12/081/04321/80169 எ9ற',
];

test('reads a chitta with scrambled Tamil: patta from the reference, three rows, total checked', () => {
  const raw = parseLandPdfText(phoneChitta);
  assert.deepEqual(raw.records.map((r) => [r.survey_no, r.patta_no, r.area_ares]), [['450/3C', '4321', 10.5], ['450/5B', '4321', 0.4], ['471/2A', '4321', 16.19]]);
  assert.deepEqual(raw.owners, []);
});

test('a chitta whose rows do not add up to its printed total is not trusted', () => {
  assert.equal(parseLandPdfText([phoneChitta[0].replace('0 - 27.09 1.21', '0 - 99.99 1.21')]), null);
});

// ---- replacing an earlier upload ----
const doc = (over) => ({ id: 'd', sha256: 'aaa', land_type: 'farm', status: 'applied', created_at: new Date().toISOString(), extracted: { records: [{ surveyNo: '450/5B' }] }, ...over });

test('surveyKey is the same for the same survey numbers in any order, and null for none', () => {
  assert.equal(surveyKey({ records: [{ surveyNo: '450/5B' }, { surveyNo: '450/3C' }] }), surveyKey({ records: [{ surveyNo: '450/3C' }, { surveyNo: '450/5B' }] }));
  assert.equal(surveyKey({ records: [{ surveyNo: '450/5B' }] }), '450/5B');
  assert.equal(surveyKey({ records: [] }), null);
  assert.equal(surveyKey(null), null);
});

test('an upload replaces the same file, or the same survey numbers for the same kind of land', () => {
  const ids = (existing, over = {}) => documentsReplacedBy({ sha256: 'bbb', landType: 'farm', key: '450/5B', existing, ...over }).map((d) => d.id);
  assert.deepEqual(ids([doc({ id: 'again' })]), ['again'], 'a fresh download of the same extract has a different hash but the same survey numbers');
  assert.deepEqual(ids([doc({ id: 'same-file', sha256: 'bbb', extracted: null })]), ['same-file'], 'the identical file, even if it was never read');
  assert.deepEqual(ids([doc({ id: 'same-file-other-type', sha256: 'bbb', land_type: 'house' })]), ['same-file-other-type'], 'uploaded again under the other land type: the first was a mistake');
  assert.deepEqual(ids([doc({ id: 'other-survey', extracted: { records: [{ surveyNo: '471/2A' }] } })]), [], 'a different survey number is a different document');
  assert.deepEqual(ids([doc({ id: 'other-type', land_type: 'house' })]), [], 'same survey numbers but another kind of land is not replaced');
  assert.deepEqual(ids([doc({ id: 'multi', extracted: { records: [{ surveyNo: '450/5B' }, { surveyNo: '450/3C' }] } })]), [], 'a multi-survey patta is not the single-survey one');
});

test('a document still being read is left alone, unless it is stale; a photo with no reading matches by file only', () => {
  const fresh = doc({ id: 'busy', status: 'processing', created_at: new Date().toISOString() });
  const stale = doc({ id: 'stuck', status: 'processing', created_at: new Date(Date.now() - 3600_000).toISOString() });
  assert.deepEqual(documentsReplacedBy({ sha256: 'bbb', landType: 'farm', key: '450/5B', existing: [fresh, stale] }).map((d) => d.id), ['stuck']);
  assert.deepEqual(documentsReplacedBy({ sha256: 'bbb', landType: 'farm', key: null, existing: [doc({ id: 'x' })] }), [], 'no survey numbers to compare');
});

test('uploading the same document again does not verify a record still waiting for the core team', () => {
  const extraction = { owners: [], records: [{ surveyNo: '450/5B', pattaNo: '1954', areaHectares: 0.004, areaAcres: 0.01, areaSqFt: null, referenceNo: null }], village: null };
  const base = { extraction, landType: 'farm', household: { peopleNames: [] }, heldElsewhere: new Set(), autoVerify: true };
  const row = (verification) => ({ id: 'r', survey_no: '450/5B', patta_no: '1954', area_hectares: 0.004, area_acres: 0.01, verification });
  assert.equal(reconcile({ ...base, existing: [row('unverified')] })[0].outcome, 'verified');
  assert.equal(reconcile({ ...base, existing: [row('pending_review')] })[0].outcome, 'check');
});

test('a farm document uploaded on the House card is recognised: its survey numbers are only in the farm register', () => {
  const doc = extraction(); // 123/4A
  assert.deepEqual(landTypeMismatch({ landType: 'house', extraction: doc, farmRows: [plot()], houseRows: [] }), { actual: 'farm' });
});

test('a house document uploaded on the Farm card is recognised too', () => {
  assert.deepEqual(landTypeMismatch({ landType: 'farm', extraction: extraction(), farmRows: [], houseRows: [plot()] }), { actual: 'house' });
});

test('a document whose survey numbers are in the register of the card used is fine', () => {
  assert.equal(landTypeMismatch({ landType: 'farm', extraction: extraction(), farmRows: [plot()], houseRows: [] }), null);
  assert.equal(landTypeMismatch({ landType: 'house', extraction: extraction(), farmRows: [], houseRows: [plot()] }), null);
});

test('a document for land the household has no record of yet is fine on either card (a new parcel)', () => {
  const rows = [plot({ survey_no: '999/1' })];
  assert.equal(landTypeMismatch({ landType: 'house', extraction: extraction(), farmRows: rows, houseRows: rows }), null);
  assert.equal(landTypeMismatch({ landType: 'farm', extraction: extraction(), farmRows: [], houseRows: [] }), null);
});

test('a survey number held in both registers is not a mismatch', () => {
  assert.equal(landTypeMismatch({ landType: 'house', extraction: extraction(), farmRows: [plot()], houseRows: [plot()] }), null);
});

test('a register entry holding several survey numbers is matched number by number', () => {
  const rows = [plot({ survey_no: '123/3C, 123/4A' })];
  assert.deepEqual(landTypeMismatch({ landType: 'house', extraction: extraction(), farmRows: rows, houseRows: [] }), { actual: 'farm' });
});

test('survey numbers match whatever the spacing or case of the register entry', () => {
  assert.deepEqual(landTypeMismatch({ landType: 'house', extraction: extraction(), farmRows: [plot({ survey_no: ' 123 / 4a ' })], houseRows: [] }), { actual: 'farm' });
});

test('a document with several records: any one in the card used makes it fine; one in the other register and none in the card used does not', () => {
  const two = extraction({ records: [{ survey_no: '123/4A', patta_no: '0777', area_hectares: 0, area_ares: 35.22 }, { survey_no: '200/1', patta_no: '0777', area_hectares: 0, area_ares: 10 }] });
  assert.equal(landTypeMismatch({ landType: 'house', extraction: two, farmRows: [plot()], houseRows: [plot({ survey_no: '200/1' })] }), null);
  assert.deepEqual(landTypeMismatch({ landType: 'house', extraction: two, farmRows: [plot()], houseRows: [] }), { actual: 'farm' });
});
