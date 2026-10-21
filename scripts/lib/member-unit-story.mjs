// A unit's story: one record per unit, not one per person. Pure (no network), so the rules are
// tested on their own. See docs/plans/member-portal.md ("Member stories").
//
// Shared by everyone in the unit: bio, family, up to MAX_PHOTOS photos and whether it shows on
// tvc.farm. Personal: each person's own quote and profile link (the directory turns a first name in
// the story into that person's link), kept under their id in `quotes` and `links`.

import { MAX_LINKS, linksIn } from './member-markdown.mjs';
import { LIMITS } from './member-story.mjs';

export const MAX_PHOTOS = 2;

const text = (v) => (typeof v === 'string' ? v.trim() : '');

// The shared text of one per-person copy ({ bio, family, why, social, photo }).
const sharedOf = (c) => ({ bio: text(c?.bio), family: text(c?.family) });

// Merges one kind of copy (draft / submitted / approved) across the unit's people. The shared
// fields come from the copy with the latest timestamp (a person who edited beats the seed that every
// housemate still holds); each person keeps their own quote. `diverged` is true when the people's
// shared text differed, so a person can check which copy won.
const hasContent = (c) => !!c && typeof c === 'object' && ['bio', 'family', 'why', 'social', 'photo'].some((k) => text(c[k]));

function mergeCopy(rows, { field, at, only = () => true }) {
  const copies = rows.filter((r) => only(r) && hasContent(r[field]));
  if (copies.length === 0) return null;
  const newest = [...copies].sort((a, b) => String(b[at] ?? '').localeCompare(String(a[at] ?? '')))[0];
  const quotes = {};
  const links = {};
  for (const r of copies) {
    if (text(r[field].why)) quotes[r.person_id] = text(r[field].why);
    if (text(r[field].social)) links[r.person_id] = text(r[field].social);
  }
  // Newest first, each photo once, remembering who holds it (uploaded photos are stored under their id).
  const photos = [];
  for (const r of [...copies].sort((a, b) => String(b[at] ?? '').localeCompare(String(a[at] ?? '')))) {
    const ref = text(r[field].photo);
    if (ref && !photos.some((p) => p.ref === ref)) photos.push({ ref, personId: r.person_id });
  }
  const key = (r) => JSON.stringify([sharedOf(r[field]).bio, sharedOf(r[field]).family]);
  return { copy: { ...sharedOf(newest[field]), photos: photos.slice(0, MAX_PHOTOS), quotes, links }, winner: newest, diverged: new Set(copies.map(key)).size > 1 };
}

/**
 * @param {{ person_id: string, draft: any, draft_public: boolean, status: string, submitted: any,
 *   submitted_public: boolean | null, submitted_at: string | null, approved: any,
 *   approved_public: boolean | null, approved_at: string | null, updated_at: string }[]} rows
 *   the unit's per-person member_stories rows
 */
export function buildUnitStory(rows) {
  const approved = mergeCopy(rows, { field: 'approved', at: 'approved_at' });
  const draft = mergeCopy(rows, { field: 'draft', at: 'updated_at' });
  const inReview = rows.some((r) => r.status === 'in_review');
  // A snapshot only counts while it is under review; a decided one is history.
  const submitted = inReview ? mergeCopy(rows, { field: 'submitted', at: 'submitted_at', only: (r) => r.status === 'in_review' }) : null;
  return {
    story: {
      draft: draft?.copy ?? null,
      draftPublic: draft ? !!draft.winner.draft_public : null,
      submitted: submitted?.copy ?? null,
      submittedPublic: submitted ? !!submitted.winner.submitted_public : null,
      submittedAt: submitted?.winner.submitted_at ?? null,
      approved: approved?.copy ?? null,
      approvedPublic: approved ? !!approved.winner.approved_public : null,
      approvedAt: approved?.winner.approved_at ?? null,
      status: inReview ? 'in_review' : approved ? 'approved' : 'draft',
    },
    diverged: [approved, draft, submitted].some((m) => m?.diverged),
    // Whose copy supplied the shared text of each kind, so a diverged unit can be reviewed.
    winners: { approved: approved?.winner.person_id ?? null, draft: draft?.winner.person_id ?? null, submitted: submitted?.winner.person_id ?? null },
  };
}

// Adds one photo to the unit's photos if there is room and it isn't already there.
// photo: { ref, personId } (the uploader's id is part of its storage path).
/** @returns {{ ok: true, photos: any[] } | { ok: false, error: string }} */
export function addPhoto(photos, photo) {
  if (photos.some((p) => p.ref === photo.ref)) return { ok: false, error: 'duplicate' };
  if (photos.length >= MAX_PHOTOS) return { ok: false, error: 'full' };
  return { ok: true, photos: [...photos, photo] };
}

// Applies one owner's save to the unit's shared draft, field by field, so two owners editing at once
// only collide when they touch the same field.
//   current:     { version, fields: { bio, family, photos, quotes, links, public }, changed: { field: version } }
//   changes:     only the fields this save touches
//   baseVersion: the version the editor was looking at when they started
// Returns { ok: true, fields, changed, version } or { ok: false, error, fields: [...] }.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SHARED_FIELDS = ['bio', 'family', 'photos', 'public'];
// Personal fields: a save names one, and it always means the editor's own entry in the map.
const OWN = { quote: 'quotes', link: 'links' };

/** @returns {{ ok: true, fields: any, changed: Record<string, number>, version: number } | { ok: false, error: string, fields: string[] }} */
export function mergeDraftEdit({ current, changes, baseVersion, personId }) {
  // A save can only name story fields, and "quote" / "link" always mean the editor's own: there is no
  // way to address another person's.
  const unknown = Object.keys(changes).filter((name) => !SHARED_FIELDS.includes(name) && !(name in OWN));
  if (unknown.length) return { ok: false, error: 'unknown', fields: unknown };
  if (changes.photos && (changes.photos.length > MAX_PHOTOS || new Set(changes.photos.map((p) => p.ref)).size !== changes.photos.length)) {
    return { ok: false, error: 'invalid', fields: ['photos'] };
  }
  const fields = { ...current.fields, quotes: { ...current.fields.quotes }, links: { ...current.fields.links } };
  const changed = { ...current.changed };
  const touched = [];
  const conflicts = [];
  for (const [name, value] of Object.entries(changes)) {
    const key = name in OWN ? `${name}:${personId}` : name;
    if (same(value, name in OWN ? fields[OWN[name]][personId] : fields[name])) continue;
    if ((current.changed[key] ?? 0) > baseVersion) conflicts.push(name);
    touched.push(name);
  }
  if (conflicts.length) return { ok: false, error: 'conflict', fields: conflicts };
  for (const name of touched) {
    if (name in OWN) fields[OWN[name]][personId] = changes[name];
    else fields[name] = changes[name];
  }
  const version = touched.length ? current.version + 1 : current.version;
  for (const name of touched) changed[name in OWN ? `${name}:${personId}` : name] = version;
  return { ok: true, fields, changed, version };
}

// ---- what an owner may send when saving ----

const fail = (error) => ({ ok: false, error });
const clean = (v) => v.replace(/\r\n?/g, '\n').trim();
const SAVE_TEXT = { bio: 'bio', family: 'family', quote: 'why', link: 'social' }; // field -> the existing limit it follows

// body: { baseVersion, bio?, family?, quote?, link?, showOnPublicSite? }. Only what changed is sent, so
// two owners saving different fields never overwrite each other (mergeDraftEdit). The photos change
// through their own endpoints, never here.
/** @returns {{ ok: true, baseVersion: number, changes: Record<string, any> } | { ok: false, error: string }} */
export function validateUnitSave(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail('Nothing to do.');
  if (!Number.isInteger(body.baseVersion) || body.baseVersion < 0) return fail('Reload the page and try again.');
  const known = ['baseVersion', ...Object.keys(SAVE_TEXT), 'showOnPublicSite'];
  if (Object.keys(body).some((k) => !known.includes(k))) return fail('Unknown field.');

  const changes = {};
  for (const [field, limitKey] of Object.entries(SAVE_TEXT)) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== 'string') return fail('Each answer must be text.');
    const value = clean(v);
    if (value.length > LIMITS[limitKey]) return fail(`That answer is too long (the limit is ${LIMITS[limitKey]} characters).`);
    changes[field] = value;
  }
  if (changes.link) {
    let url;
    try {
      url = new URL(changes.link);
    } catch {
      return fail('The profile link should be a full web address starting with https://');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('The profile link should be a web address starting with https://');
  }
  if (linksIn(changes.bio ?? '').length + linksIn(changes.family ?? '').length > MAX_LINKS) return fail(`A story can have up to ${MAX_LINKS} links.`);
  if (body.showOnPublicSite !== undefined) {
    if (typeof body.showOnPublicSite !== 'boolean') return fail('"Show on tvc.farm" must be on or off.');
    changes.public = body.showOnPublicSite;
  }
  if (Object.keys(changes).length === 0) return fail('Nothing to do.');
  return { ok: true, baseVersion: body.baseVersion, changes };
}

// ---- the shared draft in the database, and what the page shows ----

const EMPTY_FIELDS = () => ({ bio: '', family: '', photos: [], quotes: {}, links: {}, public: false });

// A member_unit_stories row (or null, for a unit with none yet) as the state mergeDraftEdit works on.
export function draftState(row) {
  if (!row) return { version: 0, fields: EMPTY_FIELDS(), changed: {} };
  return { version: row.draft_version ?? 0, fields: { ...EMPTY_FIELDS(), ...(row.draft ?? {}), public: !!row.draft_public }, changed: row.draft_changed ?? {} };
}

// The columns a saved draft writes: the public switch is its own column, the rest is the draft copy.
export function draftColumns({ fields, version, changed }) {
  const { public: isPublic, ...copy } = fields;
  return { draft: copy, draft_public: !!isPublic, draft_version: version, draft_changed: changed };
}

// Handing the story in needs the person submitting to have written their own "why TVC" line.
/** @returns {{ ok: true } | { ok: false, error: string }} */
export function validateUnitSubmit({ fields, personId }) {
  return text(fields.quotes?.[personId]) ? { ok: true } : fail('Add your one-line "why TVC" before submitting.');
}

const copyOf = (c) => ({ bio: text(c?.bio), family: text(c?.family), photos: c?.photos ?? [], quotes: c?.quotes ?? {}, links: c?.links ?? {} });
const sameCopy = (a, b) => same(copyOf(a), copyOf(b));
const emptyCopy = (c) => !text(c?.bio) && !text(c?.family) && !(c?.photos ?? []).length && !Object.keys(c?.quotes ?? {}).length && !Object.keys(c?.links ?? {}).length;

/**
 * What the page shows one owner: the shared story, their own quote and link to edit, and their
 * housemates' beside it (read-only). `hasUnsubmittedChanges` keeps the status chip honest: text in
 * review or live is unaffected by edits, so they need to know their newest wording isn't handed in yet.
 * @param row a member_unit_stories row, or null
 * @param {{ personId: string, people: { id: string, firstName: string }[] }} viewer
 */
export function unitStoryView(row, { personId, people }) {
  const state = draftState(row);
  const f = state.fields;
  const status = row?.status ?? 'draft';
  const against = status === 'in_review' ? row?.submitted : row?.approved;
  const againstPublic = status === 'in_review' ? row?.submitted_public : row?.approved_public;
  const hasUnsubmittedChanges = !row ? false : status === 'draft' || status === 'rejected' ? !emptyCopy(row.draft) : !(sameCopy(row.draft, against) && !!row.draft_public === !!againstPublic);
  return {
    version: state.version,
    draft: { bio: f.bio, family: f.family, quote: f.quotes[personId] ?? '', link: f.links[personId] ?? '', photos: f.photos },
    others: people
      .filter((p) => p.id !== personId && (f.quotes[p.id] || f.links[p.id]))
      .map((p) => ({ firstName: p.firstName, quote: f.quotes[p.id] ?? '', link: f.links[p.id] ?? '' })),
    showOnPublicSite: f.public,
    status,
    submittedAt: row?.submitted_at ?? null,
    approvedAt: row?.approved_at ?? null,
    hasUnsubmittedChanges,
    reviewerNote: status === 'rejected' ? (row?.reviewer_note ?? null) : null,
    hasApproved: !!row?.approved,
  };
}

// ---- who may see a unit's photo ----

// The photo entry ({ ref, personId }) in whichever copy holds it, or null.
export function unitPhotoHolder(row, photoId) {
  for (const copy of [row?.draft, row?.submitted, row?.approved]) {
    const found = (copy?.photos ?? []).find((p) => p.ref === photoId);
    if (found) return found;
  }
  return null;
}

// The unit's own people see a photo in any copy (a draft or one in review included); everyone else only
// sees one in the approved copy, and only if the member who uploaded it is listed in the directory.
export function unitPhotoAccess({ viewerHouseholdIds, row, photoId, listed }) {
  if (!unitPhotoHolder(row, photoId)) return false;
  if (viewerHouseholdIds.includes(row.household_id)) return true;
  return !!listed && (row.approved?.photos ?? []).some((p) => p.ref === photoId);
}
