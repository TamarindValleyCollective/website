// Single source of truth for the site's Explore/Engage information architecture —
// Nav, Footer, and Breadcrumbs all read from this file so the three never drift
// out of sync with each other or with the homepage's own Explore/Engage sections.

export interface SiteLink {
  label: string;
  href: string;
}

export const EXPLORE_LINKS: SiteLink[] = [
  { label: 'About TVC', href: '/about' },
  { label: 'Our Journey', href: '/our-journey' },
  { label: 'In Pictures', href: '/in-pictures' },
  { label: 'Biodiversity', href: '/ecosystem' },
  { label: 'Geography & Weather', href: '/ecosystem/geography' },
  { label: 'Resource Centre', href: '/resource-centre' },
  { label: 'Partners', href: '/ecosystem/partners' },
  { label: 'Events', href: '/events' },
];

export const ENGAGE_LINKS: SiteLink[] = [
  { label: 'Visit TVC', href: '/visit' },
  { label: 'Day Visit', href: '/visit/day-visit' },
  { label: 'Overnight Camping', href: '/visit/camping' },
  { label: 'Trekking Trails', href: '/visit/trekking-trails' },
  { label: 'How to Reach', href: '/visit/how-to-reach' },
  { label: 'Join the Collective', href: '/join' },
  { label: 'Contact Us', href: '/contact' },
];

// Path prefixes used to classify a page (including dynamic slug pages, which
// inherit their parent's prefix — e.g. /events/some-event matches /events)
// as belonging to Explore or Engage, for the breadcrumb trail.
export const EXPLORE_PREFIXES = [
  '/about',
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
