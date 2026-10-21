// The member portal's first-login privacy notice: its text, its version, and the
// rule for when a member must see it. One source for both sides: the page
// (src/pages/members/index.astro) renders SECTIONS, and members-me.mts decides
// from PRIVACY_NOTICE_VERSION whether to release a member's data.
//
// Change the wording in a way that matters (new data held, new people who can see
// it, a new service) and raise PRIVACY_NOTICE_VERSION: everyone is asked again at
// their next sign-in. Fixing a typo does not need a new version.
//
// Keep it true: it describes what the portal does today, not what is planned.
// Update it when the portal changes (the directory, dues, stays...).

export const PRIVACY_NOTICE_VERSION = 8;

export const NOTICE_TITLE = 'How we handle your membership details';

export const NOTICE_INTRO =
  'Before you continue, here is what the member register holds about you and who can see it. It takes a minute to read.';

export const SECTIONS = [
  {
    heading: 'Who keeps it',
    body: 'Syntropic Farm Management Pvt Ltd, which owns the Tamarind Valley Collective, keeps the member register. This portal is your view of your own part of it.',
  },
  {
    heading: 'What it holds',
    body: 'Your name, the email address you sign in with, your mobile number if we have it, which farm plot and house plot are yours, the land records for them (patta and survey numbers, areas), the patta or land survey documents you upload, and who else is in your household.',
  },
  {
    heading: 'Your story',
    body: 'Your unit has one story, shared by everyone in it who can sign in to this portal. What you do, your family, the photos (up to two) and whether the story is shown on the public website belong to the unit: anyone in your unit can write and change them, and you can read each other\'s drafts. Your own "why TVC" line and your own profile link are yours: only you can change them, but the others in your unit can read them. Drafts are seen only by the people in your unit and the core team. When you press "Check", the text of the story (the shared parts and your own line and link) and your first name are sent to Anthropic, the AI company we use, to suggest spelling, grammar and tone fixes; nothing else about you is sent. It only suggests, you decide what to keep, and the core team is responsible for what is published. Anyone in your unit can submit the story to the core team. Submitting hands in the whole story, including the other people\'s lines, and if someone submits while an earlier submission is still being read, the new one replaces it. When a story that is switched on for the public website is submitted, the text submitted (and the version already published, if any), including everyone\'s lines, is also sent to Anthropic for a safety check that rates how risky it would be to publish, for example contact details, children, links or hostile wording. A story the check rates high-risk is always read by the core team before it is published. As the check proves reliable, the core team may let stories it rates low-risk be published without being read first, and a story that is not for the public website is not checked this way. Photos are kept privately (with the camera and location details removed) and checked by the core team with the story. Once approved, other members can see the story and its photos in the member directory. They go on the public website only if "Show on tvc.farm" is switched on; that switch belongs to the whole story, so everyone in your unit should agree before it is turned on. Photos of children become public the same way, so please think before adding one.',
  },
  {
    heading: 'Who can see it',
    body: 'You can see your own household. For the other people in it you see only whether an email or mobile is on file, never the numbers. The people in your unit can also read each other\'s draft lines and profile links. Other members can see your name, your farm plot number, house number and housing cluster, and your unit\'s approved story (including your own line and profile link) in the member directory, unless you turn your listing off. They never see your email, mobile number, land records or documents. The few core team members who run the register can see and correct all of it. Every change, by you or by them, is logged: which field changed, never the value.',
  },
  {
    heading: 'Signing in',
    body: 'Google confirms your email address. We also keep the profile picture Google shows for your account, and refresh it each time you sign in, so the core team can recognise you on the member register. Only the core team sees it, other members never do, and it is not sent anywhere else; if you remove the picture from your Google account, ours is removed the next time you sign in. We use nothing else from your Google account and we do not store a password.',
  },
  {
    heading: 'Your choices',
    body: 'You can change your mobile number yourself. Turn "List me in the member directory" off and other members will not see you in the directory, and your own line and profile link are no longer shown. The shared story (what you do, your family, the photos) is about the whole unit, so it stays for as long as anyone else in your unit is listed; to take the story down completely, ask the core team. To change your name, email or household, ask the core team.',
  },
  {
    heading: 'Where it is kept',
    body: 'In TVC\'s own database, hosted with Supabase, and shown through this site, hosted with Netlify. The documents you upload, and any photo added to your unit\'s story, are kept in a private store at Cloudflare that only the portal and the core team can open; nothing in them is public except a story photo that is published with a story switched on for the public website. None of it is sold, shared with anyone else, or part of the public website.',
  },
  {
    heading: 'Questions or corrections',
    body: 'Write to contact@tvc.farm and ask for the core team.',
  },
];

// acceptedVersion: member_people.privacy_notice_version. Required if nothing is on
// record, or what is on record is for an older notice.
export function privacyNoticeRequired(acceptedVersion) {
  return !(Number.isInteger(acceptedVersion) && acceptedVersion >= PRIVACY_NOTICE_VERSION);
}

// POST /api/members-me/privacy body: { version }. The client must name the version
// it showed, so a stale tab can't acknowledge a notice that has since changed.
export function validateAcceptance(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Nothing to do.' };
  if (body.version !== PRIVACY_NOTICE_VERSION) {
    return { ok: false, error: 'The privacy notice has been updated. Reload the page to read it.' };
  }
  return { ok: true, version: PRIVACY_NOTICE_VERSION };
}
