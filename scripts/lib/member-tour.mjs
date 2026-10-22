// The member portal's feature tour: the steps, and the rule for who sees which.
// One source for both sides: the page (src/pages/members/index.astro) draws the steps,
// and members-me.mts checks what a member says they have seen.
//
// To announce a new feature, add a step at the END with `since` one higher than the
// last. Nobody has to be told anything else: a member who signed in before the step
// existed sees it once, as "What's new"; someone brand new sees every step as the tour.
//
// `member_people.tour_seen_through` holds the highest `since` a person has seen
// (null = never signed in before the tour existed, so they get the whole tour).
//
//   audience  'all' = everyone who signs in; 'owner' = owners of a unit only (family
//             members and non-owners can't use the feature, so are never shown it).
//   route     the page the step lives on; the tour goes there first.
//   target    the `data-tour` value of the element to point at. If it isn't on the page
//             (a phone with the menu closed, a card that isn't there) the step is a plain
//             centred card, so a missing target never breaks the tour.
//   tag       the small label on a "What's new" line.

export const TOUR_STEPS = [
  {
    id: 'next',
    since: 1,
    audience: 'all',
    route: 'dashboard',
    target: 'next',
    tag: 'Home',
    title: 'Your next step',
    text: 'This card always shows the one thing worth doing next, such as adding your WhatsApp number or writing your story.',
  },
  {
    id: 'unit',
    since: 1,
    audience: 'all',
    route: 'dashboard',
    target: 'unit-widget',
    tag: 'My unit',
    title: 'Your unit, on record',
    text: 'Farm land and house area as the core team holds them. Open My unit for survey numbers and the plot shapes. If something looks wrong, tell the core team.',
  },
  {
    id: 'members',
    since: 1,
    audience: 'all',
    route: 'directory',
    target: 'nav-directory',
    tag: 'Members',
    title: 'Our members',
    text: 'Your neighbours in the valley and the stories they have shared. Your own unit\'s card is here too.',
  },
  {
    id: 'story-card',
    since: 2,
    audience: 'owner',
    route: 'directory',
    target: 'edit-story',
    tag: 'Story',
    title: 'Edit your story from your card',
    text: 'The pencil on your unit\'s card opens the story. Change it whenever you like.',
  },
  {
    id: 'family',
    since: 2,
    audience: 'owner',
    route: 'unit',
    target: 'add-family',
    tag: 'Family',
    title: 'Add family members',
    text: 'Two can sign in with their own Google account and see the unit and our members. Ask the core team for more.',
  },
];

export const TOUR_LATEST = Math.max(...TOUR_STEPS.map((s) => s.since));

const roleSees = (step, role) => step.audience === 'all' || step.audience === role;

// seenThrough: member_people.tour_seen_through. null = never seen any: the whole tour.
// A number = only what was added after it. Anything else (undefined, a bad value) = no tour at all, so a
// failed read never replays the tour for everyone.
export function tourStepsFor({ role, seenThrough }) {
  if (seenThrough !== null && !Number.isInteger(seenThrough)) return [];
  return TOUR_STEPS.filter((s) => roleSees(s, role) && (seenThrough === null || s.since > seenThrough));
}

// "Take the tour again": everything this role can use, whatever was seen before.
export const fullTourFor = (role) => TOUR_STEPS.filter((s) => roleSees(s, role));

// POST /api/members-me/tour-seen body: { through }. Never lowers what is on record, and never goes
// past the newest step, so a stale or odd client can't hide steps that don't exist yet.
export function validateTourSeen(body, stored) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Nothing to do.' };
  const through = body.through;
  if (!Number.isInteger(through) || through < 1 || through > TOUR_LATEST) return { ok: false, error: 'Nothing to do.' };
  return { ok: true, through: Math.max(through, Number.isInteger(stored) ? stored : 0) };
}
