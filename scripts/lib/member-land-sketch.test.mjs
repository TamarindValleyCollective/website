// Run with: node --test scripts/lib/member-land-sketch.test.mjs
// Stand-alone FMB sketches (see member-land-docs.mjs). Made-up survey numbers only: this repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { surveyOnRegister, surveyChoices, surveyShapeKey, shapeForRecord } from './member-land-docs.mjs';

test('a sketch can only be for a survey number the card holds, however it is typed', () => {
  const rows = [{ survey_no: '450/3C' }, { survey_no: '12/1A, 12/1B' }];
  assert.equal(surveyOnRegister('450/3C', rows), true);
  assert.equal(surveyOnRegister(' 450 / 3c ', rows), true);
  assert.equal(surveyOnRegister('12/1B', rows), true, 'one of several on a record');
  assert.equal(surveyOnRegister('450/3', rows), false, 'a different sub-division');
  assert.equal(surveyOnRegister('', rows), false);
  assert.equal(surveyOnRegister('450/3C', []), false);
});

test('a card offers its survey numbers one at a time, each once', () => {
  assert.deepEqual(surveyChoices([{ survey_no: '12/1A, 12/1B' }, { survey_no: '12/1b' }, { survey_no: null }]), ['12/1A', '12/1B']);
});

test("a record shows its own patta's outline first, then a sketch filed under its survey number", () => {
  const shapes = { 'doc-1': 'data:own', [surveyShapeKey('12/1B')]: 'data:sketch' };
  assert.equal(shapeForRecord(shapes, '12/1A', 'doc-1'), 'data:own');
  assert.equal(shapeForRecord(shapes, '12/1A, 12/1B', null), 'data:sketch', 'no patta behind the record');
  assert.equal(shapeForRecord(shapes, '12/1b', 'doc-9'), 'data:sketch', 'its patta has no outline of its own');
  assert.equal(shapeForRecord(shapes, '99/9', 'doc-9'), null);
  assert.equal(shapeForRecord({}, null, null), null);
});
