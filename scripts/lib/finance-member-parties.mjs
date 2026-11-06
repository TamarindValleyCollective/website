// Plans the member backfill (docs/finance/FINANCE.md, "Member parties"): every person in the member records should have a party, linked to
// them and to their household, so a payer is found by picking a member and the unit follows. Pure and I/O-free so it is tested on invented
// data (finance-member-parties.test.mjs); scripts/backfill-member-parties.mjs reads the database and prints the plan as COUNTS.
//
// people:  [{ id, name, active, householdIds: [uuid, ...] }]   (member_people, with their member_household_members rows)
// parties: [{ id, name, kind, active, householdId, personId }]  (fin_parties, active and not merged away)
//
// Names are matched the way the rest of finance matches them (normaliseName: case, punctuation and company suffixes ignored). Nothing is merged,
// renamed or re-kinded: a name that cannot be matched with certainty is listed for a person to decide.
import { normaliseName } from './finance-suggest.mjs';

/**
 * A person's answers for parties whose name is not the one in the member records (the bank prints a full name, a short name or a label):
 * "party name,person name" per line, an optional header row. Returns [{ partyName, personName }].
 */
export function parseAnswers(text) {
  const cells = (line) => [...line.matchAll(/("([^"]|"")*"|[^,]*)(,|$)/g)].map((m) => m[1].replace(/^"|"$/g, '').replace(/""/g, '"').trim()).slice(0, 2);
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(cells)
    .filter(([a, b], i) => a && b && !(i === 0 && /^party/i.test(a)))
    .map(([partyName, personName]) => ({ partyName, personName }));
}

export function planMemberParties({ people, parties, includeInactive = false, answers = [] }) {
  const plan = { badAnswers: [], create: [], link: [], alreadyLinked: [], skippedInactive: [], needsAPerson: [], noHousehold: [], twoHouseholds: [], sameNamePeople: [], sameNameParties: [], otherKind: [], unmatchedMemberParties: [] };

  const byPersonLink = new Map(parties.filter((p) => p.personId).map((p) => [p.personId, p]));
  const peopleByName = new Map();
  for (const person of people) {
    const key = normaliseName(person.name);
    peopleByName.set(key, [...(peopleByName.get(key) ?? []), person]);
  }
  const partiesByName = new Map();
  for (const party of parties.filter((p) => !p.personId)) {
    const key = normaliseName(party.name);
    partiesByName.set(key, [...(partiesByName.get(key) ?? []), party]);
  }

  // A person's own answer beats any guess: it ties a party to a person whatever the two are called.
  const forced = new Map();
  const matchedParties = new Set();
  for (const a of answers) {
    const candidates = people.filter((p) => normaliseName(p.name) === normaliseName(a.personName));
    const found = parties.filter((p) => !p.personId && normaliseName(p.name) === normaliseName(a.partyName));
    if (candidates.length !== 1 || found.length !== 1 || forced.has(candidates[0].id)) plan.badAnswers.push(a);
    else forced.set(candidates[0].id, found[0]);
  }
  for (const person of people) {
    if (!person.active && !includeInactive) {
      plan.skippedInactive.push(person);
      continue;
    }
    const households = [...new Set(person.householdIds ?? [])];
    if (!households.length) plan.noHousehold.push(person);
    if (households.length > 1) plan.twoHouseholds.push(person);
    const householdId = households[0] ?? null;

    if (byPersonLink.has(person.id)) {
      plan.alreadyLinked.push({ person, party: byPersonLink.get(person.id) });
      continue;
    }
    if (forced.has(person.id)) {
      const party = forced.get(person.id);
      if (party.kind === 'member') {
        plan.link.push({ partyId: party.id, personId: person.id, householdId: households[0] ?? null });
        matchedParties.add(party.id);
      } else plan.otherKind.push({ person, party });
      continue;
    }
    const key = normaliseName(person.name);
    if (peopleByName.get(key).length > 1) {
      plan.sameNamePeople.push(person); // two people called the same: a name cannot say which
      continue;
    }
    const same = partiesByName.get(key) ?? [];
    if (same.length > 1) {
      plan.sameNameParties.push({ person, parties: same });
      continue;
    }
    if (same.length === 1) {
      const party = same[0];
      if (party.kind === 'member') {
        plan.link.push({ partyId: party.id, personId: person.id, householdId });
        matchedParties.add(party.id);
      } else {
        plan.otherKind.push({ person, party }); // e.g. a vendor with the same name: not turned into a member without a person deciding
      }
      continue;
    }
    plan.create.push({ personId: person.id, name: person.name.trim().replace(/\s+/g, ' '), householdId });
  }
  for (const party of parties) if (party.kind === 'member' && !party.personId && !matchedParties.has(party.id)) plan.unmatchedMemberParties.push(party);
  return plan;
}

/** The counts the script prints: never a name. */
export function summarise(plan) {
  return Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length]));
}

/**
 * Carries out a plan through `io` (the script passes the database; the tests pass fakes), one row at a time so one failure stops nothing else:
 *   io.create({ personId, name, householdId }) -> 'created' | 'exists'     (throws on any other failure)
 *   io.link({ partyId, personId, householdId }) -> 'linked' | 'skipped'    ('skipped': that party already has a person)
 * `canary` limits it to the first few rows of each kind so the first real write can be checked by eye. Returns counts only.
 */
export async function applyMemberPlan(plan, io, { canary = 0 } = {}) {
  const take = (list) => (canary > 0 ? list.slice(0, canary) : list);
  const done = { created: 0, linked: 0, alreadyThere: 0, failed: 0 };
  for (const row of take(plan.link)) {
    try {
      if ((await io.link(row)) === 'linked') done.linked++;
      else done.alreadyThere++;
    } catch {
      done.failed++;
    }
  }
  for (const row of take(plan.create)) {
    try {
      if ((await io.create(row)) === 'created') done.created++;
      else done.alreadyThere++;
    } catch {
      done.failed++;
    }
  }
  return done;
}
