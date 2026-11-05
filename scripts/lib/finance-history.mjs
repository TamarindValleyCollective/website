// Loading the Google Sheet's history into the ledger (docs/finance/sessions/06-history-load.md). Pure and I/O-free so it is tested
// directly (finance-history.test.mjs); scripts/load-fin-history.mjs reads the sheet and the database and calls these.
//
// The bank lines are already in the database (statement import, session 03), so nothing here creates a bank line. The funds
// transfer tracker carries what the statements do not: what each payment was for. So the job is to find, for every tracker row, the
// bank line it describes, and only then to turn the row's labels into an allocation on that line.
import { parsePaise } from './finance-cells.mjs';
import { matchParty, normaliseName } from './finance-suggest.mjs';

const REQUIRED = ['date', 'amount', 'transaction particulars', 'dr/cr'];
const text = (v) => String(v ?? '').trim();

// ---- reading the tracker
function parseDate(raw) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text(raw));
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
}

/**
 * Read the tracker's grid (row 1 is the heading) by heading name, not by position. Returns { rows, problems }: rows that can be used,
 * and the sheet row number and reason for every row that cannot (never guessed). A wholly blank row is skipped silently.
 */
export function parseTracker(grid) {
  const header = (grid[0] ?? []).map((h) => text(h).toLowerCase());
  const missing = REQUIRED.filter((h) => !header.includes(h));
  const shown = { date: 'Date', amount: 'Amount', 'transaction particulars': 'Transaction Particulars', 'dr/cr': 'DR/CR' };
  if (missing.length) throw new Error(`The tracker is missing the heading(s): ${missing.map((h) => shown[h]).join(', ')}.`);
  const col = (name) => header.indexOf(name);
  const get = (r, name) => (col(name) >= 0 ? text(r[col(name)]) : '');
  const rows = [];
  const problems = [];
  grid.slice(1).forEach((r, i) => {
    const sheetRow = i + 2;
    if (!r.some((c) => text(c))) return;
    const fail = (reason) => problems.push({ sheetRow, reason });
    const date = parseDate(get(r, 'date'));
    if (!date) return fail(get(r, 'date') ? 'The date is not day/month/year.' : 'No date.');
    if (!get(r, 'amount')) return fail('No amount.');
    let amountPaise;
    try {
      amountPaise = parsePaise(get(r, 'amount'));
    } catch {
      return fail('Amount cannot be read as rupees and paise.');
    }
    if (!(amountPaise > 0)) return fail('Amount is not more than zero.');
    const dir = get(r, 'dr/cr').toUpperCase();
    if (dir !== 'DR' && dir !== 'CR') return fail('DR/CR is neither DR nor CR.');
    const year = Number(get(r, 'year'));
    const month = Number(get(r, 'month'));
    const period = year >= 2000 && year <= 2100 && month >= 1 && month <= 12 ? `${year}-${String(month).padStart(2, '0')}-01` : `${date.slice(0, 7)}-01`;
    rows.push({
      sheetRow, date, amountPaise, direction: dir === 'DR' ? 'debit' : 'credit', particulars: get(r, 'transaction particulars'), period,
      details: get(r, 'details'), type: get(r, 'type'), remarks: get(r, 'remarks'), toName: get(r, 'to'), fromName: get(r, 'from'), mode: get(r, 'mode'),
      financialYear: get(r, 'financial year'),
    });
  });
  return { rows, problems };
}

// ---- matching rows to bank lines
/** The 12-digit UPI/IMPS reference inside a narration, and only that (a longer run of digits is something else). */
export const referenceOf = (s) => /(?<!\d)(\d{12})(?!\d)/.exec(String(s ?? ''))?.[1] ?? null;

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** How alike two narrations are, 0 to 1 (Dice coefficient on letter pairs, ignoring case and punctuation). */
export function similarity(a, b) {
  const [x, y] = [squash(a), squash(b)];
  if (x.length < 2 || y.length < 2) return x && x === y ? 1 : 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const [gx, gy] = [grams(x), grams(y)];
  let shared = 0;
  for (const [g, n] of gx) shared += Math.min(n, gy.get(g) ?? 0);
  return (2 * shared) / (x.length - 1 + (y.length - 1));
}

const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

/**
 * Pair tracker rows with bank lines. Four passes, strongest first, each only over what the earlier ones left:
 *   1. the same date, direction and amount (several identical candidates are paired by how alike their narrations are);
 *   2. rows split by hand: all of a day's remaining rows in one direction add up exactly to one remaining line (a salary batch);
 *   3. the same 12-digit reference, direction and amount, on another date;
 *   4. the same direction and amount within `nearDays` days.
 * A line is never used twice. Returns { pairs: [{ row, line, how }], groups: [{ rows, line }], unmatchedRows, unmatchedLines, counts }.
 */
export function matchTracker(trackerRows, bankLines, { nearDays = 5 } = {}) {
  const rows = [...trackerRows].sort((a, b) => a.sheetRow - b.sheetRow);
  const lines = [...bankLines].sort((a, b) => (a.tran_date < b.tran_date ? -1 : a.tran_date > b.tran_date ? 1 : a.id < b.id ? -1 : 1));
  const claimed = new Set();
  const usedRows = new Set();
  const pairs = [];
  const groups = [];
  let ambiguous = 0;

  // 1. exact
  const key = (date, dir, paise) => `${date}|${dir}|${paise}`;
  const rowsByKey = new Map();
  for (const r of rows) rowsByKey.set(key(r.date, r.direction, r.amountPaise), [...(rowsByKey.get(key(r.date, r.direction, r.amountPaise)) ?? []), r]);
  const linesByKey = new Map();
  for (const l of lines) linesByKey.set(key(l.tran_date, l.direction, l.amount_paise), [...(linesByKey.get(key(l.tran_date, l.direction, l.amount_paise)) ?? []), l]);
  for (const [k, rs] of rowsByKey) {
    const ls = linesByKey.get(k) ?? [];
    if (!ls.length) continue;
    const choice = rs.length > 1 || ls.length > 1;
    const scored = rs.flatMap((r) => ls.map((l) => ({ r, l, s: similarity(r.particulars, l.narration) }))).sort((a, b) => b.s - a.s || a.r.sheetRow - b.r.sheetRow);
    for (const { r, l } of scored) {
      if (usedRows.has(r.sheetRow) || claimed.has(l.id)) continue;
      usedRows.add(r.sheetRow);
      claimed.add(l.id);
      pairs.push({ row: r, line: l, how: 'exact' });
      if (choice) ambiguous++;
    }
  }

  // 2. a day's rows that add up to one line
  const leftover = () => rows.filter((r) => !usedRows.has(r.sheetRow));
  const byDay = new Map();
  for (const r of leftover()) byDay.set(`${r.date}|${r.direction}`, [...(byDay.get(`${r.date}|${r.direction}`) ?? []), r]);
  for (const l of lines) {
    if (claimed.has(l.id)) continue;
    const day = byDay.get(`${l.tran_date}|${l.direction}`) ?? [];
    if (day.length > 1 && day.every((r) => !usedRows.has(r.sheetRow)) && day.reduce((n, r) => n + r.amountPaise, 0) === l.amount_paise) {
      claimed.add(l.id);
      for (const r of day) usedRows.add(r.sheetRow);
      groups.push({ rows: day, line: l });
    }
  }

  // 3. the bank's reference, then 4. the nearest date with the same amount
  for (const how of ['reference', 'near date']) {
    for (const r of leftover()) {
      const ref = how === 'reference' ? referenceOf(r.particulars) : null;
      if (how === 'reference' && !ref) continue;
      const candidates = lines.filter((l) => !claimed.has(l.id) && l.direction === r.direction && l.amount_paise === r.amountPaise && (how === 'reference' ? (l.upi_rrn ?? referenceOf(l.narration)) === ref : dayDiff(l.tran_date, r.date) <= nearDays));
      candidates.sort((a, b) => dayDiff(a.tran_date, r.date) - dayDiff(b.tran_date, r.date));
      if (!candidates.length) continue;
      claimed.add(candidates[0].id);
      usedRows.add(r.sheetRow);
      pairs.push({ row: r, line: candidates[0], how });
    }
  }

  const unmatchedRows = leftover();
  const unmatchedLines = lines.filter((l) => !claimed.has(l.id));
  const howCount = (h) => pairs.filter((p) => p.how === h).length;
  return {
    pairs,
    groups,
    unmatchedRows,
    unmatchedLines,
    counts: { exact: howCount('exact'), grouped: groups.length, groupedRows: groups.reduce((n, g) => n + g.rows.length, 0), reference: howCount('reference'), nearDate: howCount('near date'), ambiguous, unmatchedRows: unmatchedRows.length, unmatchedLines: unmatchedLines.length },
  };
}

// ---- from the sheet's labels to ledger categories
const norm = (s) => text(s).toLowerCase().replace(/\s+/g, ' ');
const SIMPLE = {
  salary: 'Salaries',
  'farm expenses': 'Operational and miscellaneous',
  groceries: 'Groceries',
  'bank charges': 'Bank charges',
  'petty cash': 'Petty cash',
  'telecom charges': 'Utility bills',
  power: 'Utility bills',
  'online services': 'Software and subscriptions',
  'visit/camp revenue': 'Hospitality receipts',
  'event revenue': 'Event receipts',
  'event expense': 'Operational and miscellaneous',
  miscelleaneous: 'Operational and miscellaneous',
  miscellaneous: 'Operational and miscellaneous',
  'parking charges': 'Operational and miscellaneous',
  taxes: 'Land and local taxes',
  'land tax': 'Land and local taxes',
  // CBDT (the Central Board of Direct Taxes) taxes are direct taxes: income tax.
  'cbdt tax': 'Income tax',
  'tax refund': 'Income tax',
  'interest earned': 'Interest income',
  'fd investment': 'Sinking fund deposits',
  'cs charges': 'Professional fees',
  'ca/cs charges': 'Professional fees',
  insurance: 'Insurance',
};
const PROJECT_CATEGORY = 'Structures and infrastructure';

/**
 * What a tracker row's Details and Type mean for the ledger (`direction` matters only for Donations). Returns { status: 'mapped' | 'blank' | 'unmapped', categoryName?, project?, maintenanceYear?,
 * defaulted? }. `maintenanceYear` is the year a "Maintenance (24-25)" label names, which can be earlier than the year it was paid in. `project` marks a
 * Farm Project row (the Project bucket). `defaulted` marks a label whose category was a default choice, not a certainty (Farm Capex).
 */
export function mapLabels(details, type, direction = 'debit') {
  const d = norm(details);
  const t = norm(type);
  // A donation is an expense when TVC pays it (the first load filed three paid-out ones under income, and they were moved), income only if received.
  if (d === 'donations') return { status: 'mapped', categoryName: direction === 'credit' ? 'Other income' : 'Operational and miscellaneous' };
  if (d === 'farm project' || (d === '' && t === 'project')) return { status: 'mapped', categoryName: PROJECT_CATEGORY, project: true };
  const maintenance = /^maintenance \((\d{2})-(\d{2})\)$/.exec(d);
  if (maintenance) {
    const [a, b] = [Number(maintenance[1]), Number(maintenance[2])];
    if ((a + 1) % 100 !== b) return { status: 'unmapped' };
    return { status: 'mapped', categoryName: 'Member maintenance', maintenanceYear: `${a >= 50 ? 19 : 20}${maintenance[1]}-${maintenance[2]}` };
  }
  if (d === 'farm capex') return { status: 'mapped', categoryName: PROJECT_CATEGORY, defaulted: true };
  if (d === '') return { status: 'blank' };
  return SIMPLE[d] ? { status: 'mapped', categoryName: SIMPLE[d] } : { status: 'unmapped' };
}

// ---- the plan: allocations to create
const fyStart = (s) => {
  const m = /^(\d{4})/.exec(text(s));
  return m ? Number(m[1]) : null;
};
const fyOfDate = (iso) => (Number(iso.slice(5, 7)) >= 4 ? Number(iso.slice(0, 4)) : Number(iso.slice(0, 4)) - 1);

/**
 * Turn matches into allocations. `matches` is the result of matchTracker; `categories` and `parties` come from the ledger (parties: { id, name, kind });
 * `people` are the members' names with their households ({ id, name, household_id }, one row per person and household), used to find the household
 * a maintenance payment is against. Returns { plans: [{ lineId, rows }], skipped, counts }. A line is planned only when EVERY row that describes
 * it can be labelled (the allocations of a line must add up to it); otherwise it is left whole, unallocated, and listed in `skipped` with the
 * sheet row number and why. An approximate match is planned but sent to review. `householdWanted` lists the maintenance rows loaded without a
 * household (by sheet row), for a person to attribute.
 */
export function planAllocations(matches, { categories, parties, people = [], householdOverrides = new Map() }) {
  // A person can be found by name; they count only if that name leads to exactly one household.
  const personEntries = [...new Map(people.map((p) => [p.id, { id: p.id, name: p.name }])).values()];
  const householdsOf = new Map();
  for (const p of people) householdsOf.set(p.id, new Set([...(householdsOf.get(p.id) ?? []), p.household_id]));
  // Members' first names by household, for a couple written "Rahul & Priya".
  const firstNames = new Map();
  for (const p of people) firstNames.set(p.household_id, new Set([...(firstNames.get(p.household_id) ?? []), normaliseName(p.name).split(' ')[0]]));
  const householdFor = (name) => {
    if (!name) return null;
    // What a person decided (the worklist file) beats any guess.
    const decided = householdOverrides.get(normaliseName(name));
    if (decided) return decided;
    const parts = String(name).split(/\s*(?:&|,|\band\b)\s*/i).map((x) => normaliseName(x).split(' ')[0]).filter(Boolean);
    if (parts.length >= 2) {
      // Two or more people named: the one household that has the most of them. A couple may be only half in the records, so one name is enough
      // when no other household matches as well; a tie finds no household.
      const scored = [...firstNames].map(([household, set]) => [household, parts.filter((first) => set.has(first)).length]).filter(([, n]) => n > 0);
      const best = Math.max(0, ...scored.map(([, n]) => n));
      const top = scored.filter(([, n]) => n === best);
      return top.length === 1 ? top[0][0] : null;
    }
    const hit = matchParty(name, personEntries);
    const set = hit ? householdsOf.get(hit.partyId) : null;
    return set && set.size === 1 ? [...set][0] : null;
  };
  const categoryId = new Map(categories.filter((c) => c.active).map((c) => [c.name.toLowerCase(), c.id]));
  const plans = [];
  const skipped = [];
  const householdWanted = [];
  const counts = { allocations: 0, byCategory: {}, maintenanceArrears: 0, maintenanceWithoutHousehold: 0, partyMatched: 0, partyNotMatched: 0, defaulted: 0, projectRows: 0 };

  // Enough about a row for a person to find it in the sheet and act on it.
  const describe = (row) => ({ sheetRow: row.sheetRow, name: text(row.direction === 'debit' ? row.toName : row.fromName), date: row.date, direction: row.direction, amountPaise: row.amountPaise, remarks: text(row.remarks) });

  // One row's allocation, or the reason it cannot be made.
  function build(row, paise, how) {
    const m = mapLabels(row.details, row.type, row.direction);
    if (m.status === 'blank') return { skip: { kind: 'blank', reason: 'No label (Details and Type are blank).' } };
    if (m.status === 'unmapped') return { skip: { kind: 'unmapped', reason: 'The label is not one the load knows.' } };
    const id = categoryId.get(m.categoryName.toLowerCase());
    if (!id) return { skip: { kind: 'no category', reason: `The ledger has no active category "${m.categoryName}".` } };
    const name = row.direction === 'debit' ? row.toName : row.fromName;
    const hit = name ? matchParty(name, parties) : null;
    const party = hit ? parties.find((p) => p.id === hit.partyId) : null;
    const approximate = how === 'reference' || how === 'near date';
    const alloc = {
      category_id: id,
      party_id: party?.id ?? null,
      amount_paise: paise,
      period: row.period,
      nature: (text(row.remarks) || text(row.details) || m.categoryName).replace(/\s+/g, ' ').slice(0, 200),
      source: 'import',
      review_state: approximate ? 'needs_review' : 'ok',
      review_reason: approximate ? 'import_approximate' : null,
      maintenance_year: m.maintenanceYear ?? null,
      household_id: m.maintenanceYear ? householdFor(name) : null,
    };
    if (m.project) alloc.projectFy = fyStart(row.financialYear) ?? fyOfDate(row.date);
    return { alloc, m, party, meta: describe(row) };
  }
  const count = (b) => {
    counts.allocations++;
    counts.byCategory[b.m.categoryName] = (counts.byCategory[b.m.categoryName] ?? 0) + 1;
    if (b.m.defaulted) counts.defaulted++;
    if (b.m.project) counts.projectRows++;
    if (b.party) counts.partyMatched++;
    else counts.partyNotMatched++;
    if (b.m.maintenanceYear) {
      if (!b.alloc.household_id) {
        counts.maintenanceWithoutHousehold++;
        householdWanted.push({ ...b.meta, maintenanceYear: b.m.maintenanceYear });
      }
      if (fyStart(b.m.maintenanceYear) < fyOfDate(b.alloc.period)) counts.maintenanceArrears++;
    }
  };

  for (const { row, line, how } of matches.pairs) {
    const b = build(row, line.amount_paise, how);
    if (b.skip) skipped.push({ ...describe(row), label: row.details, ...b.skip });
    else {
      plans.push({ lineId: line.id, rows: [b.alloc] });
      count(b);
    }
  }
  for (const { rows, line } of matches.groups) {
    const built = rows.map((r) => build(r, r.amountPaise, 'group'));
    const bad = built.find((b) => b.skip);
    if (bad) {
      const why = { blank: 'that has no label', unmapped: 'whose label is not known', 'no category': 'whose category is missing' }[bad.skip.kind];
      skipped.push({ ...describe(rows[0]), label: rows[0].details, kind: 'group', reason: `Part of a group with a row ${why}.`, rows: rows.length });
      continue;
    }
    plans.push({ lineId: line.id, rows: built.map((b) => b.alloc) });
    built.forEach(count);
  }
  return { plans, skipped, counts, householdWanted };
}

/**
 * Save the plans through a store (the database in the script, a fake in the tests). Each planned line is saved once, in its own call, so a
 * failure leaves only that line unallocated and the rest carry on; lines that already have allocations are skipped, so running it again changes
 * nothing. A placeholder project is resolved once per financial year and its id replaces the year.
 */
export async function applyPlans(plans, store) {
  const already = await store.allocatedLineIds();
  const projects = new Map();
  const result = { saved: 0, skippedExisting: 0, failed: [] };
  for (const plan of plans) {
    if (already.has(plan.lineId)) {
      result.skippedExisting++;
      continue;
    }
    try {
      const rows = [];
      for (const { projectFy, ...rest } of plan.rows) {
        if (projectFy != null && !projects.has(projectFy)) projects.set(projectFy, await store.projectFor(projectFy));
        rows.push(projectFy != null ? { ...rest, project_id: projects.get(projectFy) } : rest);
      }
      await store.save(plan.lineId, rows);
      result.saved++;
    } catch (err) {
      result.failed.push({ lineId: plan.lineId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/**
 * Member names from the sheet's Member Master tab (heading names "Name" and "Farm Unit #"), tied to the ledger's households by farm unit
 * ({ id, farm_unit }). The sheet lists each member of a household, so it names people the member records do not. Returns rows like
 * { id, name, household_id }, one per person; a unit the ledger does not know, or a blank name, is left out.
 */
export function memberNamesFromMaster(grid, households) {
  const header = (grid[0] ?? []).map((h) => text(h).toLowerCase());
  const name = header.indexOf('name');
  const unit = header.indexOf('farm unit #');
  if (name < 0 || unit < 0) return [];
  const unitKey = (u) => text(u).toLowerCase().replace(/\s+/g, '');
  const householdOf = new Map(households.map((h) => [unitKey(h.farm_unit), h.id]));
  const out = [];
  grid.slice(1).forEach((r, i) => {
    const household = householdOf.get(unitKey(r[unit]));
    if (text(r[name]) && household) out.push({ id: `master-${i + 2}`, name: text(r[name]), household_id: household });
  });
  return out;
}

// A small CSV reader: quoted fields, doubled quotes, commas and newlines inside quotes.
function csvRows(textIn) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < textIn.length; i++) {
    const c = textIn[i];
    if (quoted) {
      if (c === '"' && textIn[i + 1] === '"') (cell += '"', i++);
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') (row.push(cell), (cell = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && textIn[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/**
 * Read back the worklist file the directors fill in: the heading "name in the sheet" and the heading that starts "which household" (the farm unit).
 * Returns { overrides: Map(normalised name -> household id), unknownUnits: [names whose unit the ledger does not know] }. A blank answer is no answer.
 */
export function parseHouseholdOverrides(csvText, households) {
  const [header = [], ...body] = csvRows(csvText);
  const lower = header.map((h) => text(h).toLowerCase());
  const nameAt = lower.indexOf('name in the sheet');
  const unitAt = lower.findIndex((h) => h.startsWith('which household'));
  const overrides = new Map();
  const unknownUnits = [];
  if (nameAt < 0 || unitAt < 0) return { overrides, unknownUnits };
  const unitKey = (u) => text(u).toLowerCase().replace(/\s+/g, '');
  const householdOf = new Map(households.map((h) => [unitKey(h.farm_unit), h.id]));
  for (const r of body) {
    if (!text(r[unitAt])) continue;
    const id = householdOf.get(unitKey(r[unitAt]));
    if (id) overrides.set(normaliseName(r[nameAt]), id);
    else unknownUnits.push(text(r[nameAt]));
  }
  return { overrides, unknownUnits };
}

/**
 * A small first load: the first planned line of each kind (plain, salary-style group, maintenance with a household, project, approximate), so the first
 * real write exercises every path and can be checked by eye before the rest. Returns { picked, kinds, missing }: the lines, which kind each is, and the
 * kinds there was none of. A line is picked once, for the first kind it fits.
 */
export function pickCanary(plans) {
  const kinds = [
    ['plain', (p) => p.rows.length === 1 && !p.rows[0].maintenance_year && p.rows[0].projectFy == null && p.rows[0].review_state === 'ok'],
    ['group', (p) => p.rows.length > 1],
    ['maintenance with household', (p) => p.rows.some((r) => r.maintenance_year && r.household_id)],
    ['project', (p) => p.rows.some((r) => r.projectFy != null)],
    ['approximate', (p) => p.rows.some((r) => r.review_state === 'needs_review')],
  ];
  const picked = [];
  const found = [];
  const missing = [];
  for (const [kind, fits] of kinds) {
    const hit = plans.find((p) => fits(p) && !picked.includes(p));
    if (hit) {
      picked.push(hit);
      found.push(kind);
    } else missing.push(kind);
  }
  return { picked, kinds: found, missing };
}
