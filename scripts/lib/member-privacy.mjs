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

export const PRIVACY_NOTICE_VERSION = 3;

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
    body: 'If you write a story about yourself, your drafts are seen only by you and the core team. When you press "Check", the text of your story (and your first name) is sent to Anthropic, the AI company we use, to suggest spelling, grammar and tone fixes; nothing else about you is sent. It only suggests, you decide what to keep, and nothing is published until the core team has read and approved it.',
  },
  {
    heading: 'Who can see it',
    body: 'You can see your own household. For the other people in it you see only whether an email or mobile is on file, never the numbers. Other members cannot see your record. The few core team members who run the register can see and correct it. Every change, by you or by them, is logged: which field changed, never the value.',
  },
  {
    heading: 'Signing in',
    body: 'Google confirms your email address and we use nothing else from your Google account. We do not store a password.',
  },
  {
    heading: 'Your choices',
    body: 'You can change your mobile number yourself. A member directory does not exist yet; turning "List me in the member directory" off now means you will not be listed when it does. To change your name, email or household, ask the core team.',
  },
  {
    heading: 'Where it is kept',
    body: 'In TVC\'s own database, hosted with Supabase, and shown through this site, hosted with Netlify. The documents you upload are kept in a private store at Cloudflare that only the portal and the core team can open; nothing in them is public. None of it is sold, shared with anyone else, or part of the public website.',
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
