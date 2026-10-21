// The public export: turns the portal's approved stories into the cards on the public Members
// page (src/data/members.ts), and merges them over the 2017 cards. Pure (no network), so the
// rules are tested on their own; netlify/functions/members-public.mts selects the rows and calls
// buildPublished, and src/data/members.ts calls mergePublished with what the build wrote.
//
// What gets published: for each household, the APPROVED copy of each primary member's story, and
// only if its "Show on tvc.farm" switch is on. Nothing in a draft or in review is ever read. A person
// who is inactive or has switched off their directory listing is left out entirely.
//
// A card is a household. It keeps the name the 2017 card had (member_cards, in the order of the
// names, because quotes and profile links pair with the names by position); a household with no
// mapping gets a name made from its primary members'. Two people's stories that say the same thing
// (the seeded cards) become one bio; different quotes stay as one per person.

import { isLegacyPhoto, isPhotoRef, isUploadedPhoto } from './member-photo.mjs';

const first = (full) => String(full).trim().split(/\s+/)[0] ?? '';
const clean = (s) => (typeof s === 'string' ? s.trim() : '');
const uniq = (list) => [...new Set(list.filter(Boolean))];

// "Bo", "Bo & Cy", "Ishan, Kavya & Leela"
export function joinNames(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}` : (names[0] ?? '');
}

// The card name for a household that has no mapping: first names when there are several primary
// members, the full name when there is one (the way the 2017 cards read).
export function cardNameFor(primaryFullNames) {
  return primaryFullNames.length > 1 ? joinNames(primaryFullNames.map(first)) : (primaryFullNames[0] ?? '').trim();
}

/**
 * @param {{
 *   households: { id: string }[],
 *   people: { id: string, full_name: string, active?: boolean, directory_visible?: boolean }[],
 *   memberships: { household_id: string, person_id: string, role?: string }[],
 *   stories: { person_id: string, approved: any, approved_public: boolean | null }[],
 *   cards: { household_id: string, card_name: string, person_ids: string[] }[],
 * }} data
 * @returns {{ mappingReady: boolean, cards: object[], hidden: string[] }}
 */
export function buildPublished(data) {
  const mapping = new Map(data.cards.map((c) => [c.household_id, c]));
  // Until the mapping has been filled in, a household that has no card name of its own would be named
  // from the register and could duplicate a 2017 card under another spelling, so it is not published.
  const mappingReady = data.cards.length > 0;
  const listed = new Map(data.people.filter((p) => p.active !== false && p.directory_visible !== false).map((p) => [p.id, p]));
  const storyBy = new Map(data.stories.map((s) => [s.person_id, s]));

  const cards = [];
  const hidden = [];
  for (const hh of data.households) {
    const members = data.memberships
      .filter((m) => m.household_id === hh.id && listed.has(m.person_id))
      .map((m) => ({ ...listed.get(m.person_id), role: m.role ?? 'owner' }));
    const card = mapping.get(hh.id);
    // Nobody listed (all inactive, or all switched off their listing): a 2017 card must not stay in full.
    if (members.length === 0) {
      if (card) hidden.push(card.card_name);
      continue;
    }
    const order = new Map((card?.person_ids ?? []).map((id, i) => [id, i]));
    const anyOwner = members.some((m) => m.role === 'owner');
    const primary = members
      .filter((m) => !anyOwner || m.role === 'owner')
      .sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99) || a.full_name.localeCompare(b.full_name));
    const family = members.filter((m) => anyOwner && m.role !== 'owner');

    // each primary member's approved, public story (the position in `primary` is the position of the name)
    const stories = primary.map((p) => {
      const row = storyBy.get(p.id);
      return row?.approved && row.approved_public === true ? row.approved : null;
    });
    const name = card?.card_name ?? (mappingReady ? cardNameFor(primary.map((p) => p.full_name)) : '');
    if (!name) continue;
    if (!stories.some(Boolean)) {
      if (card) hidden.push(name); // a 2017 card whose household has nothing public: shown as just a name
      continue;
    }

    const texts = (key) => stories.filter(Boolean).map((s) => clean(s[key]));
    const bio = uniq(texts('bio')).join(' ');
    const familyText = uniq(texts('family')).join(' ');
    // one quote when everyone says the same; otherwise one each, in the order of the names
    const whys = stories.map((s) => clean(s?.why));
    const whyList = uniq(whys);
    const social = stories.map((s) => clean(s?.social));
    while (social.length && !social[social.length - 1]) social.pop();
    // a unit story brings all of the unit's photos, an older story its single one; the same photo twice shows once
    const photos = uniq(stories.flatMap((s) => s?.photos ?? [clean(s?.photo)]));

    const out = { name, bio, photo: photos[0] ?? null };
    if (photos.length > 1) out.photos = photos;
    if (familyText) out.family = familyText;
    const familyNames = family.map((f) => first(f.full_name));
    if (familyNames.length) out.familyNames = familyNames;
    if (whyList.length === 1) out.whyTVC = whyList[0];
    else if (whyList.length > 1) out.whyTVC = whys.filter(Boolean);
    if (social.some(Boolean)) out.social = social;
    cards.push(out);
  }
  return { mappingReady, cards, hidden };
}

/**
 * The same cards, from stories that belong to a whole UNIT (member_unit_stories). Only the approved copy,
 * and only when the unit's public switch is on, is read. The unit's text is the same for everyone in it and
 * each person has their own quote and link, so it is handed to buildPublished as one story per person:
 * the shared bio and family, that person's quote and link, and the unit's photos (the card shows them as a stack when there is more than one). buildPublished then does everything it always did: the 2017 card name, who is listed and
 * primary, one bio when everyone's text is the same, quotes and links paired with the names by position.
 *
 * @param {Omit<Parameters<typeof buildPublished>[0], 'stories'> & { unitStories: { household_id: string, approved: any, approved_public: boolean | null }[] }} data
 */
export function buildPublishedUnits(data) {
  const stories = [];
  for (const unit of data.unitStories) {
    if (!unit.approved || unit.approved_public !== true) continue;
    const photos = (unit.approved.photos ?? []).map((p) => clean(p?.ref)).filter(Boolean);
    for (const m of data.memberships.filter((x) => x.household_id === unit.household_id)) {
      stories.push({
        person_id: m.person_id,
        approved: { bio: unit.approved.bio, family: unit.approved.family, why: unit.approved.quotes?.[m.person_id] ?? '', social: unit.approved.links?.[m.person_id] ?? '', photo: photos[0] ?? '', photos },
        approved_public: true,
      });
    }
  }
  return buildPublished({ ...data, stories });
}

/**
 * Whose files a PUBLIC photo of a unit story is served from, or null. Only a photo in the approved copy of
 * a unit whose public switch is on; and the member who uploaded it must still be listed (active, directory
 * on) and an owner of that unit, like everything else published. The files sit under the uploader's id.
 */
export function publishedUnitPhotoHolder({ row, photoId, people, memberships }) {
  if (!row?.approved || row.approved_public !== true) return null;
  const holder = (row.approved.photos ?? []).find((p) => p.ref === photoId);
  if (!holder) return null;
  const person = people.find((p) => p.id === holder.personId);
  if (!person || person.active === false || person.directory_visible === false) return null;
  const owns = memberships.some((m) => m.person_id === holder.personId && m.household_id === row.household_id && (m.role ?? 'owner') === 'owner');
  return owns ? holder.personId : null;
}

/**
 * Merges the published cards over the legacy ones. A legacy card keeps its place and its name; its
 * content is replaced by the published one, except for hand-written extras that still apply:
 *   - `summary` (the card-front line) while the bio is unchanged
 *   - `photoFull` / `photos` / `photosFull` while the photo is unchanged
 * A card the export says is hidden is reduced to its name (the household switched it off). A
 * published card with no legacy card is a new member and is added.
 *
 * @param {object[]} legacy
 * @param {{ cards?: object[], hidden?: string[] } | null | undefined} published
 */
export function mergePublished(legacy, published) {
  const byName = new Map((published?.cards ?? []).map((c) => [c.name, c]));
  const hidden = new Set(published?.hidden ?? []);
  const used = new Set();
  const merged = legacy.map((old) => {
    if (hidden.has(old.name)) return { name: old.name, bio: '', photo: null };
    const next = byName.get(old.name);
    if (!next) return old;
    used.add(old.name);
    const out = { ...next, photo: next.photo ?? null };
    if (old.summary && old.bio === next.bio) out.summary = old.summary;
    if (old.photo && old.photo === next.photo && !next.photos) {
      if (old.photoFull) out.photoFull = old.photoFull;
      if (old.photos) out.photos = old.photos;
      if (old.photosFull) out.photosFull = old.photosFull;
    }
    // a 2017 card's list of family names still applies while its family text is unchanged
    if (!out.familyNames && old.familyNames && old.family === next.family) out.familyNames = old.familyNames;
    return out;
  });
  for (const card of byName.values()) if (!used.has(card.name)) merged.push(card);
  return merged;
}

// ---- what the build does with the response ------------------------------------------------------

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v.trim() : '');

/**
 * The build never trusts the response: anything that is not the exact shape it expects is dropped,
 * and a card with an invalid photo reference or link just loses that field. Returns
 * { cards, hidden } with only valid values, or null if `raw` is not a usable response at all.
 */
export function sanitizePublished(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cards) || !Array.isArray(raw.hidden)) return null;
  const cards = [];
  for (const c of raw.cards) {
    const name = str(c?.name, 120);
    if (!name) continue;
    const card = { name, bio: str(c.bio, 6000), photo: isPhotoRef(c.photo) ? c.photo : null };
    if (Array.isArray(c.photos)) {
      const photos = c.photos.filter(isPhotoRef);
      if (photos.length > 1) card.photos = photos;
    }
    if (str(c.family, 3000)) card.family = str(c.family, 3000);
    if (Array.isArray(c.familyNames)) card.familyNames = c.familyNames.map((n) => str(n, 60)).filter(Boolean);
    if (typeof c.whyTVC === 'string' && str(c.whyTVC, 1000)) card.whyTVC = str(c.whyTVC, 1000);
    else if (Array.isArray(c.whyTVC)) card.whyTVC = c.whyTVC.map((w) => str(w, 1000)).filter(Boolean);
    if (Array.isArray(c.social)) {
      const social = c.social.map((u) => (/^https?:\/\//i.test(String(u)) && String(u).length <= 300 ? String(u).trim() : ''));
      if (social.some(Boolean)) card.social = social;
    }
    cards.push(card);
  }
  return { cards, hidden: raw.hidden.map((n) => str(n, 120)).filter(Boolean) };
}

// The uploaded photos a set of cards needs the build to download.
export function uploadedPhotos(cards) {
  return uniq(cards.flatMap((c) => [c.photo, ...(c.photos ?? [])]).filter(isUploadedPhoto));
}

const slugOf = (name) => name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Where a downloaded photo is written, under public/images/members: slug + the start of its id, so a
// replaced photo is a new file (and a new URL) rather than a stale cached one.
export const photoFileFor = (cardName, photoId) => ({
  square: `/images/members/up-${slugOf(cardName)}-${photoId.slice(0, 8)}.jpg`,
  full: `/images/members/up-${slugOf(cardName)}-${photoId.slice(0, 8)}-full.jpg`,
});

// Swaps every uploaded-photo reference for the site path it was downloaded to (`downloaded` is the set of
// ids that arrived); a photo that could not be fetched is dropped rather than left pointing at nothing.
export function resolvePhotos(card, downloaded) {
  const pathFor = (ref, which) => (isLegacyPhoto(ref) ? (which === 'square' ? ref : null) : downloaded.has(ref) ? photoFileFor(card.name, ref)[which] : null);
  const refs = uniq([card.photo, ...(card.photos ?? [])]).filter((r) => isLegacyPhoto(r) || downloaded.has(r));
  const out = { ...card };
  delete out.photos;
  out.photo = refs[0] ? pathFor(refs[0], 'square') : null;
  if (refs.length > 1) out.photos = refs.map((r) => pathFor(r, 'square'));
  // The uncropped copies, by position, only where there is one (an upload); a public-site photo has its own.
  const fulls = refs.map((r) => pathFor(r, 'full'));
  if (fulls.some(Boolean)) {
    if (refs.length > 1) out.photosFull = fulls.map((f, i) => f ?? out.photos[i]);
    else if (fulls[0]) out.photoFull = fulls[0];
  }
  return out;
}
