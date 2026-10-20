// Generates the SQL that seeds member_stories from the public Members-page cards.
//
//   node scripts/seed-member-stories.mjs --out /path/outside/the/repo [--overrides overrides.json]
//
// Writes seed-preview.sql (read-only: shows which household each card matched),
// seed-diagnose.sql (read-only: for cards that matched nothing, which farm plots their names
// appear in, with no register names), seed-verify.sql (read-only: who each name on a pinned
// card matched; shows register names, for your eyes only) and seed-apply.sql (writes the stories) and seed-photos.sql (then attaches each card's existing public
// photo to the people seeded from it) and seed-cards.sql (records which household each public card is, in
// member_cards, for the public export; covers every card, including the ones that are only a name).
// An override is a plot ("F-12") or { "plot": "F-12", "names": { "om": "omshivaprakash" } }. Run the preview in the TVC ERP SQL editor first; if
// any card is not "matched", pin it to a farm plot with an overrides file
// {"Card Name": "F-12"} and regenerate. Then run seed-apply.sql. See
// scripts/lib/member-story-seed.mjs for how cards become stories.
//
// The SQL holds only the public card text (matching to people happens in the database), but
// the overrides file names a household, so keep it outside the repo too.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { legacyMembers as members } from '../src/data/members.ts'; // the 2017 cards, not the merged list
import { buildSeedSql, normalizeOverrides, seedCards } from './lib/member-story-seed.mjs';

const args = process.argv.slice(2);
const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const out = arg('--out');
if (!out) {
  console.error('Usage: node scripts/seed-member-stories.mjs --out DIR [--overrides overrides.json]');
  process.exit(2);
}
const overridesPath = arg('--overrides');
const overrides = overridesPath ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {};

const cards = seedCards(members);
const known = new Set(members.map((m) => m.name));
normalizeOverrides(overrides); // validates the shape before anything is written
for (const name of Object.keys(overrides)) if (!known.has(name)) console.error(`Warning: override for "${name}" matches no card name.`);

mkdirSync(out, { recursive: true });
for (const mode of ['preview', 'diagnose', 'verify', 'apply', 'photos']) writeFileSync(join(out, `seed-${mode}.sql`), buildSeedSql(cards, { mode, overrides }));
// The card mapping covers every card, including the ones that are only a name.
writeFileSync(join(out, 'seed-cards.sql'), buildSeedSql(seedCards(members, { includeEmpty: true }), { mode: 'cards', overrides }));
console.log(`${cards.length} of ${members.length} cards have text to seed (${members.length - cards.length} are just a name).`);
console.log(`Wrote seed-preview.sql, seed-diagnose.sql, seed-verify.sql, seed-apply.sql, seed-photos.sql and seed-cards.sql to ${out}. Run the preview first; seed-photos.sql and seed-cards.sql go last.`);
