// The member portal's site map: what a signed-in member may see of each home. Pure (no network), so the rule is tested on
// its own; netlify/functions/members-sitemap.mts selects the rows and calls this.
//
// The privacy rule is the directory's (member-directory.mjs): a person is named only when they are active and have not
// opted out (directory_visible); nothing else about a person is ever passed in. A home with a household but nobody
// listed is "private" (no name, no profile to open); a home with no household is "vacant". The unit's shape and type are
// facts about the home, not the member, so they are shown for every home.

import { bedroomsOf } from './member-directory.mjs';

// The standard unit shapes, in the member portal's words. The drawing is the same for everyone; only the label is here.
export const SHAPES = {
  S: { bhk: '1 BHK', detail: 'All on the ground floor' },
  DG: { bhk: '2 BHK', detail: 'Second bedroom on the ground floor' },
  DF: { bhk: '2 BHK', detail: 'Second bedroom on the first floor' },
  DO: { bhk: '2 BHK', detail: 'Second bedroom in a separate block' },
  TO: { bhk: '3 BHK', detail: 'Two blocks, third bedroom on the first floor' },
};
export const shapeIds = () => Object.keys(SHAPES);

// H-07 -> 7, so homes sort and search by number.
export const houseNumber = (houseNo) => parseInt(String(houseNo).slice(2), 10) || 0;

/**
 * @param {{
 *   units: { house_no: string, cluster: string, shape: string, x: number | string, y: number | string, rotation: number | string, mirror_x: boolean, mirror_y: boolean }[],
 *   households: { id: string, farm_unit: string, house_no: string | null, unit_type?: string | null }[],
 *   people: { id: string, full_name: string, active?: boolean, directory_visible?: boolean }[],
 *   memberships: { household_id: string, person_id: string, role?: string }[],
 * }} data
 * @param {string | null} viewerHouseholdId the signed-in member's household, to mark "yours"
 */
export function buildSiteMap(data, viewerHouseholdId) {
  const listed = new Map(data.people.filter((p) => p.active !== false && p.directory_visible !== false).map((p) => [p.id, p]));
  const householdByHouse = new Map(data.households.filter((h) => h.house_no).map((h) => [h.house_no, h]));

  const units = data.units.map((u) => {
    const hh = householdByHouse.get(u.house_no) ?? null;
    const members = hh ? data.memberships.filter((m) => m.household_id === hh.id && listed.has(m.person_id)) : [];
    // Owners are the primary members; if none of the listed people is an owner, everyone listed is shown (as in the directory).
    const owners = members.some((m) => (m.role ?? 'owner') === 'owner') ? members.filter((m) => (m.role ?? 'owner') === 'owner') : members;
    const names = owners.map((m) => listed.get(m.person_id).full_name).sort((a, b) => a.localeCompare(b));
    const status = !hh ? 'vacant' : names.length ? 'named' : 'private';
    const shape = SHAPES[u.shape] ? u.shape : 'S';
    return {
      houseNo: u.house_no,
      cluster: u.cluster,
      shape,
      x: Number(u.x),
      y: Number(u.y),
      rotation: Number(u.rotation),
      mirrorX: !!u.mirror_x,
      mirrorY: !!u.mirror_y,
      status,
      names,
      // The member record's own code (DG1, TO1-V2) when there is one; the bedroom count follows the record, as in the directory.
      unitType: hh?.unit_type ?? null,
      bhk: bedroomsOf(hh?.unit_type) ?? SHAPES[shape].bhk,
      detail: SHAPES[shape].detail,
      // The directory only lists a household with somebody named, so only then is there a profile to open.
      farmUnit: status === 'named' ? hh.farm_unit : null,
      isYours: !!hh && hh.id === viewerHouseholdId,
    };
  });
  return units.sort((a, b) => houseNumber(a.houseNo) - houseNumber(b.houseNo));
}

// Clusters as sent to the page: the plot lines, view box and the one base size every home in the cluster is drawn at.
export function shapeClusters(rows) {
  return rows.map((c) => ({ id: c.cluster, baseSize: Number(c.base_size), viewBox: c.view_box, plot: c.plot_path }));
}
