// Turns the member_* rows (supabase/migrations/0040_member_portal_schema.sql)
// into the household list the /internal/members review screen shows, with the
// data gaps an admin should fix. Pure: netlify/functions/members-admin.mts
// does the reading and the role-based masking. Emails and phones never leave
// here as values — only whether one is on file.
import { pattaFromReference } from './member-import.mjs';

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

const num = (v) => (v == null ? null : Number(v));
const sum = (rows, key) => rows.reduce((total, r) => total + (num(r[key]) ?? 0), 0);
const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

export function buildHouseholdReview({ households, people, memberships, plots, housePattas, notes }) {
  const personById = new Map(people.map((p) => [p.id, p]));
  const group = (rows) => {
    const map = new Map();
    for (const r of rows) map.set(r.household_id, [...(map.get(r.household_id) ?? []), r]);
    return map;
  };
  const membersByHousehold = group(memberships);
  const plotsByHousehold = group(plots);
  const housePattasByHousehold = group(housePattas);
  const notesByHousehold = group(notes);

  const out = households.map((h) => {
    const members = (membersByHousehold.get(h.id) ?? [])
      .map((m) => ({ m, person: personById.get(m.person_id) }))
      .filter((x) => x.person);
    const household = {
      farmUnit: h.farm_unit,
      houseNo: h.house_no,
      cluster: h.cluster,
      unitType: h.unit_type,
      people: members.map(({ m, person }) => ({
        name: person.full_name,
        role: m.role,
        canLogin: m.can_login,
        hasEmail: Boolean(person.email),
        hasPhone: Boolean(person.phone),
      })),
      plots: (plotsByHousehold.get(h.id) ?? []).map((p) => ({
        pattaNo: p.patta_no,
        referenceNo: p.reference_no,
        surveyNo: p.survey_no,
        areaHectares: num(p.area_hectares),
        areaAcres: num(p.area_acres),
        settlement: p.settlement,
      })),
      housePattas: (housePattasByHousehold.get(h.id) ?? []).map((p) => ({
        pattaNo: p.patta_no,
        referenceNo: p.reference_no,
        surveyNo: p.survey_no,
        areaSqFt: num(p.area_sq_ft),
        settlement: p.settlement,
      })),
      flags: [],
    };
    // Land totals, for the pivot-style summaries. Rows with no area yet count as
    // zero and are reported, so a total is never mistaken for a complete one.
    household.farmAcres = round(sum(household.plots, 'areaAcres'), 2);
    household.farmHectares = round(sum(household.plots, 'areaHectares'), 4);
    household.houseSqFt = round(sum(household.housePattas, 'areaSqFt'), 2);
    household.plotsMissingArea = household.plots.filter((p) => !p.areaAcres && !p.areaHectares).length;
    household.housePattasMissingArea = household.housePattas.filter((p) => !p.areaSqFt).length;

    const flag = (kind, severity, text) => household.flags.push({ kind, severity, text });
    if (household.people.length === 0) flag('no_people', 'error', 'No people on this household.');
    if (household.people.length > 2) flag('over_two_people', 'warn', `${household.people.length} people listed; only 2 can sign in.`);
    if (!h.house_no) flag('no_house', 'info', 'No house number (probably not built yet).');
    if (h.house_no && !h.cluster) flag('no_cluster', 'warn', 'House has no cluster.');
    if (household.plots.length === 0) flag('no_farm_patta', 'warn', 'No farm patta details yet.');
    if (h.house_no && household.housePattas.length === 0) flag('no_house_patta', 'info', 'No house patta details yet.');
    const withoutEmail = household.people.filter((p) => !p.hasEmail).length;
    if (withoutEmail > 0) flag('missing_email', 'info', `${withoutEmail} of ${household.people.length} without an email on file.`);
    for (const p of plots.filter((x) => x.household_id === h.id)) {
      const fromRef = p.reference_no ? pattaFromReference(p.reference_no) : null;
      if (fromRef != null && p.patta_no && parseInt(p.patta_no, 10) !== fromRef) {
        flag('patta_number_mismatch', 'warn', `Patta number ${p.patta_no} doesn't match its reference number (${fromRef}).`);
      }
    }
    if ((notesByHousehold.get(h.id) ?? []).some((n) => n.kind === 'patta_issue')) flag('patta_issue', 'warn', 'Marked as having a patta issue.');

    household.flags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    return household;
  });

  out.sort((a, b) => a.farmUnit.localeCompare(b.farmUnit));
  return out;
}

export function reviewTotals(reviewed) {
  const flagged = reviewed.filter((h) => h.flags.some((f) => f.severity !== 'info'));
  return {
    households: reviewed.length,
    people: reviewed.reduce((n, h) => n + h.people.length, 0),
    peopleWithEmail: reviewed.reduce((n, h) => n + h.people.filter((p) => p.hasEmail).length, 0),
    farmPlots: reviewed.reduce((n, h) => n + h.plots.length, 0),
    householdsNeedingAttention: flagged.length,
    farmAcres: round(reviewed.reduce((n, h) => n + h.farmAcres, 0), 2),
    farmHectares: round(reviewed.reduce((n, h) => n + h.farmHectares, 0), 4),
    houseSqFt: round(reviewed.reduce((n, h) => n + h.houseSqFt, 0), 2),
  };
}
