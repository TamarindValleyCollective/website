// The trees the ledger's linked pickers walk (scripts/lib/linked-picker.mjs): what is under a category, and which parties sit under which kind.
// Pure, so it is tested (finance-picker-nodes.test.mjs); the page only hands the lookups in and reads the chosen path back.
//
//   category:  Maintenance > 2026-27 > a unit            a capital purchase > (a project)            any other category: just the category
//   party:     Members > a member   |   Vendors > a vendor   |   ...   |   All parties > anyone   |   (for maintenance) In this unit > the people living there
import { categoryOptions, partyOptions, unitOptions } from './finance-ui.mjs';
import { financialYearOf, maintenanceYears, partyKindsFor } from './finance-search.mjs';

export const KIND_LABELS = { member: 'Members', vendor: 'Vendors', customer: 'Customers', employee: 'Employees', government: 'Government', bank: 'Banks', director: 'Directors', other: 'Other' };
const KIND_ORDER = Object.keys(KIND_LABELS);

/** The years offered for a payment on `date`: its own financial year first, then the one before, the next, and the one before that. */
export function yearsFor(date) {
  const own = financialYearOf(date);
  return [own, ...maintenanceYears(date).filter((y) => y !== own).reverse()];
}

/** Units as picker rows, the payer's own first (marked) when there is one. */
/** @param {any[]} households @param {string} [suggested] */
export function unitNodes(households, suggested = '') {
  const all = unitOptions(households);
  const mine = all.find((u) => u.value === suggested);
  return mine ? [{ ...mine, sub: 'the payer’s unit' }, ...all.filter((u) => u.value !== suggested)] : all;
}

/**
 * The category tree for one line (its date decides the years). `bar`: for the bar over many lines, where the year and the unit may be left to each line,
 * so Maintenance and each year can also be picked as they are. A capital purchase can be picked as it is, or taken down to a project.
 */
/** @param {{ categories: any[], households?: any[], projects?: any[], date: string, suggestedUnit?: string, bar?: boolean, selected?: string }} config */
export function categoryNodes({ categories, households = [], projects = [], date, suggestedUnit = '', bar = false, selected = '' }) {
  return categoryOptions(categories, { selected }).map((o) => {
    const type = categories.find((c) => c.id === o.value)?.type;
    const node = { value: o.value, label: o.label, group: o.group };
    if (type === 'member_contribution') {
      node.selectable = bar;
      if (bar) Object.assign(node, { pickSub: 'year and unit per line', enterLabel: `${o.label} · choose the year` });
      node.children = () => yearsFor(date).map((y) => ({ value: y, label: y, selectable: bar, ...(bar ? { pickSub: 'unit per line', enterLabel: `${y} · choose the unit` } : {}), children: () => unitNodes(households, suggestedUnit) }));
    } else if (type === 'capex' && projects.length) {
      node.selectable = true;
      Object.assign(node, { pickSub: 'no project', enterLabel: `${o.label} · choose a project` });
      node.children = () => projects.map((p) => ({ value: p.id, label: `${p.name} (${p.financial_year})` }));
    }
    return node;
  });
}

/** The path that shows what a line has: the category, then (maintenance) the year and unit once there is a unit, or (capital) its project. */
export function categoryPath({ categoryId, type, year = '', unit = '', project = '' }) {
  if (!categoryId) return [];
  if (type === 'member_contribution') return unit ? [categoryId, year, unit] : [categoryId];
  if (type === 'capex' && project) return [categoryId, project];
  return [categoryId];
}

/** Reads a chosen category path back: { categoryId, year, householdId, projectId } (empty strings for what was not chosen). */
export function readCategoryPath(path, type) {
  const [categoryId = '', second = '', third = ''] = path;
  if (type === 'member_contribution') return { categoryId, year: second, householdId: third, projectId: '' };
  if (type === 'capex') return { categoryId, year: '', householdId: '', projectId: second };
  return { categoryId, year: '', householdId: '', projectId: '' };
}

/** The party tree: a level of kinds (only those with someone in them), each holding its parties; "All parties"; and, for a unit's maintenance, that unit's people first. */
/** @param {{ parties: any[], unitId?: string, unitLabels?: Map<string, string> }} config */
export function partyNodes({ parties, unitId = '', unitLabels = new Map() }) {
  const leaves = partyOptions(parties, { unitId, unitLabels });
  const byKind = new Map();
  for (const leaf of leaves) byKind.set(leaf.kind, [...(byKind.get(leaf.kind) ?? []), { value: leaf.value, label: leaf.label, sub: leaf.sub === 'in this unit' ? '' : leaf.sub }]);
  const nodes = [];
  const inUnit = leaves.filter((l) => l.sub === 'in this unit');
  if (unitId && inUnit.length) nodes.push({ value: 'unit', label: `People in ${unitLabels.get(unitId) ?? 'this unit'}`, children: inUnit.map((l) => ({ value: l.value, label: l.label, sub: '' })) });
  for (const kind of KIND_ORDER) if (byKind.has(kind)) nodes.push({ value: kind, label: KIND_LABELS[kind], children: byKind.get(kind) });
  nodes.push({ value: 'all', label: 'All parties', children: leaves.map((l) => ({ value: l.value, label: l.label, sub: l.sub === 'in this unit' ? '' : l.sub })) });
  return nodes;
}

/** The path that shows a party: its kind, then the party. */
export const partyPath = (party) => (party ? [party.kind, party.id] : []);

/**
 * Where the party list should open: for a unit's maintenance, the people in that unit; otherwise the first kind that goes with the category;
 * nothing (the top level, all kinds) when the category has no opinion or the kind has nobody.
 */
/** @param {{ categoryType?: string, unitId?: string, unitHasPeople?: boolean, parties?: any[] }} config */
export function partyStart({ categoryType, unitId = '', unitHasPeople = false, parties = [] }) {
  if (categoryType === 'member_contribution') return unitId && unitHasPeople ? ['unit'] : null;
  const kinds = partyKindsFor(categoryType);
  const first = kinds?.find((k) => parties.some((p) => p.kind === k));
  return first ? [first] : null;
}
