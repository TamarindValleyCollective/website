// One-time import of the member register from the "TVC Spend Summary" workbook
// (tabs: Member Master, Farm Patta Details, House Patta Details) into the shape
// of supabase/migrations/0040_member_portal_schema.sql. Pure functions only —
// the CLI (scripts/import-members.mjs) does the reading and writing.
//
// Three things about the source that shape this code (found while profiling it,
// see docs/plans/member-portal.md):
//   * Member Master is authoritative for households: people grouped into farm
//     units (F-01..F-53), the same numbering as the vault's `Places/Farm units`.
//   * The patta tabs use a DIFFERENT "Farm #" numbering from Member Master, and
//     households can swap houses, so neither the sheet's farm number nor its
//     house number is trusted on its own. Each patta row is scored against every
//     household by how many name words agree (see matcher below).
//   * Contact data is thin: the "Email ID" column mostly holds names (the real
//     emails sit inside Google people chips, read by scripts/export-member-sheet.mjs),
//     and there are no phone numbers. Missing values stay null ("not available yet").
//
// Anomalies are returned, never thrown, so an admin can fix them in the portal.
// Their `detail` text never contains an email address or phone number.

// Corrections that are known to be right but that the sheet doesn't carry yet.
// They name real people and houses, so they are NOT kept in this (public) repo:
// pass them in from a private JSON file (import-members.mjs --fixes fixes.json).
// Shape, every key optional:
//   mergePeople: [{ farmUnit: 'F-00', names: ['A B Kumar', 'Asha Kumar'], into: 'A B Kumar' }]
//                rows the sheet lists as separate people but are one person
//   setHouse:    [{ farmUnit: 'F-00', houseNo: 'H-00', was: 'H-01' }]
//                a household's house, applied only while the sheet still has `was`
//   setCluster:  [{ farmUnit: 'F-00', cluster: 'H2', was: 'H1-B' }]
//                likewise for a cluster the sheet has wrong
const NO_FIXES = { mergePeople: [], setHouse: [], setCluster: [] };

const cell = (row, i) => (row && row[i] != null ? String(row[i]).trim() : '');

function number(text) {
  const n = parseFloat(String(text).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function validEmail(text) {
  const t = text.toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
}

const normName = (name) => name.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Name words of a free-text owner label like "Asha & Ravi" or "Asha and Ravi
// Kumar". Short words and joiners are dropped.
function labelTokens(label) {
  return normName(label)
    .split(' ')
    .filter((t) => t.length > 2 && t !== 'and' && t !== 'the');
}

// "31/12/081/01234/80138" -> 1234 ; "P/31/12/081/05678/90134" -> 5678.
export function pattaFromReference(reference) {
  const parts = reference.split('/');
  if (parts.length < 2) return null;
  const n = parseInt(parts[parts.length - 2], 10);
  return Number.isFinite(n) ? n : null;
}

function addAnomaly(list, kind, severity, farmUnit, detail) {
  list.push({ kind, severity, farmUnit: farmUnit ?? null, detail });
}

function parseMemberMaster(rows, anomalies) {
  const households = new Map(); // farm_unit -> {farm_unit, house_no, cluster, unit_type}
  const people = []; // {importKey, full_name, email, farmUnit, pattaIssue}

  for (const row of rows.slice(1)) {
    if (!/^\d+$/.test(cell(row, 0))) continue;
    const name = cell(row, 1);
    const farmUnit = cell(row, 2);
    if (!name) continue;
    if (!/^F-\d{2}$/.test(farmUnit)) {
      addAnomaly(anomalies, 'person_without_farm_unit', 'error', null, `Row ${cell(row, 0)} "${name}" has no valid farm unit.`);
      continue;
    }

    const attrs = {
      house_no: /^H-\d{2}$/.test(cell(row, 4)) ? cell(row, 4) : null,
      cluster: ['H1-A', 'H1-B', 'H2'].includes(cell(row, 3)) ? cell(row, 3) : null,
      unit_type: cell(row, 5) || null,
    };
    const existing = households.get(farmUnit);
    if (!existing) {
      households.set(farmUnit, { farm_unit: farmUnit, ...attrs });
    } else {
      for (const key of Object.keys(attrs)) {
        if (existing[key] == null) existing[key] = attrs[key];
        else if (attrs[key] != null && attrs[key] !== existing[key]) {
          addAnomaly(anomalies, 'household_conflicting_values', 'warn', farmUnit, `${key} differs between rows (${existing[key]} vs ${attrs[key]}).`);
        }
      }
    }

    people.push({
      importKey: `master-${cell(row, 0)}`,
      full_name: name,
      email: validEmail(cell(row, 8)),
      farmUnit,
      pattaIssue: cell(row, 9).toLowerCase() === 'yes',
    });
  }
  return { households, people };
}

// Merge rows that are one person; keeps the first email found.
function applyFixes(people, anomalies, mergePeople) {
  let result = people;
  for (const fix of mergePeople) {
    const wanted = new Set(fix.names.map(normName));
    const group = result.filter((p) => p.farmUnit === fix.farmUnit && wanted.has(normName(p.full_name)));
    if (group.length < 2) continue;
    const keep = group.find((p) => normName(p.full_name) === normName(fix.into)) ?? group[0];
    keep.email = keep.email ?? group.map((p) => p.email).find(Boolean) ?? null;
    keep.pattaIssue = group.some((p) => p.pattaIssue);
    result = result.filter((p) => p === keep || !group.includes(p));
    addAnomaly(anomalies, 'people_merged', 'info', fix.farmUnit, `Merged ${group.length} sheet rows into one person (confirmed duplicate).`);
  }
  return result;
}

function matcher(households, people) {
  const houseToUnit = new Map();
  for (const h of households.values()) if (h.house_no) houseToUnit.set(h.house_no, h.farm_unit);
  // farm_unit -> every name word (3+ letters) of the people in it. All words,
  // not just the first: "A B Kumar" has to match a label saying "Kumar".
  const firstNames = new Map();
  for (const p of people) {
    const set = firstNames.get(p.farmUnit) ?? new Set();
    for (const word of normName(p.full_name).split(' ')) if (word.length > 2) set.add(word);
    firstNames.set(p.farmUnit, set);
  }
  const overlap = (unit, tokens) => [...(firstNames.get(unit) ?? [])].filter((n) => tokens.has(n)).length;

  // Farm patta follows the FARM PLOT, not the house: households swap houses, so
  // a house number on a farm row is only a hint. The label's names must agree
  // with whichever household it lands on.
  // Every household is scored by how many of the label's name words it has
  // ("Asha Rao" scores 2 on the Asha Rao household but only 1 on an unrelated
  // Asha's, even when the sheet's own farm number points at the latter). The
  // best score wins; on a tie the sheet's own farm number wins, then the house
  // number. A label that matches no name at all falls back to the house number
  // alone and is flagged as unverified.
  function match(label, houseNo, sheetUnit) {
    // NOTE: Member Master's own "Farm Patta #" column is deliberately NOT used
    // as evidence. It appears to have been filled from the patta sheet's old
    // farm numbers, so it carries the same renumbering error instead of
    // checking it.
    const tokens = new Set(labelTokens(label));
    const houseUnit = houseNo ? houseToUnit.get(houseNo) : undefined;
    let best = [];
    let bestScore = 0;
    for (const unit of firstNames.keys()) {
      const score = overlap(unit, tokens);
      if (score > bestScore) {
        best = [unit];
        bestScore = score;
      } else if (score === bestScore && score > 0) best.push(unit);
    }
    if (best.length) {
      if (sheetUnit && best.includes(sheetUnit)) return { farmUnit: sheetUnit, method: 'farm-number' };
      if (houseUnit && best.includes(houseUnit)) return { farmUnit: houseUnit, method: 'house' };
      if (best.length === 1) return { farmUnit: best[0], method: 'name' };
    }
    if (houseUnit) return { farmUnit: houseUnit, method: 'house-unverified' };
    return null;
  }

  // House patta follows the HOUSE: whoever lives in H-xx now holds its patta
  // record, even if it is still in the previous owner's name after a swap.
  function matchHouse(label, houseNo, sheetUnit) {
    const houseUnit = houseNo ? houseToUnit.get(houseNo) : undefined;
    if (!houseUnit) return match(label, houseNo, sheetUnit);
    const verified = overlap(houseUnit, new Set(labelTokens(label))) > 0;
    return { farmUnit: houseUnit, method: verified ? 'house' : 'house-owner-differs' };
  }
  return { match, matchHouse };
}

function parsePattas(rows, anomalies, { match }, households) {
  const plots = [];
  const seen = new Set();
  const unitsWithData = new Set();
  rows.slice(1).forEach((row, idx) => {
    const label = cell(row, 0);
    if (!label) return;
    const sheetRow = idx + 2;
    const pattaNo = cell(row, 4) || null;
    const survey = cell(row, 5) || null;
    const acres = number(cell(row, 7));
    const hectares = number(cell(row, 6));
    const reference = cell(row, 3) || null;
    const hasData = pattaNo || survey || acres || hectares || reference;
    const found = match(label, cell(row, 2), cell(row, 1));
    if (!found) {
      addAnomaly(anomalies, 'patta_unmatched', 'error', null, `Farm patta row ${sheetRow} ("${label}") can't be tied to a household; needs an admin.`);
      return;
    }
    const { farmUnit, method } = found;
    if (!hasData) return; // a placeholder row: nothing known yet, nothing to check
    const sheetUnit = cell(row, 1);
    if (sheetUnit && sheetUnit !== farmUnit && method !== 'house-unverified') {
      addAnomaly(anomalies, 'patta_sheet_farm_number_differs', 'info', farmUnit, `Patta sheet calls this "${sheetUnit}"; matched by ${method}.`);
    }
    if (method === 'name') addAnomaly(anomalies, 'patta_matched_by_name', 'warn', farmUnit, `Farm patta row ${sheetRow} ("${label}") matched on first name only; check it.`);
    if (method === 'house-unverified') addAnomaly(anomalies, 'patta_matched_by_house_only', 'warn', farmUnit, `Farm patta row ${sheetRow} ("${label}") matched by house number only; no name agrees. Check it.`);
    const key = [farmUnit, survey ?? '', pattaNo ?? ''].join('|');
    if (seen.has(key)) {
      addAnomaly(anomalies, 'patta_duplicate_row', 'info', farmUnit, `Farm patta row ${sheetRow} repeats survey ${survey ?? '(none)'}; kept once.`);
      return;
    }
    seen.add(key);
    unitsWithData.add(farmUnit);
    const fromRef = reference ? pattaFromReference(reference) : null;
    if (fromRef != null && pattaNo && parseInt(pattaNo, 10) !== fromRef) {
      addAnomaly(anomalies, 'patta_number_mismatch', 'warn', farmUnit, `Patta number ${pattaNo} doesn't match its reference number (${fromRef}); one is mistyped.`);
    }
    plots.push({
      importKey: `farm-patta-row-${sheetRow}`,
      farmUnit,
      patta_no: pattaNo,
      reference_no: reference,
      survey_no: survey,
      area_hectares: hectares,
      area_acres: acres,
      settlement: cell(row, 8) || null,
    });
  });
  for (const unit of households.keys()) {
    if (!unitsWithData.has(unit)) addAnomaly(anomalies, 'household_without_farm_patta', 'warn', unit, 'No farm patta details yet.');
  }
  return plots;
}

function parseHousePattas(rows, anomalies, { match, matchHouse }, households) {
  const out = [];
  const seen = new Set();
  const unitsWithData = new Set();
  rows.slice(1).forEach((row, idx) => {
    const label = cell(row, 0);
    if (!label) return;
    const sheetRow = idx + 2;
    const pattaNo = cell(row, 1) || null;
    const reference = cell(row, 4) || null;
    const survey = cell(row, 5).replace(/[\s/]+$/, '') || null;
    const sqft = number(cell(row, 7));
    const found = matchHouse(label, cell(row, 3), cell(row, 2));
    if (!found) {
      addAnomaly(anomalies, 'patta_unmatched', 'error', null, `House patta row ${sheetRow} ("${label}") can't be tied to a household; needs an admin.`);
      return;
    }
    if (!(pattaNo || sqft || reference)) return; // a placeholder row: nothing known yet
    if (found.method === 'house-owner-differs') {
      addAnomaly(anomalies, 'house_patta_owner_differs', 'warn', found.farmUnit, `House patta row ${sheetRow} is in the name "${label}", who is not in this household; may need a transfer.`);
    }
    const key = [found.farmUnit, survey ?? '', pattaNo ?? ''].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    unitsWithData.add(found.farmUnit);
    out.push({
      importKey: `house-patta-row-${sheetRow}`,
      farmUnit: found.farmUnit,
      patta_no: pattaNo,
      reference_no: reference,
      survey_no: survey,
      area_sq_ft: sqft,
      settlement: cell(row, 8) || null,
    });
  });
  for (const h of households.values()) {
    if (h.house_no && !unitsWithData.has(h.farm_unit)) addAnomaly(anomalies, 'household_without_house_patta', 'info', h.farm_unit, 'No house patta details yet.');
  }
  return out;
}

// tabs: { 'Member Master': string[][], 'Farm Patta Details': string[][], 'House Patta Details': string[][] }
export function buildMemberRegister(tabs, fixes = {}) {
  const { mergePeople, setHouse, setCluster } = { ...NO_FIXES, ...fixes };
  const anomalies = [];
  const master = parseMemberMaster(tabs['Member Master'] ?? [], anomalies);
  const people = applyFixes(master.people, anomalies, mergePeople);
  const { households } = master;
  for (const fix of setCluster) {
    const h = households.get(fix.farmUnit);
    if (h && h.cluster === fix.was) {
      h.cluster = fix.cluster;
      addAnomaly(anomalies, 'cluster_corrected', 'info', fix.farmUnit, `Cluster set to ${fix.cluster} (the sheet has ${fix.was}).`);
    }
  }
  for (const fix of setHouse) {
    const h = households.get(fix.farmUnit);
    // Only when the sheet still has the pre-swap number, so a sheet that has
    // since been corrected isn't touched.
    if (h && h.house_no === fix.was) {
      h.house_no = fix.houseNo;
      addAnomaly(anomalies, 'house_corrected', 'info', fix.farmUnit, `House set to ${fix.houseNo} (the sheet still has ${fix.was}; houses were swapped).`);
    }
  }

  const byUnit = new Map();
  for (const p of people) byUnit.set(p.farmUnit, (byUnit.get(p.farmUnit) ?? 0) + 1);
  for (const [unit, count] of byUnit) {
    if (count > 2) addAnomaly(anomalies, 'household_over_two_people', 'warn', unit, `${count} people listed; only 2 can sign in.`);
  }
  for (const h of households.values()) {
    if (!h.house_no) addAnomaly(anomalies, 'household_without_house', 'info', h.farm_unit, 'No house number (probably not built yet).');
    if (!h.cluster && h.house_no) addAnomaly(anomalies, 'household_without_cluster', 'warn', h.farm_unit, 'House has no cluster.');
  }
  const noEmail = people.filter((p) => !p.email).length;
  addAnomaly(anomalies, 'people_without_email', 'info', null, `${noEmail} of ${people.length} people have no email on file; collected at first sign-in.`);

  const match = matcher(households, people);
  const plots = parsePattas(tabs['Farm Patta Details'] ?? [], anomalies, match, households);
  const housePattas = parseHousePattas(tabs['House Patta Details'] ?? [], anomalies, match, households);

  const notes = people
    .filter((p) => p.pattaIssue)
    .map((p) => ({ farmUnit: p.farmUnit, kind: 'patta_issue', note: null }));

  return {
    households: [...households.values()].sort((a, b) => a.farm_unit.localeCompare(b.farm_unit)),
    people,
    plots,
    housePattas,
    notes,
    anomalies,
  };
}

// Plain-text summary for the CLI's dry run.
export function summarize(register) {
  const bySeverity = {};
  for (const a of register.anomalies) bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
  const byKind = {};
  for (const a of register.anomalies) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  return {
    households: register.households.length,
    people: register.people.length,
    peopleWithEmail: register.people.filter((p) => p.email).length,
    farmPlots: register.plots.length,
    housePattas: register.housePattas.length,
    anomaliesBySeverity: bySeverity,
    anomaliesByKind: byKind,
  };
}
