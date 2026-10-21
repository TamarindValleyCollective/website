// Read-only preview of moving member stories from one record per person to one per unit.
//
//   node scripts/preview-unit-stories.mjs --in units.json [--out preview.txt]
//
// units.json is the result of scripts/unit-stories-export.sql. It holds real names and story text, so
// keep it and the report OUTSIDE the repo (the repo is public). It applies the same tested rules the
// real backfill will (scripts/lib/member-unit-story.mjs) and prints, per unit that would be merged
// from differing text, whose copy wins, so you can overrule it before anything is applied.
import { readFileSync, writeFileSync } from 'node:fs';
import { MAX_PHOTOS, buildUnitStory } from './lib/member-unit-story.mjs';

const args = process.argv.slice(2);
const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const input = arg('--in');
if (!input) {
  console.error('Usage: node scripts/preview-unit-stories.mjs --in units.json [--out preview.txt]');
  process.exit(2);
}
const units = JSON.parse(readFileSync(input, 'utf8'));

const KINDS = [
  { copy: 'approved', at: 'approved_at', label: 'approved (live)' },
  { copy: 'draft', at: 'updated_at', label: 'draft' },
  { copy: 'submitted', at: 'submitted_at', label: 'in review', only: (r) => r.status === 'in_review' },
];
const t = (v) => (typeof v === 'string' ? v.trim() : '');
const filled = (c) => c && typeof c === 'object' && ['bio', 'family', 'why', 'social', 'photo'].some((k) => t(c[k]));
const snippet = (s, n = 110) => (s.length > n ? `${s.slice(0, n)}…` : s || '(empty)');

const lines = [];
const out = (s = '') => lines.push(s);
let single = 0;
let identical = 0;
let diverged = 0;
let photosDropped = 0;
const divergedBlocks = [];

for (const u of units) {
  const result = buildUnitStory(u.rows);
  const label = (id) => u.rows.find((r) => r.person_id === id)?.label ?? id;
  const pooled = new Set(u.rows.map((r) => t(r.approved?.photo)).filter(Boolean));
  if (pooled.size > MAX_PHOTOS) photosDropped += 1;
  if (!result.diverged) {
    if (u.rows.filter((r) => filled(r.approved)).length > 1) identical += 1;
    else single += 1;
    continue;
  }
  diverged += 1;
  const block = [`${u.farm_unit}`];
  for (const k of KINDS) {
    const copies = u.rows.filter((r) => (k.only ?? (() => true))(r) && filled(r[k.copy]));
    const texts = new Set(copies.map((r) => JSON.stringify([t(r[k.copy].bio), t(r[k.copy].family)])));
    if (texts.size < 2) continue;
    const winner = copies.find((r) => r.person_id === result.winners[k.copy]);
    // Equal timestamps on copies that differ: "newest wins" is then arbitrary, so say so.
    const tie = copies.some((r) => r !== winner && r[k.at] === winner[k.at] && JSON.stringify([t(r[k.copy].bio), t(r[k.copy].family)]) !== JSON.stringify([t(winner[k.copy].bio), t(winner[k.copy].family)]));
    block.push(`  ${k.label}: ${label(result.winners[k.copy])}'s copy wins (${winner[k.at]})${tie ? '  ** TIE: same timestamp, pick by hand **' : ''}`);
    for (const f of ['bio', 'family']) {
      const values = copies.map((r) => t(r[k.copy][f]));
      if (new Set(values).size < 2) continue;
      // Show each person's text from just before the first place the copies differ.
      let i = 0;
      while (values.every((v) => v[i] === values[0][i])) i += 1;
      block.push(`    ${f} differs (first difference at character ${i}):`);
      for (const r of copies) block.push(`      ${r.label}: …${snippet(t(r[k.copy][f]).slice(Math.max(0, i - 30)), 140)}`);
    }
  }
  divergedBlocks.push(block.join('\n'));
}

out(`Units with a story: ${units.length}`);
out(`  one person with a story:       ${single}`);
out(`  same text across the unit:     ${identical}`);
out(`  text differs (diverged):       ${diverged}`);
out(`  units with more than ${MAX_PHOTOS} photos: ${photosDropped} (the ${MAX_PHOTOS} newest are kept; the rest stay in storage, unlinked)`);
if (divergedBlocks.length) {
  out();
  out('Diverged units: the newest copy supplies the shared text. Each person keeps their own quote.');
  out();
  for (const b of divergedBlocks) {
    out(b);
    out();
  }
}
const report = lines.join('\n');
const dest = arg('--out');
if (dest) {
  writeFileSync(dest, `${report}\n`);
  console.log(`Wrote ${dest} (${units.length} units, ${diverged} diverged). Keep it outside the repo.`);
} else {
  console.log(report);
}
