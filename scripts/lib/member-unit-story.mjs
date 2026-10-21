// A unit's story: one record per unit, not one per person. Pure (no network), so the rules are
// tested on their own. See docs/plans/member-portal.md ("Member stories").
//
// Shared by everyone in the unit: bio, family, profile link, up to MAX_PHOTOS photos and whether it
// shows on tvc.farm. Personal: each person's own quote, kept under their id in `quotes`.

export const MAX_PHOTOS = 2;

const text = (v) => (typeof v === 'string' ? v.trim() : '');

// One per-person copy ({ bio, family, why, social, photo }) as the unit's copy fields.
const sharedOf = (c) => ({ bio: text(c?.bio), family: text(c?.family), social: text(c?.social) });

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
  for (const r of copies) if (text(r[field].why)) quotes[r.person_id] = text(r[field].why);
  // Newest first, each photo once, remembering who holds it (uploaded photos are stored under their id).
  const photos = [];
  for (const r of [...copies].sort((a, b) => String(b[at] ?? '').localeCompare(String(a[at] ?? '')))) {
    const ref = text(r[field].photo);
    if (ref && !photos.some((p) => p.ref === ref)) photos.push({ ref, personId: r.person_id });
  }
  const key = (r) => JSON.stringify([sharedOf(r[field]).bio, sharedOf(r[field]).family, sharedOf(r[field]).social]);
  return { copy: { ...sharedOf(newest[field]), photos: photos.slice(0, MAX_PHOTOS), quotes }, winner: newest, diverged: new Set(copies.map(key)).size > 1 };
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
  };
}

// Adds one photo to the unit's photos if there is room and it isn't already there.
// photo: { ref, personId } (the uploader's id is part of its storage path).
export function addPhoto(photos, photo) {
  if (photos.some((p) => p.ref === photo.ref)) return { ok: false, error: 'duplicate' };
  if (photos.length >= MAX_PHOTOS) return { ok: false, error: 'full' };
  return { ok: true, photos: [...photos, photo] };
}

// Applies one owner's save to the unit's shared draft, field by field, so two owners editing at once
// only collide when they touch the same field.
//   current:     { version, fields: { bio, family, social, photos, quotes, public }, changed: { field: version } }
//   changes:     only the fields this save touches
//   baseVersion: the version the editor was looking at when they started
// Returns { ok: true, fields, changed, version } or { ok: false, error, fields: [...] }.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SHARED_FIELDS = ['bio', 'family', 'social', 'photos', 'public'];

export function mergeDraftEdit({ current, changes, baseVersion, personId }) {
  // A save can only name story fields, and "quote" always means the editor's own: there is no way to
  // address another person's quote.
  const unknown = Object.keys(changes).filter((name) => !SHARED_FIELDS.includes(name) && name !== 'quote');
  if (unknown.length) return { ok: false, error: 'unknown', fields: unknown };
  if (changes.photos && (changes.photos.length > MAX_PHOTOS || new Set(changes.photos.map((p) => p.ref)).size !== changes.photos.length)) {
    return { ok: false, error: 'invalid', fields: ['photos'] };
  }
  const fields = { ...current.fields, quotes: { ...current.fields.quotes } };
  const changed = { ...current.changed };
  const touched = [];
  const conflicts = [];
  for (const [name, value] of Object.entries(changes)) {
    const own = name === 'quote';
    if (same(value, own ? fields.quotes[personId] : fields[name])) continue;
    if ((current.changed[own ? `quote:${personId}` : name] ?? 0) > baseVersion) conflicts.push(name);
    touched.push(name);
  }
  if (conflicts.length) return { ok: false, error: 'conflict', fields: conflicts };
  for (const name of touched) {
    if (name === 'quote') fields.quotes[personId] = changes.quote;
    else fields[name] = changes[name];
  }
  const version = touched.length ? current.version + 1 : current.version;
  for (const name of touched) changed[name === 'quote' ? `quote:${personId}` : name] = version;
  return { ok: true, fields, changed, version };
}
