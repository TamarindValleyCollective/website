import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Runs the real CLI with no Supabase variables in the environment, so nothing
// here can reach a database: the only commands that can succeed are the ones
// that need none (`issue --print-sql`) and the ones that fail before any I/O.
const SCRIPT = new URL('./partner-key.mjs', import.meta.url).pathname;
const run = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });

test('a mistyped flag stops the command and suggests the right one', () => {
  const r = run('issue', 'linger', 'Linger production', '--expires', '2027-10-01', '--print-sq');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown flag "--print-sq"\. Did you mean --print-sql\?/);
  assert.equal(r.stdout, '', 'nothing printed, so no key could have been shown');
});

test('an unrelated unknown flag is refused too', () => {
  const r = run('issue', 'linger', 'k', '--bogus');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown flag "--bogus"\./);
  assert.doesNotMatch(r.stderr, /Did you mean/);
});

test('--expires needs a date', () => {
  for (const args of [['issue', 'linger', 'k', '--expires'], ['issue', 'linger', 'k', '--expires', '--print-sql']]) {
    const r = run(...args);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--expires needs a date/);
  }
});

test('the flags only apply to issue', () => {
  const r = run('keys', '--print-sql');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /only apply to the "issue" command/);
});

test('issue --print-sql works offline and prints only the hash in the SQL', () => {
  const r = run('issue', 'linger', "Linger O'Brien", '--expires', '2027-10-01', '--print-sql');
  assert.equal(r.status, 0, r.stderr);
  const key = r.stdout.split('\n').find((l) => /^tvcp_[A-Za-z0-9_-]{43}$/.test(l));
  assert.ok(key, 'the key is printed once');
  const hash = createHash('sha256').update(key).digest('hex');
  assert.ok(r.stdout.includes(`'${hash}'`), 'the SQL carries the key hash');
  assert.equal(r.stdout.split(key).length - 1, 1, 'the key appears exactly once, and not in the SQL');
  assert.ok(r.stdout.includes(`'${key.slice(0, 9)}'`), 'the SQL carries the prefix');
  assert.ok(r.stdout.includes("'Linger O''Brien'"), 'quotes in the name are escaped');
  assert.ok(r.stdout.includes("'2027-10-01T00:00:00.000Z'"));
  assert.match(r.stdout, /insert into partner_api_keys/);
});

test('each issue produces a different key', () => {
  const keys = [1, 2].map(() => run('issue', 'linger', 'k', '--print-sql').stdout.split('\n').find((l) => l.startsWith('tvcp_')));
  assert.notEqual(keys[0], keys[1]);
});

test('without --print-sql and without database access, issue fails safely', () => {
  const r = run('issue', 'linger', 'k');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing SUPABASE_URL/);
  assert.ok(!/tvcp_[A-Za-z0-9_-]{43}/.test(r.stdout + r.stderr), 'no key is printed when nothing was stored');
});

test('a partner id that is not allowed is refused before anything else', () => {
  const r = run('issue', 'Not_Valid', 'k', '--print-sql');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /partnerId must be/);
});
