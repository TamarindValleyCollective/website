// Canned replies offered above the composer in the WhatsApp inbox
// (src/pages/internal/whatsapp.astro). Clicking one drops its text into the
// reply box for the staff member to edit before sending — nothing is sent
// automatically. The reply is signed with the sender's name by the server, so
// don't add a sign-off here.
//
// Links only point at pages that exist on tvc.farm. Add prices, timings or
// anything else that changes here only when someone owns keeping it current;
// a stale canned answer is worse than typing a fresh one.
export const WHATSAPP_QUICK_REPLIES: ReadonlyArray<{ label: string; text: string }> = [
  {
    label: 'Directions',
    text: 'Here is how to reach us, with route maps from Hosur and from Kanakapura: https://tvc.farm/visit/how-to-reach',
  },
  {
    label: 'Events',
    text: 'You can see our upcoming events and book online here: https://tvc.farm/events',
  },
  {
    label: 'Day visit',
    text: 'Details about a day visit are here: https://tvc.farm/visit/day-visit',
  },
  {
    label: 'Camping',
    text: 'Details about camping are here: https://tvc.farm/visit/camping',
  },
  {
    label: 'Membership',
    text: 'If you would like to join the collective, you can start here: https://tvc.farm/join',
  },
  {
    label: 'Checking',
    text: 'Thanks for your message. Let me check on this and get back to you shortly.',
  },
  {
    label: 'Closing',
    text: "Thanks for getting in touch! Let us know if there's anything else we can help with.",
  },
];
