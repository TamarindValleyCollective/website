// Operator script: gives every person in the member records a finance party (docs/finance/FINANCE.md, "Member parties").
// By default a DRY RUN: it reads the member records and the parties, works out the plan, and prints COUNTS (never a name) and writes nothing.
// --apply carries the plan out: it creates the missing member parties and links the existing ones, one row at a time, and a person who already
// has a party is never touched, so running it again changes nothing. Needs migration 0085 applied first (it checks). --canary N does only the
// first N links and N creates, so the first real write can be checked by eye; the full run afterwards skips them.
//
//   netlify dev:exec -- node scripts/backfill-member-parties.mjs [--include-inactive] [--answers answers.csv] [--out worklist.csv]
//   netlify dev:exec -- node scripts/backfill-member-parties.mjs [--include-inactive] [--answers answers.csv] [--canary 2] --apply
//
// --answers reads "party name,person name" lines for parties whose name is not the one in the member records (a bank prints a full name or a label);
// a person's answer beats any name guess. Keep that file out of the repository.
//
// --out writes the cases a person has to decide (same name twice, a same-named party of another kind, member parties that match nobody, people
// with no household) with names as stored. It is for the directors only: keep it out of the repository.
import { readFileSync, writeFileSync } from 'node:fs';
import { restHeaders } from './lib/supabase.mjs';
import { applyMemberPlan, parseAnswers, planMemberParties, summarise } from './lib/finance-member-parties.mjs';

const args = process.argv.slice(2);
const includeInactive = args.includes('--include-inactive');
const answersFile = args.includes('--answers') ? args[args.indexOf('--answers') + 1] : undefined;
const apply = args.includes('--apply');
const canary = args.includes('--canary') ? Number(args[args.indexOf('--canary') + 1]) : 0;
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;

async function pages(path) {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1${path}&limit=1000&offset=${offset}`, { headers: restHeaders() });
    if (!res.ok) throw new Error(`Supabase GET ${path.split('?')[0]} failed: ${res.status}`);
    const page = await res.json();
    all.push(...page);
    if (page.length < 1000) return all;
  }
}

// person_id exists only once migration 0085 is applied: a dry run works without it, an apply refuses to start without it.
const hasPersonColumn = (await fetch(`${process.env.SUPABASE_URL}/rest/v1/fin_parties?select=person_id&limit=1`, { headers: restHeaders() })).ok;
if (apply && !hasPersonColumn) {
  console.error('Migration 0085_finance_member_parties.sql is not applied yet (fin_parties.person_id is missing). Apply it first.');
  process.exit(1);
}
const [peopleRows, links, partyRows] = await Promise.all([
  pages('/member_people?select=id,full_name,active&order=id.asc'),
  pages('/member_household_members?select=person_id,household_id&order=person_id.asc'),
  pages(`/fin_parties?select=id,name,kind,active,household_id${hasPersonColumn ? ',person_id' : ''}&active=eq.true&merged_into=is.null&order=id.asc`),
]);
const householdsOf = new Map();
for (const l of links) householdsOf.set(l.person_id, [...(householdsOf.get(l.person_id) ?? []), l.household_id]);
const people = peopleRows.map((p) => ({ id: p.id, name: p.full_name, active: p.active, householdIds: householdsOf.get(p.id) ?? [] }));
const parties = partyRows.map((p) => ({ id: p.id, name: p.name, kind: p.kind, active: p.active, householdId: p.household_id, personId: p.person_id ?? null }));

const plan = planMemberParties({ people, parties, includeInactive, answers: answersFile ? parseAnswers(readFileSync(answersFile, 'utf8')) : [] });
const c = summarise(plan);
console.log(`Member records: ${people.length} people (${people.filter((p) => p.active).length} active), ${new Set(links.map((l) => l.household_id)).size} households with people.`);
console.log(`Parties now: ${parties.length} active, of which ${parties.filter((p) => p.kind === 'member').length} are kind "member".`);
console.log('');
console.log(`Would CREATE a member party for ${c.create} people.`);
console.log(`Would LINK ${c.link} existing member parties to the person with the same name.`);
console.log(`Already linked: ${c.alreadyLinked}.${includeInactive ? '' : ` Skipped as inactive: ${c.skippedInactive} (use --include-inactive to include them).`}`);
console.log('');
console.log('Need a person to decide (nothing is done for these):');
console.log(`  answers that name nobody, or somebody twice: ${c.badAnswers}`);
console.log(`  two people with the same name: ${c.sameNamePeople}`);
console.log(`  a person whose name matches two parties: ${c.sameNameParties}`);
console.log(`  a person whose name matches a party of another kind: ${c.otherKind}`);
console.log(`  member parties that match no person: ${c.unmatchedMemberParties}`);
console.log(`  people with no household (they still get a party, with no unit): ${c.noHousehold}`);
console.log(`  people in two households (the first is used): ${c.twoHouseholds}`);
console.log('');
if (!apply) console.log('Nothing was written. Add --apply to write (after migration 0085 is applied).');

if (out) {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [
    ...plan.sameNamePeople.map((p) => ['same name, two people', p.name, '']),
    ...plan.sameNameParties.map((x) => ['name matches two parties', x.person.name, x.parties.length]),
    ...plan.otherKind.map((x) => ['name matches a party of another kind', x.person.name, x.party.kind]),
    ...plan.unmatchedMemberParties.map((p) => ['member party matches no person', p.name, '']),
    ...plan.noHousehold.map((p) => ['person has no household', p.name, '']),
  ];
  writeFileSync(out, ['what,name,detail', ...rows.map((r) => r.map(q).join(','))].join('\n') + '\n');
  console.log(`Wrote ${rows.length} rows to ${out} (keep it out of the repository).`);
}

if (apply) {
  const rest = (path, options = {}) => fetch(`${process.env.SUPABASE_URL}/rest/v1${path}`, { ...options, headers: restHeaders(options.headers) });
  const entity = (await (await rest('/fin_entities?select=id&order=created_at.asc&limit=1')).json())[0]?.id;
  if (!entity) throw new Error('No finance entity found; is migration 0077 applied?');
  const io = {
    create: async ({ personId, name, householdId }) => {
      const res = await rest('/fin_parties', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ entity_id: entity, kind: 'member', name, household_id: householdId, person_id: personId }) });
      if (res.status === 409) return 'exists'; // unique person_id: somebody got there first
      if (!res.ok) throw new Error(`create failed: ${res.status}`);
      return 'created';
    },
    link: async ({ partyId, personId, householdId }) => {
      const res = await rest(`/fin_parties?id=eq.${partyId}&person_id=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ person_id: personId, household_id: householdId, updated_at: new Date().toISOString() }) });
      if (!res.ok) throw new Error(`link failed: ${res.status}`);
      return (await res.json()).length ? 'linked' : 'skipped';
    },
  };
  const done = await applyMemberPlan(plan, io, { canary });
  console.log('');
  console.log(`${canary ? `CANARY (${canary} of each kind): ` : ''}created ${done.created}, linked ${done.linked}, already there ${done.alreadyThere}, failed ${done.failed}.`);
  await rest('/fin_audit_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ entity_id: entity, action: 'finance.member_parties_backfilled', detail: { created: done.created, linked: done.linked, alreadyThere: done.alreadyThere, failed: done.failed, canary } }) });
  const after = await pages('/fin_parties?select=id&active=eq.true&person_id=not.is.null&order=id.asc');
  console.log(`Member parties linked to a person now: ${after.length}. Run the dry run again to see what is left.`);
}
