// The member directory: what one signed-in member may see of the others. Pure (no
// network), so the rule is tested on its own; netlify/functions/members-me.mts selects
// the rows and calls this.
//
// What other members see: a person's name, their household's farm plot number, house
// number (if a house is built) and cluster, and the story the core team has APPROVED for them (the `approved` copy, never a
// draft or a submission in review, and whether or not it is also on tvc.farm). Never an
// email, mobile number, land record or document: those columns are not even passed in.
//
// Listing is opt-out: a person with directory_visible = false (or who is inactive) does not
// appear, and neither does their story. A household with nobody listed does not appear.
// Households are the unit shown (as on the public Members page), people sit inside them.

const farmNumber = (unit) => parseInt(String(unit).slice(2), 10) || 0;

const text = (v) => (typeof v === 'string' ? v.trim() : '');

// Only an http(s) link is ever handed to the page as a link.
const safeLink = (v) => {
  const s = text(v);
  return /^https?:\/\//i.test(s) ? s : '';
};

function storyFor(row) {
  if (!row || !row.approved) return null;
  const a = row.approved;
  const story = { bio: text(a.bio), family: text(a.family), why: text(a.why), social: safeLink(a.social), onPublicSite: !!row.approved_public };
  // An approved story with every field empty has nothing to show.
  return story.bio || story.family || story.why || story.social ? story : null;
}

/**
 * @param {{
 *   people: { id: string, full_name: string, active?: boolean, directory_visible?: boolean }[],
 *   memberships: { household_id: string, person_id: string }[],
 *   households: { id: string, farm_unit: string, house_no?: string | null, cluster: string | null }[],
 *   stories: { person_id: string, approved: any, approved_public: boolean | null }[],
 * }} data
 * @param {string} viewerPersonId
 */
export function buildDirectory(data, viewerPersonId) {
  const listed = new Map(data.people.filter((p) => p.active !== false && p.directory_visible !== false).map((p) => [p.id, p]));
  const storyByPerson = new Map(data.stories.map((s) => [s.person_id, s]));

  const out = [];
  for (const hh of data.households) {
    const members = data.memberships
      .filter((m) => m.household_id === hh.id && listed.has(m.person_id))
      .map((m) => listed.get(m.person_id))
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
    if (members.length === 0) continue;
    const people = members.map((p) => ({ name: p.full_name, isYou: p.id === viewerPersonId, story: storyFor(storyByPerson.get(p.id)) }));
    out.push({ farmUnit: hh.farm_unit, houseNo: hh.house_no ?? null, cluster: hh.cluster ?? null, people, hasStory: people.some((p) => p.story) });
  }
  return out.sort((a, b) => farmNumber(a.farmUnit) - farmNumber(b.farmUnit));
}
