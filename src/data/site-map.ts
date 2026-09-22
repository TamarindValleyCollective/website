// Single source of truth for the site's top-nav information architecture —
// Nav and Breadcrumbs both read from this file so the two never drift out
// of sync with each other. Task-based grouping (what a visitor came here to
// do), not an internal taxonomy like the old Explore/Engage split: only
// Visit Us and About Us have genuine sub-pages, so only those two get a
// dropdown; Events and In Pictures are flat top-level links; Join Us and
// Contact Us (low-priority right now - membership is near capacity, and
// Resource Centre is deliberately left out entirely below) sit in a small
// "More" catch-all.
//
// The homepage's own "Explore, or engage" section (src/components/views/
// HomeView.astro) does NOT read from this file — it's hand-authored
// marketing copy per locale (taglines, card descriptions, imagery) that
// still reflects the old Explore/Engage framing. Migrating that is a
// separate, copy-heavy task, not a mechanical follow of this structure.

export interface SiteLink {
  label: string;
  // Dictionary key under `nav.*` (src/i18n/{en,kn,ta}.ts) - lets Nav/
  // Breadcrumbs render a translated label instead of the English `label`
  // fallback above, without this file needing to know about locales itself.
  key: string;
  href: string;
  // Sub-pages of this link (e.g. Ecosystem's Geography/Weather, Visit's
  // Day Visit/Camping/...) - one level deep only. Rendered indented under
  // their parent in Nav's dropdown instead of as flat top-level siblings,
  // since they're genuinely children of that page's URL, not independent
  // sections in their own right.
  children?: SiteLink[];
}

// One top-level nav entry: either a flat link with no dropdown (Events, In
// Pictures), or a group whose `children` open in a dropdown - optionally
// itself a real page (`href` set, like Visit Us/About Us) rather than a
// non-navigating toggle (like More, which has no landing page of its own).
export type NavSection =
  | { kind: 'link'; key: string; href: string }
  | { kind: 'dropdown'; key: string; href?: string; children: SiteLink[] };

const VISIT_CHILDREN: SiteLink[] = [
  { label: 'Day Visit', key: 'dayVisit', href: '/visit/day-visit' },
  { label: 'Overnight Stay', key: 'camping', href: '/visit/camping' },
  { label: 'Host an Event', key: 'hostAnEvent', href: '/visit/host-an-event' },
  { label: 'Trekking Trails', key: 'trekkingTrails', href: '/visit/trekking-trails' },
  { label: 'How to Reach', key: 'howToReach', href: '/visit/how-to-reach' },
];

const ABOUT_CHILDREN: SiteLink[] = [
  { label: 'The Design', key: 'aboutDesign', href: '/about/design' },
  { label: 'Our Journey', key: 'ourJourney', href: '/our-journey' },
  {
    label: 'People',
    key: 'people',
    href: '/people',
    children: [
      { label: 'Members', key: 'members', href: '/people/members' },
      { label: 'Staff', key: 'staff', href: '/people/staff' },
      { label: 'Partners', key: 'partners', href: '/people/partners' },
      { label: 'Outreach', key: 'communityOutreach', href: '/people/outreach' },
    ],
  },
  {
    label: 'Ecosystem',
    key: 'ecosystem',
    href: '/ecosystem',
    children: [
      { label: 'Biodiversity', key: 'biodiversity', href: '/ecosystem/biodiversity' },
      { label: 'Geography', key: 'landscape', href: '/ecosystem/landscape' },
      { label: 'Weather', key: 'weather', href: '/ecosystem/weather' },
    ],
  },
];

const MORE_CHILDREN: SiteLink[] = [
  { label: 'Join Us', key: 'join', href: '/join' },
  { label: 'Contact Us', key: 'contact', href: '/contact' },
];

export const NAV_SECTIONS: NavSection[] = [
  { kind: 'dropdown', key: 'visitTvc', href: '/visit', children: VISIT_CHILDREN },
  { kind: 'link', key: 'events', href: '/events' },
  { kind: 'dropdown', key: 'about', href: '/about', children: ABOUT_CHILDREN },
  { kind: 'link', key: 'inPictures', href: '/in-pictures' },
  { kind: 'dropdown', key: 'more', children: MORE_CHILDREN },
];

// Resource Centre (/resource-centre) is deliberately NOT in NAV_SECTIONS -
// its content is still too thin to advertise via menu or give it a
// breadcrumb trail back to a "section". The page itself stays live; it's
// just not discoverable through Nav or Breadcrumbs until it's enriched.

// Every direct child across all dropdown sections (People, Ecosystem, Our
// Journey, The Design, Visit's 5 sub-pages, Join Us, Contact Us) - used by
// parentLinkFor/navKeyFor below without re-walking NAV_SECTIONS by hand.
const ALL_CHILDREN: SiteLink[] = NAV_SECTIONS.flatMap((section) => (section.kind === 'dropdown' ? section.children : []));

// Every link in the tree at any depth - top sections with their own page,
// their direct children, and those children's own children (People's and
// Ecosystem's grandchildren) - for navKeyFor's exact-href lookup.
const ALL_LINKS: SiteLink[] = [
  ...NAV_SECTIONS.flatMap((section) => (section.href ? [{ label: '', key: section.key, href: section.href }] : [])),
  ...ALL_CHILDREN,
  ...ALL_CHILDREN.flatMap((child) => child.children ?? []),
];

// Classifies a page (including dynamic slug pages, which inherit their
// parent's prefix - e.g. /events/some-event matches /events) as belonging
// to one of NAV_SECTIONS, for the breadcrumb trail's first crumb after
// Home. Returns null for pages outside every section (the homepage,
// Resource Centre, legal pages, ...) - Breadcrumbs skips rendering rather
// than show a half-empty trail.
export function sectionFor(pathname: string): { key: string; href?: string } | null {
  const matches = (prefix: string) => pathname === prefix || pathname.startsWith(prefix + '/');
  for (const section of NAV_SECTIONS) {
    const ownHrefs = [section.href, ...(section.kind === 'dropdown' ? section.children.map((child) => child.href) : [])].filter(
      (href): href is string => href !== undefined,
    );
    if (ownHrefs.some(matches)) return { key: section.key, href: section.href };
  }
  return null;
}

// Breadcrumbs' final "current page" crumb needs a label for the page - and
// several pages have drifted into using a bespoke marketing title there
// ("Who's part of TVC", "From degraded land to a regenerating ecosystem")
// instead of the short nav-dropdown label ("People", "Our Journey"), which
// reads as the breadcrumb being out of sync with the URL/nav structure. For
// any page whose URL exactly matches a nav entry here, look up that entry's
// `key` so Breadcrumbs can render the translated nav label instead of
// trusting each page to have kept its own title in sync by hand - same
// single-source-of-truth reasoning as `sectionFor` above. Pages with no
// matching entry (dynamic sub-pages like individual events, member stories,
// outreach posts) fall back to their own title, since they're not nav items.
export function navKeyFor(pathname: string): string | null {
  return ALL_LINKS.find((link) => link.href === pathname)?.key ?? null;
}

// Any page nested one level under a *child* link's own URL (e.g.
// /people/outreach/some-post under People, /ecosystem/biodiversity under
// Ecosystem) reads as a child of that item, and the breadcrumb should say
// so with an intermediate crumb between the section and the current page -
// "About Us / People / Outreach", not just "Outreach" floating directly
// under the section. Only People and Ecosystem currently have their own
// children; flat children (Our Journey, The Design, Join Us, Visit's leaf
// pages) never match here, since nothing nests further under them - same
// as how a section's own index page doesn't repeat itself as its own
// parent crumb.
export function parentLinkFor(pathname: string): SiteLink | null {
  return ALL_CHILDREN.find((link) => pathname.startsWith(link.href + '/')) ?? null;
}
