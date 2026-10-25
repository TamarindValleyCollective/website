// The admin portal's tours: one for the Home page and one for each tool, with the rule for who sees
// which steps. The rules are the same shape as the member portal's (scripts/lib/member-tour.mjs);
// the drawing is in scripts/lib/staff-tour-ui.mjs and the shell (src/layouts/StaffLayout.astro)
// starts a page's tour and offers it from the account menu.
//
// To announce a new feature, add a step at the END of that page's list with `since` one higher than
// the last on that page. Someone who has seen that page's tour gets only the new steps, once; a new
// admin gets every step as the tour.
//
// What a person has seen is kept in this browser (localStorage, per account and per page), not in the
// database, so a new browser or device shows the tours again. Moving it to a column on `staff_users`,
// like `member_people.tour_seen_through`, needs a migration and an endpoint; do that if the repeats
// grate.
//
//   page      the layout's `current` value: 'home', a module id, 'access' or 'security'.
//   audience  'all' = anyone who can open the page; 'super' = super admins only (Access and Security
//             are theirs, as is the Administration section on Home).
//   target    the `data-tour` value of the element to point at. If it isn't on the page or on screen
//             (a phone with the menu closed, a section that only appears after a choice) the step is
//             a plain centred card, so a missing target never breaks the tour.
//   tag       the small label on a "What's new" line.
//
// Keep the claims true to what the page does; each step is read by someone who is about to use it.

export const TOURS = {
  home: [
    {
      id: 'attention',
      since: 1,
      audience: 'all',
      target: 'attention',
      tag: 'Today',
      title: 'What needs you',
      text: 'One line says whether anything is waiting: conversations to reply to, cancellations to decide, stories to review, usage warnings. If something is, it is listed first with a number; tap it to go there.',
    },
    {
      id: 'tools',
      since: 1,
      audience: 'all',
      target: 'tools',
      tag: 'Today',
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
      text: 'Your name and role. Open it to check which account this is, to take a tour of the page you are on, or to sign out, especially on a shared computer.',
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
  ],

  'photo-pool': [
    {
      id: 'inbox',
      since: 1,
      audience: 'all',
      target: 'intro',
      tag: 'Photos',
      title: 'Photos arrive in a shared folder',
      text: 'Photos dropped into the shared Drive Inbox folder show up here. Nothing reaches the website until someone approves it.',
    },
    {
      id: 'review',
      since: 1,
      audience: 'all',
      target: 'grid',
      tag: 'Photos',
      title: 'Review each photo',
      text: 'Check the preview and the details, fix the description and press Save, then Approve or Reject. Approving moves the file to the Approved folder in Drive, the next step towards the site; it does not publish anything by itself. Reject moves it to the Rejected folder.',
    },
  ],

  whatsapp: [
    {
      id: 'number',
      since: 1,
      audience: 'all',
      target: 'header',
      tag: 'WhatsApp',
      title: 'Our WhatsApp number',
      text: 'Messages to the farm\'s WhatsApp number land here. WhatsApp only lets us reply within 24 hours of the customer\'s last message.',
    },
    {
      id: 'filters',
      since: 1,
      audience: 'all',
      target: 'conversations',
      tag: 'WhatsApp',
      title: 'Find a conversation',
      text: 'Search by name or message. "Needs reply" narrows the list to conversations waiting on us.',
    },
    {
      id: 'thread',
      since: 1,
      audience: 'all',
      target: 'thread',
      tag: 'WhatsApp',
      title: 'Read and reply',
      text: 'Pick a conversation to read it. Type / for canned replies, or press Suggest reply for a draft to check and edit first. Command or Ctrl plus Enter sends.',
    },
  ],

  'event-payments': [
    {
      id: 'event',
      since: 1,
      audience: 'all',
      target: 'event',
      tag: 'Events',
      title: 'Choose an event',
      text: 'Everything on this page is for one event at a time.',
    },
    {
      id: 'stats',
      since: 1,
      audience: 'all',
      target: 'stats',
      tag: 'Events',
      title: 'The numbers at a glance',
      text: 'Bookings, cancellations, money collected, and what is left after fees. The Live and Test switch above them keeps real bookings apart from rehearsals.',
    },
    {
      id: 'money',
      since: 1,
      audience: 'all',
      target: 'money',
      tag: 'Events',
      title: 'Money breakdown',
      text: 'What was collected, refunded and charged in fees, and what has actually settled, in one place.',
    },
    {
      id: 'bookings',
      since: 1,
      audience: 'all',
      target: 'bookings',
      tag: 'Events',
      title: 'Bookings and refunds',
      text: 'Open a booking to see its payment. An admin can refund from here: the form suggests an amount from the refund policy and asks you to confirm, and the refund goes through Razorpay for real.',
    },
  ],

  accommodation: [
    {
      id: 'dates',
      since: 1,
      audience: 'all',
      target: 'month-nav',
      tag: 'Stays',
      title: 'Move through the calendar',
      text: 'Step by week or month, jump to today or to any date, and switch between Day, Week and Month to see more or less at once.',
    },
    {
      id: 'grid',
      since: 1,
      audience: 'all',
      target: 'grid',
      tag: 'Stays',
      title: 'Availability by type',
      text: 'Each row is a type (tents, bamboo huts) showing how many of its units are free each night. Open a type to see its units, with each booking as a bar across its nights. Click a free cell to start a booking there, or a bar to open it.',
    },
    {
      id: 'new',
      since: 1,
      audience: 'all',
      target: 'new-booking',
      tag: 'Stays',
      title: 'Record a booking',
      text: 'Add who is staying, which tents and for how many nights. The list below this button shows the month\'s bookings.',
    },
  ],

  members: [
    {
      id: 'totals',
      since: 1,
      audience: 'all',
      target: 'totals',
      tag: 'Register',
      title: 'The register in numbers',
      text: 'Totals for the units on the register.',
    },
    {
      id: 'find',
      since: 1,
      audience: 'all',
      target: 'toolbar',
      tag: 'Register',
      title: 'Find a unit',
      text: 'Search by unit, house or name. The Show menu narrows the list to units that need validation or attention.',
    },
    {
      id: 'units',
      since: 1,
      audience: 'all',
      target: 'list',
      tag: 'Register',
      title: 'Open a unit',
      text: 'Open a unit to see its people, land and patta records. What you can change there depends on your role; a read-only role sees names masked.',
    },
  ],

  usage: [
    {
      id: 'attention',
      since: 1,
      audience: 'all',
      target: 'alerts',
      tag: 'Usage',
      title: 'Needs attention',
      text: 'One line says how things stand. Anything close to a free-tier or credit limit is listed here first, with the reason; tap it for what to do. Warning is about 70% used, critical about 90%.',
    },
    {
      id: 'services',
      since: 1,
      audience: 'all',
      target: 'services',
      tag: 'Usage',
      title: 'One row per service',
      text: 'How much of each free tier or credit is used. Tap a row for its figures, history and, for an admin, to enter a new reading. A figure marked Estimated is the last number someone typed in, minus what the website has measurably used since.',
    },
    {
      id: 'domains',
      since: 1,
      audience: 'all',
      target: 'domains',
      tag: 'Usage',
      title: 'Domain renewals',
      text: 'Expiry dates read from the registries, so a renewal does not slip past unnoticed.',
    },
  ],

  access: [
    {
      id: 'stepup',
      since: 1,
      audience: 'super',
      target: 'stepup',
      tag: 'Access',
      title: 'Unlock before you edit',
      text: 'The lock in the toolbar. Open it and enter a code from your authenticator app, or use a passkey, to unlock changes for ten minutes. Until then you can look but not edit. If you have not set up two methods yet, Security walks you through it.',
    },
    {
      id: 'tabs',
      since: 1,
      audience: 'super',
      target: 'tabs',
      tag: 'Access',
      title: 'Two views',
      text: 'People, where you give and take away roles, and Activity, the record of changes.',
    },
    {
      id: 'find',
      since: 1,
      audience: 'super',
      target: 'people-find',
      tag: 'Access',
      title: 'Find someone',
      text: 'Search by name, or narrow the list by tool, access and status. The list shows faces and names only; pick one to see their details and their role in each tool.',
    },
    {
      id: 'add',
      since: 1,
      audience: 'super',
      target: 'add-person',
      tag: 'Access',
      title: 'Add someone',
      text: 'Add a person by email. They sign in with that Google account; then give them a role in each tool they need.',
    },
  ],

  security: [
    {
      id: 'factors',
      since: 1,
      audience: 'super',
      target: 'factors',
      tag: 'Security',
      title: 'Your second factors',
      text: 'The methods you have set up. You are ready once you have two different ones, such as an authenticator app and a passkey.',
    },
    {
      id: 'totp',
      since: 1,
      audience: 'super',
      target: 'totp',
      tag: 'Security',
      title: 'Authenticator app',
      text: 'Scan the QR code with an authenticator app, then type the code it shows to confirm.',
    },
    {
      id: 'passkey',
      since: 1,
      audience: 'super',
      target: 'passkeys',
      tag: 'Security',
      title: 'Passkeys',
      text: 'Face ID, Touch ID or a security key instead of a code. A passkey only works on admin.tvc.farm.',
    },
    {
      id: 'verify',
      since: 1,
      audience: 'super',
      target: 'verify',
      tag: 'Security',
      title: 'Prove it is you',
      text: 'Verify here to unlock protected actions, such as changing access, for a short while.',
    },
  ],
};

export const TOUR_PAGES = Object.keys(TOURS);

const audienceSees = (step, isSuperAdmin) => step.audience === 'all' || (step.audience === 'super' && isSuperAdmin === true);
const stepsOf = (page) => (Object.hasOwn(TOURS, page) ? TOURS[page] : []);

// The newest `since` on a page (0 if it has no tour). What a person has "seen through" is compared to this.
export const tourLatest = (page) => Math.max(0, ...stepsOf(page).map((s) => s.since));

// seenThrough: the highest `since` this person has seen on this page. null = never seen any: the
// whole tour. A number = only what was added after it. Anything else (undefined, NaN, a bad value) =
// no tour at all, so a failed read never replays the tour for everyone.
export function tourStepsFor({ page, isSuperAdmin, seenThrough }) {
  if (seenThrough !== null && !Number.isInteger(seenThrough)) return [];
  return stepsOf(page).filter((s) => audienceSees(s, isSuperAdmin) && (seenThrough === null || s.since > seenThrough));
}

// "Take the tour": everything this person can use on the page, whatever was seen before.
export const fullTourFor = (page, isSuperAdmin) => stepsOf(page).filter((s) => audienceSees(s, isSuperAdmin));
