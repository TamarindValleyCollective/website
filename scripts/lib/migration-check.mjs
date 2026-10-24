// Logic for scripts/check-migrations-applied.mjs: given the migration files a PR adds or
// changes, which of them have not been applied to the live Supabase project?
//
// Files are numbered (0061_revoke_x.sql) but Supabase records an applied migration under a
// timestamp version and the bare name ("revoke_x"), so a file counts as applied when a
// recorded migration has that bare name. Only the files a PR touches are checked: about 17
// older files were applied by hand and never recorded, so the full history can't be matched.

const MIGRATION_FILE = /^supabase\/migrations\/(?:\d+_)?(.+)\.sql$/;

export function migrationNameFromFile(path) {
  const match = MIGRATION_FILE.exec(path);
  return match ? match[1].toLowerCase() : null;
}

export async function findUnapplied({ changedFiles, fetchApplied }) {
  const wanted = changedFiles
    .map((file) => ({ file, name: migrationNameFromFile(file) }))
    .filter((entry) => entry.name);
  if (wanted.length === 0) return { checked: 0, unapplied: [] };

  const applied = new Set((await fetchApplied()).map((row) => String(row.name ?? '').toLowerCase()));
  return {
    checked: wanted.length,
    unapplied: wanted.filter((entry) => !applied.has(entry.name)),
  };
}
