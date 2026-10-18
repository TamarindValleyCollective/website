// One-time (re-runnable) import of the member register from the "TVC Spend
// Summary" workbook into the TVC ERP member_* tables. See
// scripts/lib/member-import.mjs for the mapping and docs/plans/member-portal.md.
//
//   node scripts/import-members.mjs --from tabs.json            # dry run (default)
//   node scripts/import-members.mjs --from tabs.json --apply    # write to Supabase
//   ... --fixes fixes.json   # optional private corrections (see member-import.mjs)
//
// tabs.json is { "Member Master": [[...]], "Farm Patta Details": [[...]],
// "House Patta Details": [[...]] } — the three tabs' cell values as rows.
// Produce it with scripts/export-member-sheet.mjs, which also reads the emails
// out of Member Master's people chips (column I). It contains PII, so keep it
// out of the repo.
//
// The dry run prints counts and anomalies (names are not printed, never
// emails). --apply needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and
// migration 0040 applied to the project. Re-running updates in place (rows are
// keyed on farm_unit / import_key), and never touches rows created in the
// portal.
import { readFileSync } from 'node:fs';
import { buildMemberRegister, summarize } from './lib/member-import.mjs';
import { restHeaders } from './lib/supabase.mjs';

const args = process.argv.slice(2);
const from = args[args.indexOf('--from') + 1];
const apply = args.includes('--apply');
if (!args.includes('--from') || !from) {
  console.error('Usage: node scripts/import-members.mjs --from tabs.json [--apply]');
  process.exit(2);
}

const fixesPath = args.includes('--fixes') ? args[args.indexOf('--fixes') + 1] : null;
const fixes = fixesPath ? JSON.parse(readFileSync(fixesPath, 'utf8')) : {};
const register = buildMemberRegister(JSON.parse(readFileSync(from, 'utf8')), fixes);
console.log(JSON.stringify(summarize(register), null, 2));

const order = { error: 0, warn: 1, info: 2 };
const shown = register.anomalies
  .filter((a) => a.kind !== 'people_without_email')
  .sort((a, b) => order[a.severity] - order[b.severity] || (a.farmUnit ?? '').localeCompare(b.farmUnit ?? ''));
console.log('\nAnomalies (errors and warnings need a person; info is FYI):');
for (const a of shown) console.log(`  [${a.severity}] ${a.farmUnit ?? '-'} ${a.kind}: ${a.detail}`);

if (!apply) {
  console.log('\nDry run only. Nothing was written. Re-run with --apply to write.');
  process.exit(0);
}

async function upsert(table, rows, onConflict) {
  if (!rows.length) return [];
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table} upsert failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const households = await upsert('member_households', register.households, 'farm_unit');
const unitId = new Map(households.map((h) => [h.farm_unit, h.id]));

const people = await upsert(
  'member_people',
  register.people.map((p) => ({ import_key: p.importKey, full_name: p.full_name, email: p.email })),
  'import_key',
);
const personId = new Map(people.map((p) => [p.import_key, p.id]));

await upsert(
  'member_household_members',
  register.people.map((p) => ({ household_id: unitId.get(p.farmUnit), person_id: personId.get(p.importKey), role: 'owner' })),
  'household_id,person_id',
);
await upsert(
  'member_plots',
  register.plots.map(({ farmUnit, importKey, ...rest }) => ({ ...rest, import_key: importKey, household_id: unitId.get(farmUnit) })),
  'import_key',
);
await upsert(
  'member_house_pattas',
  register.housePattas.map(({ farmUnit, importKey, ...rest }) => ({ ...rest, import_key: importKey, household_id: unitId.get(farmUnit) })),
  'import_key',
);
await upsert(
  'member_household_notes',
  register.notes.map((n) => ({ household_id: unitId.get(n.farmUnit), kind: n.kind, note: n.note })),
  'household_id,kind',
);
console.log(`\nWrote ${households.length} households, ${people.length} people, ${register.plots.length} farm plots, ${register.housePattas.length} house pattas.`);
