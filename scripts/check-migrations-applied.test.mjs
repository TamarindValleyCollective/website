// Run with: node --test scripts/check-migrations-applied.test.mjs (tests scripts/lib/migration-check.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationNameFromFile, findUnapplied } from './lib/migration-check.mjs';

test('migrationNameFromFile strips the number and extension', () => {
  assert.equal(
    migrationNameFromFile('supabase/migrations/0061_revoke_anon_authenticated_table_grants.sql'),
    'revoke_anon_authenticated_table_grants',
  );
  assert.equal(migrationNameFromFile('supabase/migrations/20261024121424_Some_Name.sql'), 'some_name');
});

test('migrationNameFromFile ignores anything that is not a migration', () => {
  assert.equal(migrationNameFromFile('supabase/homeassistant/seed.sql'), null);
  assert.equal(migrationNameFromFile('supabase/migrations/README.md'), null);
});

test('findUnapplied reports only the files with no recorded migration', async () => {
  const result = await findUnapplied({
    changedFiles: [
      'supabase/migrations/0061_revoke_x.sql',
      'supabase/migrations/0063_new_thing.sql',
      'src/pages/index.astro',
    ],
    fetchApplied: async () => [
      { version: '20261024121424', name: 'revoke_x' },
      { version: '20261024122254', name: 'move_extensions_out_of_public' },
    ],
  });
  assert.equal(result.checked, 2);
  assert.deepEqual(result.unapplied.map((u) => u.name), ['new_thing']);
});

test('findUnapplied does not call the database when no migration changed', async () => {
  const result = await findUnapplied({
    changedFiles: ['README.md'],
    fetchApplied: async () => {
      throw new Error('should not be called');
    },
  });
  assert.deepEqual(result, { checked: 0, unapplied: [] });
});

test('findUnapplied matches names case-insensitively', async () => {
  const result = await findUnapplied({
    changedFiles: ['supabase/migrations/0064_Add_Thing.sql'],
    fetchApplied: async () => [{ version: '1', name: 'add_thing' }],
  });
  assert.deepEqual(result.unapplied, []);
});
