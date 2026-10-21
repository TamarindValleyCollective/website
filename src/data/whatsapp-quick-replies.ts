// Canned replies for the WhatsApp inbox (src/pages/internal/whatsapp.astro).
// Choosing one drops its text into the reply box for the admin to edit
// before sending — nothing is sent automatically. The reply is signed with the
// sender's name by the server, so don't add a sign-off here.
//
// How they appear: replies marked `pinned` show as pills above the reply box (keep
// it to about five, so they stay on one or two rows); every reply, pinned or not, is
// in the searchable "More replies" list, grouped by `category` in the order the
// categories first appear below, and reachable by typing "/" in the reply box. So
// this file can grow without crowding the screen.
//
// Links only point at pages that exist on tvc.farm. Add prices, timings or anything
// else that changes here only when someone owns keeping it current; a stale canned
// answer is worse than typing a fresh one.
export interface QuickReply {
  label: string;
  text: string;
  category: string;
  pinned?: boolean;
}

export const WHATSAPP_QUICK_REPLIES: ReadonlyArray<QuickReply> = [
  {
    label: 'Directions',
    category: 'Visiting',
    pinned: true,
    text: 'Here is how to reach us, with route maps from Hosur and from Kanakapura: https://tvc.farm/visit/how-to-reach',
  },
  {
    label: 'Day visit',
    category: 'Visiting',
    pinned: true,
    text: 'Details about a day visit are here: https://tvc.farm/visit/day-visit',
  },
  {
    label: 'Camping',
    category: 'Visiting',
    text: 'Details about camping are here: https://tvc.farm/visit/camping',
  },
  {
    label: 'Events',
    category: 'Events and membership',
    pinned: true,
    text: 'You can see our upcoming events and book online here: https://tvc.farm/events',
  },
  {
    label: 'Membership',
    category: 'Events and membership',
    text: 'If you would like to join the collective, you can start here: https://tvc.farm/join',
  },
  {
    label: 'Checking',
    category: 'General',
    pinned: true,
    text: 'Thanks for your message. Let me check on this and get back to you shortly.',
  },
  {
    label: 'Closing',
    category: 'General',
    pinned: true,
    text: "Thanks for getting in touch! Let us know if there's anything else we can help with.",
  },
];
