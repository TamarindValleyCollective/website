// The member directory: what one signed-in member may see of the others. Pure (no
// network), so the rule is tested on its own; netlify/functions/members-me.mts selects
// the rows and calls this.
//
// What other members see: a person's name (the card shows only the primary members, the popup everyone), the photo the core team approved for them, their household's farm plot number, house
// number (if a house is built) and cluster, and the story the core team has APPROVED for them (the `approved` copy, never a
// draft or a submission in review, and whether or not it is also on tvc.farm). Never an
// email, mobile number, land record or document: those columns are not even passed in.
//
// Listing is opt-out: a person with directory_visible = false (or who is inactive) does not
// appear, and neither does their story. A household with nobody listed does not appear.
// Households are the unit shown (as on the public Members page), people sit inside them.
//
// Stories seeded from the public cards (and any couple who wrote the same text) have the same bio
// and family on both people. `groups` merges those into one section, so the popup shows the text
// once, with each person's own quote and link beneath it; people with different text stay in their
// own section. `withoutStory` lists the people who have none.

import { isPhotoRef } from './member-photo.mjs';

const farmNumber = (unit) => parseInt(String(unit).slice(2), 10) || 0;
// H-07 -> 7; a household with no house built yet has none and sorts after every house.
const houseNumber = (house) => (house ? parseInt(String(house).slice(2), 10) || Infinity : Infinity);

const text = (v) => (typeof v === 'string' ? v.trim() : '');

// Only an http(s) link is ever handed to the page as a link.
const safeLink = (v) => {
  const s = text(v);
  return /^https?:\/\//i.test(s) ? s : '';
};

// The approved copy's photo (a uuid for an upload, or a path on the public site), or '' if none or
// anything else. A person can have a photo and no text.
const photoFor = (row) => (row?.approved && isPhotoRef(row.approved.photo) ? row.approved.photo : '');

function storyFor(row) {
  if (!row || !row.approved) return null;
  const a = row.approved;
  const story = { bio: text(a.bio), family: text(a.family), why: text(a.why), social: safeLink(a.social), onPublicSite: !!row.approved_public };
  // An approved story with every field empty has nothing to show.
  return story.bio || story.family || story.why || story.social ? story : null;
}


// People whose approved bio and family are identical share one section. A story with neither
// (only a quote or a link) is never merged: there is nothing shared to show once.
function groupStories(people) {
  const groups = [];
  const byKey = new Map();
  for (const p of people) {
    if (!p.story) continue;
    const { bio, family } = p.story;
    const key = bio || family ? `${bio}\u0000${family}` : null;
    let g = key ? byKey.get(key) : null;
    if (!g) {
      g = { people: [], bio, family, quotes: [], links: [], onPublicSite: true };
      groups.push(g);
      if (key) byKey.set(key, g);
    }
    g.people.push({ name: p.name, isYou: p.isYou });
    if (p.story.why) g.quotes.push({ name: p.name, why: p.story.why });
    if (p.story.social) g.links.push({ name: p.name, url: p.story.social });
    g.onPublicSite = g.onPublicSite && p.story.onPublicSite;
  }
  // The same quote on everyone (a couple's shared sentence) is shown once, unattributed.
  for (const g of groups) {
    if (g.quotes.length > 1 && g.quotes.every((q) => q.why === g.quotes[0].why)) g.quotes = [{ name: null, why: g.quotes[0].why }];
  }
  return groups;
}

/**
 * @param {{
 *   people: { id: string, full_name: string, active?: boolean, directory_visible?: boolean }[],
 *   memberships: { household_id: string, person_id: string, role?: string }[],
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
      .map((m) => ({ ...listed.get(m.person_id), role: m.role ?? 'owner' }))
      // The viewer first, then the primary members (owners), then everyone else, each by name.
      .sort((a, b) => Number(b.id === viewerPersonId) - Number(a.id === viewerPersonId) || Number(b.role === 'owner') - Number(a.role === 'owner') || a.full_name.localeCompare(b.full_name));
    if (members.length === 0) continue;
    // Primary members are the household's owners. If none of the listed people is one, everyone is
    // treated as primary, so a card is never nameless.
    const anyOwner = members.some((p) => p.role === 'owner');
    const people = members.map((p) => ({
      name: p.full_name,
      isYou: p.id === viewerPersonId,
      primary: !anyOwner || p.role === 'owner',
      photo: photoFor(storyByPerson.get(p.id)),
      story: storyFor(storyByPerson.get(p.id)),
    }));
    out.push({
      farmUnit: hh.farm_unit,
      houseNo: hh.house_no ?? null,
      cluster: hh.cluster ?? null,
      people,
      groups: groupStories(people),
      // The primary members with no story, and the rest of the household (children, other family), who are
      // named in the popup's family section rather than getting a block each.
      withoutStory: people.filter((p) => p.primary && !p.story).map((p) => ({ name: p.name, isYou: p.isYou })),
      familyMembers: people.filter((p) => !p.primary).map((p) => ({ name: p.name, isYou: p.isYou })),
      hasStory: people.some((p) => p.story),
    });
  }
  // In house-number order (H-01, H-02...); households with no house yet come last, by farm plot.
  return out.sort((a, b) => {
    const ha = houseNumber(a.houseNo);
    const hb = houseNumber(b.houseNo);
    if (ha !== hb) return ha < hb ? -1 : 1;
    return farmNumber(a.farmUnit) - farmNumber(b.farmUnit);
  });
}

/**
 * The same directory, from stories that belong to a whole UNIT (member_unit_stories). A unit's text is
 * shared by its owners and each owner has their own quote and link, so it is handed to buildDirectory as
 * one story per owner: the shared bio and family, that person's quote and link. Everything buildDirectory
 * does is unchanged (who is listed, primary members, house-number order, no contact or land fields), and
 * the owners' identical text is one section for the right reason: it IS one story, not two that happen
 * to match, so one owner editing never splits it. The unit's photos (at most two, not tied to a person)
 * are dealt to its owners in the order they appear, the viewer first, so a card can show two faces.
 *
 * @param {Omit<Parameters<typeof buildDirectory>[0], 'stories'> & { unitStories: { household_id: string, approved: any, approved_public: boolean | null }[] }} data
 */
export function buildUnitDirectory(data, viewerPersonId) {
  const listed = new Set(data.people.filter((p) => p.active !== false && p.directory_visible !== false).map((p) => p.id));
  const stories = [];
  const unitByFarm = new Map();
  for (const unit of data.unitStories) {
    if (!unit.approved) continue;
    const hh = data.households.find((h) => h.id === unit.household_id);
    if (hh) unitByFarm.set(hh.farm_unit, unit);
    const members = data.memberships.filter((m) => m.household_id === unit.household_id && listed.has(m.person_id));
    const anyOwner = members.some((m) => (m.role ?? 'owner') === 'owner');
    for (const m of members) {
      if (anyOwner && (m.role ?? 'owner') !== 'owner') continue; // the family section names them; the story is the owners'
      stories.push({
        person_id: m.person_id,
        approved: { bio: unit.approved.bio, family: unit.approved.family, why: unit.approved.quotes?.[m.person_id] ?? '', social: unit.approved.links?.[m.person_id] ?? '' },
        approved_public: unit.approved_public,
      });
    }
  }
  const directory = buildDirectory({ ...data, stories }, viewerPersonId);
  for (const hh of directory) {
    const photos = (unitByFarm.get(hh.farmUnit)?.approved.photos ?? []).map((p) => text(p.ref)).filter(isPhotoRef);
    hh.people.filter((p) => p.primary).forEach((p, i) => {
      if (photos[i]) p.photo = photos[i];
    });
  }
  return directory;
}

/**
 * The faces a card or a popup header shows. A unit's photos belong to the unit, not to a person, so when
 * only some of its people have one (one photo uploaded for two owners) the others' initials would be a stray
 * circle beside the picture: only people with a photo are shown, and everyone when nobody has one.
 * Outside the unit model a person without a photo still shows their initial, as it always did.
 * @template {{ photo?: string | null }} P
 * @param {P[]} people
 * @param {boolean} unitMode
 * @returns {P[]}
 */
export function facesToShow(people, unitMode) {
  if (!unitMode) return people;
  const withPhoto = people.filter((p) => p.photo);
  return withPhoto.length ? withPhoto : people;
}
