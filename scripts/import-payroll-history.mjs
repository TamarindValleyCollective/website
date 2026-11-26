// Operator script: splits old salary bank debits into one Salaries allocation per person, from the PayPro upload files
// (docs/finance/sessions/09-payroll.md, the history import). By default a DRY RUN: it prints months, counts and totals only (never a
// name or account number) and writes nothing. --apply saves each planned line through fin_save_allocations (posted, source "import");
// a line that already has allocations is never touched, so running it again changes nothing.
//
//   netlify dev:exec -- node scripts/import-payroll-history.mjs --files <folder of .xlsx PayPro files>
//   netlify dev:exec -- node scripts/import-payroll-history.mjs --files <folder> --aliases <aliases.csv> [--apply]
//
// --aliases is a two-column file kept OUTSIDE the repository: the name as written in the PayPro file, then the exact name of the employee
// party it means. It decides the cases name matching cannot (a spelling error in the file). A party name that is not exactly one active
// employee party stops the run.
//
// The folder holds only the files to import, as .xlsx (convert an old .xls first). Keep it outside the repository: the files hold
// real names and account numbers. `netlify dev:exec` injects SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkbook } from './lib/finance-xlsx.mjs';
import { monthOfBatch, parsePayproRows, planSalaryHistory } from './lib/finance-payroll-history.mjs';
import { restHeaders } from './lib/supabase.mjs';

const args = process.argv.slice(2);
const dir = args.includes('--files') ? args[args.indexOf('--files') + 1] : undefined;
if (!dir) {
  console.error('Usage: netlify dev:exec -- node scripts/import-payroll-history.mjs --files <folder of .xlsx files> [--apply]');
  process.exit(2);
}
const apply = args.includes('--apply');
const aliasFile = args.includes('--aliases') ? args[args.indexOf('--aliases') + 1] : undefined;

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
const rupees = (paise) => (paise / 100).toLocaleString('en-IN');

const batches = [];
for (const f of readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.xlsx')).sort()) {
  const rows = readWorkbook(readFileSync(join(dir, f)))[0]?.rows ?? [];
  const month = monthOfBatch(rows, f);
  if (!month) {
    console.log(`Skipped a file with no readable salary month (${f.replace(/\d/g, '#').slice(0, 30)}).`);
    continue;
  }
  batches.push({ label: month, month, entries: parsePayproRows(rows) });
}
batches.sort((a, b) => a.month.localeCompare(b.month));

const category = (await pages('/fin_categories?select=id,name,active&name=eq.Salaries&order=id.asc'))[0];
if (!category?.active) {
  console.error('The ledger has no active "Salaries" category. Nothing was done.');
  process.exit(1);
}
const lines = await pages('/fin_bank_lines?select=id,tran_date,direction,amount_paise&direction=eq.debit&order=tran_date.asc,id.asc');
const allocatedLineIds = new Set((await pages('/fin_allocations?select=bank_line_id&order=id.asc')).map((a) => a.bank_line_id));
const parties = await pages('/fin_parties?select=id,name,kind&kind=eq.employee&active=eq.true&merged_into=is.null&order=id.asc');

const aliases = [];
if (aliasFile) {
  for (const line of readFileSync(aliasFile, 'utf8').split(/\r?\n/).filter((l) => l.trim())) {
    const [from, to] = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim());
    const hits = parties.filter((p) => p.name.trim().toLowerCase() === to?.toLowerCase());
    if (hits.length !== 1) {
      console.error(`An alias points at a party that is not exactly one active employee party (${hits.length} found). Nothing was done.`);
      process.exit(1);
    }
    aliases.push({ name: from, partyId: hits[0].id });
  }
  console.log(`${aliases.length} alias(es) read.`);
}
const plan = planSalaryHistory({ batches, lines, allocatedLineIds, categoryId: category.id, parties, aliases });
console.log(`${batches.length} file(s) read; ${parties.length} active employee parties in the register.\n`);
console.log('month     people  matched to a party  total        bank debit date');
for (const p of plan.plans) {
  const total = p.rows.reduce((s, r) => s + r.amount_paise, 0);
  const line = lines.find((l) => l.id === p.lineId);
  console.log(`${p.label}   ${String(p.rows.length).padStart(4)}   ${String(p.rows.filter((r) => r.party_id).length).padStart(10)}          ${rupees(total).padStart(9)}    ${line.tran_date}`);
}
for (const u of plan.unplaced) console.log(`${u.label}   NOT PLACED: ${u.reason}`);
console.log(`\nPlan: ${plan.counts.planned} bank lines get ${plan.counts.allocations} Salaries allocations (${plan.counts.withParty} with a party, ${plan.counts.withoutParty} with none).`);
const perParty = new Map();
for (const p of plan.plans) for (const r of p.rows) perParty.set(r.party_id, (perParty.get(r.party_id) ?? 0) + 1);
console.log('\nRows per party (register names; "no party" = left empty):');
for (const [id, n] of [...perParty].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${id ? parties.find((x) => x.id === id)?.name : 'no party'}`);
console.log(`Not placed: ${plan.counts.noLine} with no matching debit, ${plan.counts.ambiguous} with more than one, ${plan.counts.alreadyAllocated} already allocated.`);

if (!apply) {
  console.log('\nDry run: nothing was written. Add --apply to write these allocations.');
} else {
  const entity = (await pages('/fin_entities?select=id&order=created_at.asc'))[0]?.id;
  const call = async (path, init) => {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1${path}`, { ...init, headers: restHeaders(init?.headers) });
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path.split('?')[0]} failed: ${res.status}`);
    return res;
  };
  let saved = 0;
  const failed = [];
  for (const p of plan.plans) {
    try {
      await call('/rpc/fin_save_allocations', { method: 'POST', body: JSON.stringify({ p_line_id: p.lineId, p_rows: p.rows, p_actor: null, p_post: true, p_override: false }) });
      saved++;
    } catch (err) {
      failed.push(`${p.label}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nSaved ${saved} lines; ${failed.length} failed.${failed.length ? `\n${failed.join('\n')}` : ''}`);
  await call('/fin_audit_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ entity_id: entity, actor_id: null, action: 'finance.payroll_history_loaded', target: 'salary batches', detail: { saved, failed: failed.length, allocations: plan.counts.allocations } }) });
}
