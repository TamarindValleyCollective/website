// Fails when a PR adds or changes a migration in supabase/migrations/ that is not recorded
// as applied on the live Supabase project, so "merged but never applied" (which broke
// passkeys on 0030) is caught before the merge. Run by
// .github/workflows/check-migrations-applied.yml; see ARCHITECTURE.md.
//
// Usage: node scripts/check-migrations-applied.mjs [base-branch]   (default: main)
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and migration 0063
// (applied_migrations()) applied to the project.
import { execFileSync } from 'node:child_process';
import { restHeaders } from './lib/supabase.mjs';
import { findUnapplied } from './lib/migration-check.mjs';

const base = process.argv[2] || 'main';

const changedFiles = execFileSync(
  'git',
  ['diff', '--name-only', '--diff-filter=AM', `origin/${base}...HEAD`, '--', 'supabase/migrations'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean);

async function fetchApplied() {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/applied_migrations`, {
    method: 'POST',
    headers: restHeaders(),
    body: '{}',
  });
  if (!res.ok) {
    throw new Error(
      `applied_migrations() failed with HTTP ${res.status}. Is migration 0063 applied to the project?`,
    );
  }
  return res.json();
}

const { checked, unapplied } = await findUnapplied({ changedFiles, fetchApplied });

if (checked === 0) {
  console.log('No migration files added or changed in this PR.');
} else if (unapplied.length === 0) {
  console.log(`All ${checked} migration(s) in this PR are applied to the live project.`);
} else {
  for (const { file, name } of unapplied) {
    console.log(`::error file=${file}::Not applied to the live project (no recorded migration named "${name}").`);
  }
  console.error(
    `\n${unapplied.length} of ${checked} migration(s) are not applied. Apply each to the project ` +
      `(apply_migration, or \`supabase db push\`) before merging; the name recorded must match the ` +
      `file name without its number.`,
  );
  process.exit(1);
}
