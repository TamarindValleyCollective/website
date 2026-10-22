// Run with: node --test scripts/lib/whatsapp-assess.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL, INTENTS, LANGUAGES, QUESTION_VERSION, askJev, buildQuestions, buildState, isAssessable, parseAnswers } from './whatsapp-assess.mjs';

const goodResponse = () => ({
  model: 'jev-1.14.0',
  answers: {
    intent: { type: 'choice', choice: 'payment', confidence: 0.9, probabilities: { payment: 0.95, other: 0.05 } },
    language: { type: 'choice', choice: 'english', confidence: 0.99, probabilities: { english: 1 } },
    urgency: { type: 'score', score: 1.82, confidence: 0.7, probabilities: { 0: 0, 1: 0.18, 2: 0.82 } },
    needs_reply: { type: 'noul', noul: 0.95 },
  },
  usage: { input_tokens: 493, output_tokens: 106 },
});

test('the model is pinned to a version, not an alias', () => {
  assert.match(DEFAULT_MODEL, /^jev-\d+\.\d+\.\d+$/);
});

test('every question has what its type needs, and names match what parseAnswers reads', () => {
  const q = buildQuestions();
  assert.deepEqual(Object.keys(q).sort(), ['intent', 'language', 'needs_reply', 'urgency']);
  assert.deepEqual(Object.keys(q.intent.criteria), Object.keys(INTENTS));
  assert.deepEqual(Object.keys(q.language.criteria), Object.keys(LANGUAGES));
  assert.equal(q.urgency.criteria.length, 3);
  assert.equal(q.needs_reply.criteria, undefined);
  for (const question of Object.values(q)) assert.ok(question.instructions.length > 20);
});

test('state keeps the conversation and the judged message in separate named fields', () => {
  const state = buildState('Guest: hi\nTVC: hello', 'Is there parking?');
  assert.equal(state.latest_guest_message, 'Is there parking?');
  assert.equal(state.conversation, 'Guest: hi\nTVC: hello');
});

test('only messages with something typed or tapped are assessed', () => {
  assert.equal(isAssessable('text', 'hi'), true);
  assert.equal(isAssessable('button', '[Tapped button] I need help'), true);
  assert.equal(isAssessable('text', '   '), false);
  assert.equal(isAssessable('image', '[image message]'), false);
  assert.equal(isAssessable('audio', '[audio message]'), false);
  assert.equal(isAssessable('text', undefined), false);
});

test('a good response becomes a row', () => {
  const row = parseAnswers(goodResponse());
  assert.equal(row.model, 'jev-1.14.0');
  assert.equal(row.question_version, QUESTION_VERSION);
  assert.equal(row.intent, 'payment');
  assert.equal(row.language, 'english');
  assert.equal(row.urgency, 1.82);
  assert.equal(row.needs_reply, 0.95);
  assert.equal(row.input_tokens, 493);
});

test('a response with a missing or unknown answer is rejected, not stored half-filled', () => {
  assert.equal(parseAnswers(null), null);
  assert.equal(parseAnswers({ model: 'x' }), null);

  const unknownIntent = goodResponse();
  unknownIntent.answers.intent.choice = 'flirting';
  assert.equal(parseAnswers(unknownIntent), null);

  const missingNoul = goodResponse();
  delete missingNoul.answers.needs_reply;
  assert.equal(parseAnswers(missingNoul), null);

  const noModel = goodResponse();
  delete noModel.model;
  assert.equal(parseAnswers(noModel), null);
});

test('out-of-range numbers are rejected', () => {
  const highUrgency = goodResponse();
  highUrgency.answers.urgency.score = 3;
  assert.equal(parseAnswers(highUrgency), null);

  const negative = goodResponse();
  negative.answers.urgency.score = -0.1;
  assert.equal(parseAnswers(negative), null);

  const badNoul = goodResponse();
  badNoul.answers.needs_reply.noul = 1.5;
  assert.equal(parseAnswers(badNoul), null);
});

test('a bad confidence is dropped to null without discarding the read', () => {
  const r = goodResponse();
  r.answers.intent.confidence = 7;
  const row = parseAnswers(r);
  assert.equal(row.intent_confidence, null);
  assert.equal(row.intent, 'payment');
});

test('askJev sends the key, a pinned model and the state, and returns the body', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => goodResponse() };
  };
  const out = await askJev({ apiKey: 'k', state: { a: 1 }, questions: buildQuestions(), fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, DEFAULT_MODEL);
  assert.deepEqual(sent.state, { a: 1 });
});

test('askJev never throws: HTTP errors, timeouts and network failures come back as reasons', async () => {
  const http = await askJev({ apiKey: 'k', state: {}, questions: {}, fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.deepEqual(http, { ok: false, reason: 'http_429' });

  const timeout = await askJev({
    apiKey: 'k', state: {}, questions: {},
    fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); },
  });
  assert.deepEqual(timeout, { ok: false, reason: 'timeout' });

  const network = await askJev({ apiKey: 'k', state: {}, questions: {}, fetchImpl: async () => { throw new Error('down'); } });
  assert.deepEqual(network, { ok: false, reason: 'network' });
});
