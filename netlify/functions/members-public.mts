// Netlify Function (v2 API): the member cards that are PUBLIC, for the site build.
//
//   GET /api/members-published        the cards (and which 2017 cards to reduce to a name) as JSON
//   GET /api/members-published-photo?id=&size=   one published photo
//
// Why a function and not the build talking to the database: the site build has no database or
// R2 credentials (those secrets are scoped to Functions only, on purpose). The build
// (scripts/export-member-stories.mjs) calls this instead, over HTTPS, and needs no secret because
// everything here is public by definition: only the APPROVED copy of a story whose "Show on tvc.farm"
// switch is on, only for primary members who are active and still listed (scripts/lib/member-publish.mjs),
// and only a photo that is one of those stories' approved photo. Nothing else is reachable: a draft,
// a story in review, a private story, a family member's or an opted-out person's photo all answer 404.
//
// Turning a story off or removing a photo takes it out of these responses at once; it comes off the
// site at the next build (the admin "Publish to the website" button starts one).
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { buildPublished, buildPublishedUnits, publishedUnitPhotoHolder } from '../../scripts/lib/member-publish.mjs';
import { UNIT_STORIES_KEY, unitSwitchLive } from '../../scripts/lib/member-unit-story.mjs';
import { isUploadedPhoto } from '../../scripts/lib/member-photo.mjs';
import { getMemberPhoto } from './lib/member-photo-storage';
import { checkIpRateLimit, clientIp } from './lib/rate-limit';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=120', 'netlify-cdn-cache-control': 'public, s-maxage=120' } });

async function select(table: string, columns: string, filter = ''): Promise<any[]> {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  const res = await fetch(`${url}/rest/v1/${table}?select=${columns}${filter ? `&${filter}` : ''}&limit=2000`, { headers: restHeaders() });
  if (!res.ok) throw new Error(`${table} select failed: ${res.status}`);
  return res.json();
}

// Whether stories belong to the whole unit (member_unit_stories) or to each person (member_stories): the
// cutover switch, off until the move to unit stories is done. Anything unreadable means the per-person path.
async function unitStoriesLive(): Promise<boolean> {
  const [row] = await select('member_settings', 'value', `key=eq.${UNIT_STORIES_KEY}`);
  return unitSwitchLive(row);
}

async function handleCards(): Promise<Response> {
  try {
    const live = await unitStoriesLive();
    const [households, people, memberships, stories, cards] = await Promise.all([
      select('member_households', 'id'),
      select('member_people', 'id,full_name,active,directory_visible'),
      select('member_household_members', 'household_id,person_id,role'),
      // Only the approved copy, and only where the switch is on: nothing else leaves the database here.
      live ? select('member_unit_stories', 'household_id,approved,approved_public', 'approved=not.is.null') : select('member_stories', 'person_id,approved,approved_public', 'approved=not.is.null'),
      select('member_cards', 'household_id,card_name,person_ids'),
    ]);
    const published = live ? buildPublishedUnits({ households, people, memberships, unitStories: stories, cards }) : buildPublished({ households, people, memberships, stories, cards });
    return json({ generatedAt: new Date().toISOString(), ...published });
  } catch (err) {
    console.error('[members-public] cards failed', err);
    return new Response(JSON.stringify({ error: 'Server error' }), { status: 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
}

async function handlePhoto(req: Request): Promise<Response> {
  const notFound = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const url = new URL(req.url);
  const id = url.searchParams.get('id') ?? '';
  const size = url.searchParams.get('size') === 'full' ? 'full' : 'square';
  if (!isUploadedPhoto(id)) return notFound();
  try {
    if (await unitStoriesLive()) {
      const [unitRow] = await select('member_unit_stories', 'household_id,approved,approved_public', `approved->photos=cs.[{"ref":"${id}"}]&approved_public=eq.true`);
      if (!unitRow) return notFound();
      const [people, memberships] = await Promise.all([select('member_people', 'id,active,directory_visible'), select('member_household_members', 'household_id,person_id,role', `household_id=eq.${unitRow.household_id}`)]);
      const holder = publishedUnitPhotoHolder({ row: unitRow, photoId: id, people, memberships });
      const unitBytes = holder ? await getMemberPhoto(holder, id, size) : null;
      if (!unitBytes) return notFound();
      return new Response(unitBytes, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' } });
    }
    const [row] = await select('member_stories', 'person_id', `approved->>photo=eq.${id}&approved_public=eq.true`);
    if (!row) return notFound();
    // The person must still be listed and a primary member of a household, like everything else published.
    const [[person], links] = await Promise.all([
      select('member_people', 'id,active,directory_visible', `id=eq.${row.person_id}`),
      select('member_household_members', 'role', `person_id=eq.${row.person_id}`),
    ]);
    if (!person || person.active === false || person.directory_visible === false || !links.some((l) => l.role === 'owner')) return notFound();
    const bytes = await getMemberPhoto(row.person_id, id, size);
    if (!bytes) return notFound();
    return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' } });
  } catch (err) {
    console.error('[members-public] photo failed', err);
    return new Response('Server error', { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

export default async (req: Request): Promise<Response> => {
  // Public, so limited per address; the build needs a handful of requests.
  if (!(await checkIpRateLimit('members-public-rate', clientIp(req), 10 * 60 * 1000, 300))) return new Response('Too many requests', { status: 429 });
  const { pathname } = new URL(req.url);
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  if (pathname === '/api/members-published') return handleCards();
  if (pathname === '/api/members-published-photo') return handlePhoto(req);
  return new Response('Not found', { status: 404 });
};

export const config = { path: ['/api/members-published', '/api/members-published-photo'] };
