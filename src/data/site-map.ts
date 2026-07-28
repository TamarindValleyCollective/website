// Single source of truth for the site's nav information architecture. The
// four grouped arrays below are read by Nav for the header dropdowns —
// grouped by visitor intent (About / Ecosystem / Visit / Get Involved)
// rather than the coarser Explore/Engage split below, which Breadcrumbs
// still uses to link back to the matching homepage section (the homepage
// hasn't been regrouped and still runs on two sections, #explore/#engage,
// covering the same pages). Footer does not currently read this file.

export interface SiteLink {
  label: string;
  href: string;
}

export const ABOUT_LINKS: SiteLink[] = [
  { label: 'Who We Are', href: '/about' },
  { label: 'People', href: '/people' },
  { label: 'Our Journey', href: '/our-journey' },
  { label: 'In Pictures', href: '/in-pictures' },
];

export const ECOSYSTEM_LINKS: SiteLink[] = [
  { label: 'Biodiversity', href: '/ecosystem' },
  { label: 'Weather', href: '/ecosystem/geography' },
  { label: 'Resource Centre', href: '/resource-centre' },
];

export const VISIT_LINKS: SiteLink[] = [
  { label: 'What to Expect', href: '/visit' },
  { label: 'Day Visit', href: '/visit/day-visit' },
  { label: 'Overnight Camping', href: '/visit/camping' },
  { label: 'Trekking Trails', href: '/visit/trekking-trails' },
  { label: 'How to Reach', href: '/visit/how-to-reach' },
  { label: 'Events', href: '/events' },
];

export const GET_INVOLVED_LINKS: SiteLink[] = [
  { label: 'Host an Event', href: '/visit/host-an-event' },
  { label: 'Join the Collective', href: '/join' },
  { label: 'Contact Us', href: '/contact' },
];

// Path prefixes used to classify a page (including dynamic slug pages, which
// inherit their parent's prefix — e.g. /events/some-event matches /events)
// as belonging to Explore or Engage, for the breadcrumb trail.
export const EXPLORE_PREFIXES = [
  '/about',
  '/people',
  '/our-journey',
  '/in-pictures',
  '/ecosystem',
  '/resource-centre',
  '/events',
];

export const ENGAGE_PREFIXES = ['/visit', '/join', '/contact'];

export function sectionFor(pathname: string): { label: 'Explore' | 'Engage'; href: string } | null {
  const matches = (prefix: string) => pathname === prefix || pathname.startsWith(prefix + '/');
  if (EXPLORE_PREFIXES.some(matches)) return { label: 'Explore', href: '/#explore' };
  if (ENGAGE_PREFIXES.some(matches)) return { label: 'Engage', href: '/#engage' };
  return null;
}
