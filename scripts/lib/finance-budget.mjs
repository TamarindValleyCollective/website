// The budget editor's rules (docs/finance/FINANCE.md, "The budget editor"). Pure and I/O-free so they are tested directly
// (finance-budget.test.mjs). The function (lib/finance-budget.ts) refuses a bad save with them; the page uses the same ones to say
// what is wrong before it asks. Money is integer paise; a person types rupees.
import { headOfCategory } from './finance-metrics.mjs';

/** The heads of the yearly presentation, then the inflow side. A category with no head is shown as `none` and counted as money out. */
export const BUDGET_HEADS = ['company', 'farm', 'projects', 'investment', 'income', 'maintenance'];
export const BUDGET_HEAD_LABELS = { company: 'Company', farm: 'Farm', projects: 'Projects', investment: 'Sinking fund', income: 'Income', maintenance: 'Maintenance', none: 'No head yet' };
export const MAX_LINES = 300;
const MAX_PAISE = 100_000_000_000; // ₹100 crore a line: far above anything real, far below what breaks a bigint
const LABEL_MAX = 120;
const COMMENT_MAX = 200;
const OUTFLOW = new Set(['company', 'farm', 'projects', 'investment', 'none']);

/** What a person typed ("12,34,567", "₹ 1,500", "2500.50") as paise, or null when it is not an amount. Never guesses. */
export function parseRupees(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/[₹\s]/g, '');
  // Commas are only a visual aid (12,34,567 or 1,234,567), so any placement between digits is read the same way.
  if (!/^\d+(,\d+)*(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.replace(/,/g, '').split('.');
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}

/** Paise shown as a person would type it: Indian grouping, decimals only when there are some. */
export function rupeesInput(paise) {
  const whole = Math.floor(paise / 100);
  const frac = paise % 100;
  const grouped = whole.toLocaleString('en-IN');
  return frac ? `${grouped}.${String(frac).padStart(2, '0')}` : grouped;
}

/**
 * Check a set of budget lines before they are saved. rows: [{ categoryId?, projectId?, label?, comment?, annualPaise }].
 * ctx: { categories: [{ id, name, active }], projects: [{ id, name, kind }] }. Every problem is reported at once, each with the
 * index of its row. A blank label becomes the category's or project's name. Returns { ok, errors: [{ index, message }], lines }.
 */
export function validateBudgetLines(rows, { categories, projects }) {
  const errors = [];
  if (!Array.isArray(rows)) return { ok: false, errors: [{ index: -1, message: 'Send the lines as a list.' }], lines: [] };
  if (rows.length > MAX_LINES) return { ok: false, errors: [{ index: -1, message: `A budget has at most ${MAX_LINES} lines.` }], lines: [] };
  const cats = new Map(categories.map((c) => [c.id, c]));
  const projs = new Map(projects.map((p) => [p.id, p]));
  const seenCategory = new Set();
  const seenProject = new Set();
  const lines = [];
  rows.forEach((row, index) => {
    const bad = (message) => errors.push({ index, message });
    if (!row || typeof row !== 'object') return bad('This line is not readable.');
    const hasCat = typeof row.categoryId === 'string' && row.categoryId !== '';
    const hasProj = typeof row.projectId === 'string' && row.projectId !== '';
    if (hasCat === hasProj) return bad('Choose a category or a project, not both and not neither.');
    let target;
    if (hasCat) {
      target = cats.get(row.categoryId);
      if (!target) return bad('That category does not exist.');
      if (target.active === false) return bad('That category is no longer in use.');
      if (seenCategory.has(row.categoryId)) return bad('That category already has a line. Put both amounts in one line.');
      seenCategory.add(row.categoryId);
    } else {
      target = projs.get(row.projectId);
      if (!target) return bad('That project does not exist.');
      if (target.kind === 'event') return bad('An event is tracked for profit and loss, not budgeted. Choose a project.');
      if (seenProject.has(row.projectId)) return bad('That project already has a line. Put both amounts in one line.');
      seenProject.add(row.projectId);
    }
    const label = (typeof row.label === 'string' ? row.label.trim() : '') || target.name;
    if (label.length > LABEL_MAX) return bad(`Keep the name to ${LABEL_MAX} characters.`);
    const comment = typeof row.comment === 'string' ? row.comment.trim() : '';
    if (comment.length > COMMENT_MAX) return bad(`Keep the comment to ${COMMENT_MAX} characters.`);
    const amount = row.annualPaise;
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_PAISE) return bad('Enter an amount in rupees, zero or more.');
    lines.push({ categoryId: hasCat ? row.categoryId : null, projectId: hasProj ? row.projectId : null, label, comment: comment || null, annualPaise: amount, sortOrder: index + 1 });
  });
  return { ok: errors.length === 0, errors, lines: errors.length ? [] : lines };
}

/** The head a line is reported under: its project's (always Projects), its category's, or `none`. */
export function lineHead(line, { categories }) {
  if (line.projectId) return 'projects';
  const category = categories.find((c) => c.id === line.categoryId);
  return headOfCategory(category) ?? 'none';
}

/** Totals under each head, money out against money in, and the surplus the plan leaves. */
export function budgetTotals(lines, ctx) {
  const byHead = Object.fromEntries([...BUDGET_HEADS, 'none'].map((h) => [h, 0]));
  for (const l of lines) byHead[lineHead(l, ctx)] += l.annualPaise;
  const outflowPaise = Object.entries(byHead).reduce((n, [h, v]) => n + (OUTFLOW.has(h) ? v : 0), 0);
  const inflowPaise = byHead.income + byHead.maintenance;
  return { byHead, outflowPaise, inflowPaise, surplusPaise: inflowPaise - outflowPaise };
}

const SPENDING_TYPES = new Set(['opex', 'capex', 'tax']);

/**
 * The editor's grid: every category (and each project of the year) is a row under its head, so a line is made by typing an amount
 * and nothing can be duplicated or forgotten. A category with no head that is spending goes under `none` (so it is not lost until
 * someone gives it a head); a transfer or reimbursement is not budgeted and is left out; a retired category or a transfer is shown
 * only if it already has a line. Each row carries what is planned, what has been spent this year and last year's amount.
 * actuals: { byCategory, byProject } (paise); previous: { byCategory } | null.
 */
export function editorRows({ categories, projects, lines, actuals, previous }) {
  const lineOfCategory = new Map(lines.filter((l) => l.categoryId).map((l) => [l.categoryId, l]));
  const lineOfProject = new Map(lines.filter((l) => l.projectId).map((l) => [l.projectId, l]));
  const groups = new Map([...BUDGET_HEADS, 'none'].map((h) => [h, []]));
  const byName = (a, b) => a.name.localeCompare(b.name);
  for (const c of [...categories].sort(byName)) {
    const line = lineOfCategory.get(c.id);
    const head = headOfCategory(c) ?? (SPENDING_TYPES.has(c.type) ? 'none' : null);
    if (!line && (head === null || c.active === false)) continue;
    groups.get(head ?? 'none').push({
      key: `c:${c.id}`, kind: 'category', id: c.id, name: c.name, label: line?.label ?? '', comment: line?.comment ?? '',
      amountPaise: line?.annualPaise ?? null, actualPaise: actuals.byCategory[c.id] ?? 0, previousPaise: previous?.byCategory?.[c.id] ?? null, retired: c.active === false,
    });
  }
  for (const p of [...projects].sort(byName)) {
    if (p.kind !== 'project') continue;
    const line = lineOfProject.get(p.id);
    groups.get('projects').push({
      key: `p:${p.id}`, kind: 'project', id: p.id, name: p.name, label: line?.label ?? '', comment: line?.comment ?? '',
      amountPaise: line?.annualPaise ?? null, actualPaise: actuals.byProject[p.id] ?? 0, previousPaise: null, retired: false,
    });
  }
  return [...groups].map(([head, rows]) => ({ head, label: BUDGET_HEAD_LABELS[head], rows })).filter((g) => g.rows.length);
}

/**
 * What the grid's inputs say, as lines to save: a row with no amount typed has no line, "0" is a real line, and an amount that is
 * not an amount is marked on its row (errors by row key) rather than read as something else. inputs: [{ key, kind, id,
 * amountText, label, comment }].
 */
export function linesFromInputs(inputs) {
  const lines = [];
  const errors = {};
  for (const i of inputs) {
    const text = (i.amountText ?? '').trim();
    if (!text) continue;
    const annualPaise = parseRupees(text);
    if (annualPaise === null) {
      errors[i.key] = 'Enter an amount in rupees, like 1,20,000.';
      continue;
    }
    lines.push({ categoryId: i.kind === 'category' ? i.id : undefined, projectId: i.kind === 'project' ? i.id : undefined, label: (i.label ?? '').trim(), comment: (i.comment ?? '').trim(), annualPaise });
  }
  return { lines, errors };
}
