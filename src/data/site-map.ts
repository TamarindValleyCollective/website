// Single source of truth for the site's Explore/Engage information architecture —
// Nav, Footer, and Breadcrumbs all read from this file so the three never drift
// out of sync with each other or with the homepage's own Explore/Engage sections.

export interface SiteLink {
  label: string;
  // Dictionary key under `nav.*` (src/i18n/{en,kn,ta}.ts) - lets Nav/Footer/
  // the homepage render a translated label instead of the English `label`
  // fallback above, without this file needing to know about locales itself.
  key: string;
  href: string;
}

export const EXPLORE_LINKS: SiteLink[] = [
  { label: 'About TVC', key: 'about', href: '/about' },
  { label: 'People', key: 'people', href: '/people' },
  { label: 'Our Journey', key: 'ourJourney', href: '/our-journey' },
  { label: 'In Pictures', key: 'inPictures', href: '/in-pictures' },
  { label: 'Biodiversity', key: 'biodiversity', href: '/ecosystem' },
  { label: 'Weather', key: 'weather', href: '/ecosystem/geography' },
  { label: 'Resource Centre', key: 'resourceCentre', href: '/resource-centre' },
  { label: 'Events', key: 'events', href: '/events' },
];

export const ENGAGE_LINKS: SiteLink[] = [
  { label: 'Visit TVC', key: 'visitTvc', href: '/visit' },
  { label: 'Day Visit', key: 'dayVisit', href: '/visit/day-visit' },
  { label: 'Overnight Camping', key: 'camping', href: '/visit/camping' },
  { label: 'Host an Event', key: 'hostAnEvent', href: '/visit/host-an-event' },
  { label: 'Trekking Trails', key: 'trekkingTrails', href: '/visit/trekking-trails' },
  { label: 'How to Reach', key: 'howToReach', href: '/visit/how-to-reach' },
  { label: 'Join the Collective', key: 'join', href: '/join' },
  { label: 'Contact Us', key: 'contact', href: '/contact' },
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
