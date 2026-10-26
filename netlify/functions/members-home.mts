// Netlify Function (v2 API): GET /api/members-me/home, what the member portal shows right after sign-in.
//
// It lives apart from members-me.mts on purpose. That function carries the land-document readers, the email templates,
// the AI client and the photo storage (about 2.8 MB bundled), and a function's cold start grows with its size. Sign-in
// is the one request every member waits on, so it gets a small function of its own: only what /home needs.
//
// Same behaviour as before: the household data comes from one call to the database function member_home_bundle
// (migration 0073), falling back to separate reads if that function is missing (requireMemberWithHome in
// lib/member-access.ts). The privacy boundary is requireMember's: only households the member can_login on, and until
// the current privacy notice is acknowledged only their name and the notice version go back.
//
// The response carries a Server-Timing header (auth, load, build, total; `cold` on a function's first request) so the
// wait can be read in the browser's network panel instead of guessed at.
import { requireMemberWithHome } from './lib/member-access';
import { maskEmail, maskPhone } from './lib/staff-masking';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { buildHouseholdReview } from '../../scripts/lib/member-review.mjs';
import { PRIVACY_NOTICE_VERSION, privacyNoticeRequired } from '../../scripts/lib/member-privacy.mjs';
import { landDocumentLinks } from '../../scripts/lib/member-land-docs.mjs';

let cold = true; // true until this function instance has answered once
let wasCold = false; // whether the request being answered was that first one

type Timings = { auth?: number; load?: number; build?: number };

function jsonResponse(body: unknown, status: number, started: number, timings: Timings): Response {
  const total = Date.now() - started;
  const parts = Object.entries({ ...timings, total }).map(([name, dur]) => `${name};dur=${dur}`);
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store, private', 'server-timing': [...parts, ...(wasCold ? ['cold'] : [])].join(', ') };
  return new Response(JSON.stringify(body), { status, headers });
}

function supabaseUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  return url;
}

async function select(table: string, columns: string, filter: string): Promise<any[]> {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${table}?select=${columns}&${filter}&limit=2000`, { headers: restHeaders() });
  if (!res.ok) throw new Error(`${table} select failed: ${res.status}`);
  return res.json();
}

// PostgREST in-list for ids that came from our own database (uuids), never from the request.
const inList = (ids: string[]) => `(${ids.join(',')})`;

async function handleHome(req: Request): Promise<Response> {
  const started = Date.now();
  wasCold = cold;
  cold = false;
  const timings: Timings = {};

  const auth = await requireMemberWithHome(req);
  timings.auth = Date.now() - started;
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, started, timings);
  const { member, bundle } = auth;

  // Nothing about the household until the current notice has been acknowledged.
  if (privacyNoticeRequired(member.privacyVersion)) {
    return jsonResponse({ privacyNoticeRequired: true, privacyNoticeVersion: PRIVACY_NOTICE_VERSION, me: { name: member.name } }, 200, started, timings);
  }

  const loadStarted = Date.now();
  let data;
  let landDocs: any[] = [];
  let pendingFamily = 0;
  // Which tour steps they have seen. A separate read that may fail (migration 0056 not applied yet): the portal opens
  // anyway, and without the value the page shows no tour at all rather than the whole tour to everyone. It only needs
  // the person id, so it runs alongside the reads below instead of after them (each read to Supabase is a round trip).
  // With the bundle (migration 0073) none of these separate reads happen: it all came back in one.
  const tourRead: Promise<any[] | null> = bundle
    ? Promise.resolve([{ tour_seen_through: bundle.person.tour_seen_through }])
    : select('member_people', 'tour_seen_through', `id=eq.${member.personId}`).catch(() => null);
  if (bundle) {
    data = { households: bundle.households, memberships: bundle.memberships, plots: bundle.plots, housePattas: bundle.house_pattas, notes: bundle.notes, people: bundle.people };
    landDocs = bundle.docs;
    pendingFamily = bundle.family_pending;
  } else try {
    const hh = inList(member.householdIds);
    const [households, memberships, plots, housePattas, notes, docRows, familyRequests] = await Promise.all([
      select('member_households', 'id,farm_unit,house_no,cluster,unit_type', `id=in.${hh}`),
      select('member_household_members', 'household_id,person_id,role,can_login', `household_id=in.${hh}`),
      select('member_plots', 'id,household_id,patta_no,reference_no,survey_no,area_hectares,area_acres,settlement,verification,source_document_id', `household_id=in.${hh}`),
      select('member_house_pattas', 'id,household_id,patta_no,reference_no,survey_no,area_sq_ft,settlement,verification,source_document_id', `household_id=in.${hh}`),
      select('member_household_notes', 'household_id,kind', `household_id=in.${hh}`),
      select('member_land_documents', 'id,household_id,land_type,status,extracted,created_at', `household_id=in.${hh}`),
      // Only a count for a note on the page, so a failure here must never stop the portal opening.
      select('member_family_requests', 'household_id', `household_id=in.${hh}&status=eq.pending`).catch(() => [] as any[]),
    ]);
    const personIds = [...new Set(memberships.map((m: any) => m.person_id))];
    const people = personIds.length ? await select('member_people', 'id,full_name,email,phone,active,directory_visible,google_picture_url', `id=in.${inList(personIds)}`) : [];
    data = { households, memberships, plots, housePattas, notes, people };
    landDocs = docRows;
    pendingFamily = familyRequests.length;
  } catch (err) {
    console.error('[members-home] failed to load', err);
    timings.load = Date.now() - loadStarted;
    return jsonResponse({ error: 'Server error' }, 500, started, timings);
  }
  const tourRows = await tourRead;
  timings.load = Date.now() - loadStarted;

  const buildStarted = Date.now();
  const own = data.people.find((p: any) => p.id === member.personId);
  const reviewed = buildHouseholdReview(data);
  // The others in the unit are shown with their email and mobile masked ("p••••@gmail.com", "+91 •••••• 345"); the member's
  // own come back in full under `me`. buildHouseholdReview never carries the values (the admin register shares it), so they are added here.
  for (const h of reviewed) {
    for (const person of h.people as any[]) {
      const row = data.people.find((p: any) => p.id === person.id);
      person.emailMasked = row?.email ? maskEmail(row.email) : null;
      person.phoneMasked = row?.phone ? maskPhone(row.phone) : null;
    }
  }
  // Each land record also says which uploaded file its patta number and its survey number open.
  for (const h of reviewed) {
    const docs = landDocs.filter((d: any) => d.household_id === h.id);
    for (const [landType, rows] of [['farm', h.plots], ['house', h.housePattas]] as const) {
      for (const row of rows as any[]) Object.assign(row, landDocumentLinks(docs, { landType, pattaNo: row.pattaNo, surveyNo: row.surveyNo }));
    }
  }
  timings.build = Date.now() - buildStarted;
  return jsonResponse(
    {
      privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
      me: {
        personId: member.personId,
        name: member.name,
        // Their own details, shown back to them. Nobody else's email or mobile is ever sent.
        email: own?.email ?? null,
        phone: own?.phone ?? null,
        directoryVisible: own?.directory_visible ?? true,
        // owner, family or non_owner in their unit: family members get a narrower portal.
        role: member.roles[member.householdIds[0]] ?? 'owner',
        // Family member requests from their unit still waiting for the core team.
        familyRequestsPending: pendingFamily,
        ...(tourRows ? { tourSeenThrough: tourRows[0]?.tour_seen_through ?? null } : {}),
      },
      households: reviewed,
    },
    200,
    started,
    timings,
  );
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  return handleHome(req);
};

export const config = { path: ['/api/members-me/home'] };
