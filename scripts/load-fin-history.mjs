// Operator script: loads the Google Sheet's funds transfer tracker into the finance ledger (docs/finance/sessions/06-history-load.md).
// It reads the tracker, reads the imported bank lines, pairs them, works out the allocations the sheet's labels imply, and prints COUNTS
// only: never a name, narration, account number or amount. By default it is a DRY RUN that writes nothing. --apply writes the allocations
// (posted, source "import") one bank line at a time through fin_save_allocations; a line that already has allocations is skipped, so running
// it again changes nothing. Needs migration 0084 (the maintenance year and household columns) applied first.
//
//   netlify dev:exec -- node scripts/load-fin-history.mjs --sheet <spreadsheetId> [--tab "<tab name>"] [--since 2024-04-01] [--out review.csv]
//   netlify dev:exec -- node scripts/load-fin-history.mjs --sheet <spreadsheetId> [--tab ...] [--since ...] --apply
//
// The sheet id is passed in (or FIN_HISTORY_SHEET_ID), never kept in this public repo, and the sheet must be shared with the Drive
// service account (as for scripts/import-fin-parties.mjs). `netlify dev:exec` injects SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the
// service-account key. --out writes a review file of sheet row numbers, dates, directions, amounts and labels for the rows and lines
// that did not match (no narrations or names), for the directors to go through; keep it out of the repository.
import { writeFileSync } from 'node:fs';
import { getSheetValues } from './lib/google-drive.mjs';
import { restHeaders } from './lib/supabase.mjs';
import { applyPlans, matchTracker, parseTracker, planAllocations } from './lib/finance-history.mjs';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sheetId = arg('--sheet') ?? process.env.FIN_HISTORY_SHEET_ID;
const tab = arg('--tab') ?? 'Funds Transfer Tracker (2024-27)';
const since = arg('--since') ?? '2024-04-01';
const out = arg('--out');
if (!sheetId || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error('Usage: netlify dev:exec -- node scripts/load-fin-history.mjs --sheet <spreadsheetId> [--tab "<tab>"] [--since YYYY-MM-DD] [--out review.csv]');
  process.exit(2);
}
const apply = args.includes('--apply');

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

const tally = (items, f) => items.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
const show = (o, min = 1) => Object.entries(o).filter(([, v]) => v >= min).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k || '(blank)'}: ${v}`).join('  ');
const fyOf = (date) => (date.slice(5, 7) >= '04' ? Number(date.slice(0, 4)) : Number(date.slice(0, 4)) - 1);

const grid = await getSheetValues(sheetId, `'${tab}'!A:W`);
const { rows: allRows, problems } = parseTracker(grid);
const rows = allRows.filter((r) => r.date >= since);
const lines = await pages(`/fin_bank_lines?select=id,tran_date,narration,direction,amount_paise,upi_rrn&tran_date=gte.${since}&order=tran_date.asc,id.asc`);
const allocated = new Set((await pages('/fin_allocations?select=bank_line_id&order=id.asc')).map((a) => a.bank_line_id));

const m = matchTracker(rows, lines);
console.log(`Tracker "${tab}" from ${since}: ${rows.length} usable rows (${allRows.length - rows.length} earlier ones ignored), ${problems.length} row(s) that could not be read.`);
console.log(`Bank lines from ${since}: ${lines.length}, of which ${lines.filter((l) => allocated.has(l.id)).length} already have allocations.`);
console.log('');
console.log('Matched to a bank line:');
console.log(`  one-to-one on date, direction and amount: ${m.counts.exact}  (a choice between identical amounts on ${m.counts.ambiguous})`);
console.log(`  salary-style groups (many rows = one line): ${m.counts.grouped} lines, covering ${m.counts.groupedRows} rows`);
console.log(`  by the bank's 12-digit reference on another date: ${m.counts.reference}`);
console.log(`  same amount within 5 days (approximate): ${m.counts.nearDate}`);
const matchedRows = m.counts.exact + m.counts.groupedRows + m.counts.reference + m.counts.nearDate;
console.log(`  => ${matchedRows} of ${rows.length} tracker rows (${((100 * matchedRows) / rows.length).toFixed(1)}%) and ${m.pairs.length + m.groups.length} of ${lines.length} bank lines`);
console.log('');
console.log(`Left over: ${m.unmatchedRows.length} tracker rows, ${m.unmatchedLines.length} bank lines.`);
console.log(`  tracker rows left, by financial year: ${show(tally(m.unmatchedRows, (r) => `${fyOf(r.date)}-${String(fyOf(r.date) + 1).slice(2)}`))}  | by direction: ${show(tally(m.unmatchedRows, (r) => r.direction))}`);
console.log(`  tracker rows left, by Details: ${show(tally(m.unmatchedRows, (r) => r.details))}`);
console.log(`  bank lines left, by direction: ${show(tally(m.unmatchedLines, (l) => l.direction))}  | by month: ${show(tally(m.unmatchedLines, (l) => l.tran_date.slice(0, 7)))}`);
console.log('');
const matchedRowList = [...m.pairs.map((p) => p.row), ...m.groups.flatMap((g) => g.rows)];
console.log(`Labels on the matched rows (Type): ${show(tally(matchedRowList, (r) => r.type))}`);
console.log(`Labels on the matched rows (Details): ${show(tally(matchedRowList, (r) => r.details))}`);
console.log(`Matched rows with no Details: ${matchedRowList.filter((r) => !r.details).length}; with no Type: ${matchedRowList.filter((r) => !r.type).length}`);
if (problems.length) console.log(`Unreadable rows (sheet row numbers): ${problems.map((p) => `${p.sheetRow} (${p.reason})`).join('; ')}`);

// ---- what the labels turn into
const categories = await pages('/fin_categories?select=id,name,active&order=id.asc');
const parties = (await pages('/fin_parties?select=id,name,kind,active,merged_into&order=id.asc')).filter((p) => p.active && !p.merged_into);
const names = await pages('/member_people?select=id,full_name&order=id.asc');
const links = await pages('/member_household_members?select=household_id,person_id&order=person_id.asc,household_id.asc');
const nameOf = new Map(names.map((p) => [p.id, p.full_name]));
const people = links.filter((l) => nameOf.get(l.person_id)).map((l) => ({ id: l.person_id, name: nameOf.get(l.person_id), household_id: l.household_id }));
const plan = planAllocations(m, { categories, parties, people });
console.log('');
console.log(`Plan: ${plan.plans.length} bank lines get ${plan.counts.allocations} allocations.`);
console.log(`  by category: ${show(plan.counts.byCategory)}`);
console.log(`  a party was found in the register for ${plan.counts.partyMatched} of them (${plan.counts.partyNotMatched} left with no party)`);
console.log(`  member maintenance paid for an EARLIER year than the one it was paid in: ${plan.counts.maintenanceArrears}; maintenance with no household found: ${plan.counts.maintenanceWithoutHousehold}`);
console.log(`  Farm Project rows (Project bucket, placeholder project per financial year): ${plan.counts.projectRows}; Farm Capex rows put in a default capital category: ${plan.counts.defaulted}`);
console.log(`  sent to review because the match was approximate: ${plan.plans.filter((x) => x.rows.some((r) => r.review_state === 'needs_review')).length}`);
console.log(`Left unallocated for a person: ${plan.skipped.length} lines (${show(tally(plan.skipped, (x) => x.kind))}); by label: ${show(tally(plan.skipped, (x) => x.label))}`);

if (apply) {
  const probe = await fetch(`${process.env.SUPABASE_URL}/rest/v1/fin_allocations?select=maintenance_year,household_id&limit=1`, { headers: restHeaders() });
  if (!probe.ok) {
    console.error('\nMigration 0084 (maintenance_year and household_id on fin_allocations) is not applied yet. Apply it first. Nothing was written.');
    process.exit(1);
  }
  const entity = (await pages('/fin_entities?select=id&order=created_at.asc'))[0]?.id;
  const call = async (path, init) => {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1${path}`, { ...init, headers: restHeaders(init?.headers) });
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path.split('?')[0]} failed: ${res.status}`);
    return res;
  };
  const PROJECT_NAME = 'Farm projects (details to add)';
  const store = {
    async allocatedLineIds() {
      return new Set((await pages('/fin_allocations?select=bank_line_id&order=id.asc')).map((a) => a.bank_line_id));
    },
    // A placeholder per financial year, until the real projects (owner, approval, breakdown) are recorded.
    async projectFor(fy) {
      const found = await (await call(`/fin_projects?select=id&entity_id=eq.${entity}&financial_year=eq.${fy}&name=eq.${encodeURIComponent(PROJECT_NAME)}`)).json();
      if (found[0]) return found[0].id;
      const made = await (await call('/fin_projects', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ entity_id: entity, name: PROJECT_NAME, kind: 'project', financial_year: fy, status: 'proposed', notes: 'Created by the history load for the sheet\'s "Farm Project" rows. Add the real project details.' }) })).json();
      return made[0].id;
    },
    async save(lineId, rows) {
      await call('/rpc/fin_save_allocations', { method: 'POST', body: JSON.stringify({ p_line_id: lineId, p_rows: rows, p_actor: null, p_post: true, p_override: false }) });
    },
  };
  console.log('\nApplying...');
  const result = await applyPlans(plan.plans, store);
  console.log(`Saved ${result.saved} lines; skipped ${result.skippedExisting} that already had allocations; ${result.failed.length} failed.`);
  if (result.failed.length) console.log(`Failed lines (bank line ids): ${result.failed.map((f) => `${f.lineId} (${f.error})`).join('; ')}`);
  await call('/fin_audit_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ entity_id: entity, actor_id: null, action: 'finance.history_loaded', target: tab, detail: { since, saved: result.saved, skippedExisting: result.skippedExisting, failed: result.failed.length, allocations: plan.counts.allocations, leftUnallocated: plan.skipped.length } }) });
} else {
  console.log('\nDry run: nothing was written. Add --apply to write these allocations.');
}

if (out) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const money = (p) => (p / 100).toFixed(2);
  const lineRows = [
    ['kind', 'sheet row or bank line id', 'date', 'direction', 'amount', 'Details', 'Type', 'why it is here'],
    ...problems.map((p) => ['tracker row', p.sheetRow, '', '', '', '', '', p.reason]),
    ...m.unmatchedRows.map((r) => ['tracker row', r.sheetRow, r.date, r.direction, money(r.amountPaise), r.details, r.type, 'no bank line matched']),
    ...m.unmatchedLines.map((l) => ['bank line', l.id, l.tran_date, l.direction, money(l.amount_paise), '', '', 'no tracker row matched']),
    ...plan.householdWanted.map((w) => ['tracker row', w.sheetRow, '', '', '', `Maintenance (${w.maintenanceYear})`, '', 'loaded, but no household found for the payer: attribute it by hand']),
    ...plan.skipped.map((x) => ['tracker row', x.sheetRow, '', '', '', x.label, '', `matched, but left unallocated: ${x.reason}`]),
    ...m.pairs.filter((p) => p.how !== 'exact').map((p) => ['tracker row', p.row.sheetRow, p.row.date, p.row.direction, money(p.row.amountPaise), p.row.details, p.row.type, `matched approximately (${p.how}) to a line dated ${p.line.tran_date}`]),
  ];
  writeFileSync(out, lineRows.map((r) => r.map(q).join(',')).join('\n') + '\n');
  console.log(`\nReview file written: ${out} (${lineRows.length - 1} lines). It holds amounts and dates: keep it out of the repository.`);
}
