// The admin portal's feature tour: the steps, and the rule for who sees which. The rules are the
// same shape as the member portal's (scripts/lib/member-tour.mjs); the drawing is in
// scripts/lib/staff-tour-ui.mjs and the Home page (src/pages/internal/index.astro) wires it up.
//
// To announce a new feature, add a step at the END with `since` one higher than the last. Someone
// who has seen the tour before gets only the new steps, once, as "What's new"; a new admin gets
// every step as the tour.
//
// What a person has seen is kept in this browser (localStorage, per account), not in the database,
// so a new browser or device shows the tour again. Moving it to a column on `staff_users`, like
// `member_people.tour_seen_through`, needs a migration and an endpoint; do that if the repeats grate.
//
//   audience  'all' = every admin; 'super' = super admins only (Access and Security are theirs).
//   target    the `data-tour` value of the element to point at. If it isn't on the page (a phone
//             with the menu closed, a section that is hidden) the step is a plain centred card,
//             so a missing target never breaks the tour.
//   tag       the small label on a "What's new" line.

export const TOUR_STEPS = [
  {
    id: 'tools',
    since: 1,
    audience: 'all',
    target: 'tools',
    tag: 'Home',
    title: 'Your tools',
    text: 'One tile for each tool you have a role in. The label on a tile is your role there: Admin, User or Read-only.',
  },
  {
    id: 'menu',
    since: 1,
    audience: 'all',
    target: 'menu',
    tag: 'Menu',
    title: 'The menu',
    text: 'The same tools, a click away from every page. A tool only shows up if you hold a role in it.',
  },
  {
    id: 'collapse',
    since: 1,
    audience: 'all',
    target: 'collapse',
    tag: 'Menu',
    title: 'More room',
    text: 'Fold the menu away to give a wide page more space. It remembers your choice on this device.',
  },
  {
    id: 'account',
    since: 1,
    audience: 'all',
    target: 'account',
    tag: 'Account',
    title: 'Who is signed in',
    text: 'Your name and a masked email, so you can tell which account this is. Sign out here, especially on a shared computer.',
  },
  {
    id: 'admin-tools',
    since: 1,
    audience: 'super',
    target: 'admin-tools',
    tag: 'Administration',
    title: 'Access and Security',
    text: 'Access is where a super admin gives and takes away roles. Security is where you set up your second factors: an authenticator app and a passkey. Set up two before you change anyone\'s access.',
  },
];

export const TOUR_LATEST = Math.max(...TOUR_STEPS.map((s) => s.since));

const audienceSees = (step, isSuperAdmin) => step.audience === 'all' || (step.audience === 'super' && isSuperAdmin === true);

// seenThrough: the highest `since` this person has seen. null = never seen any: the whole tour.
// A number = only what was added after it. Anything else (undefined, NaN, a bad value) = no tour at
// all, so a failed read never replays the tour for everyone.
export function tourStepsFor({ isSuperAdmin, seenThrough }) {
  if (seenThrough !== null && !Number.isInteger(seenThrough)) return [];
  return TOUR_STEPS.filter((s) => audienceSees(s, isSuperAdmin) && (seenThrough === null || s.since > seenThrough));
}

// "Take the tour": everything this person can use, whatever was seen before.
export const fullTourFor = (isSuperAdmin) => TOUR_STEPS.filter((s) => audienceSees(s, isSuperAdmin));
