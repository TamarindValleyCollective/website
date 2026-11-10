// The admin portal's navigation model: logical BLOCKS (Operations, Community, Finance, Settings), each holding the
// pages people work in. The shared shell (src/layouts/StaffLayout.astro) builds its rail and page panel from this, and
// scripts/lib/admin-nav.test.mjs keeps it honest against the permission registry (every registered tool must have a
// page here). Pure and I/O-free. Adding a page is one line below.
//
// Access is NOT decided here: a page shows when the person holds a role in its module (or is a super admin for the
// super-admin-only pages), and every tool still checks the role on the server for every request. Showing or hiding a
// page is only a convenience, as it was with the flat list.

export const HOME = { id: 'home', label: 'Today', path: '/internal/', icon: 'home' };

// `icon` names an entry in src/lib/staff-icons.ts. A page has either `module` (a role in that module opens it) or
// `superAdmin: true`. Several pages may share a module (Finance has three).
export const BLOCKS = [
  {
    id: 'operations',
    label: 'Operations',
    icon: 'accommodation',
    pages: [
      { id: 'accommodation', label: 'Stays', path: '/internal/accommodation-calendar/', module: 'accommodation' },
      { id: 'units', label: 'Rent out', path: '/internal/units/', superAdmin: true },
      { id: 'site-map', label: 'Map', path: '/internal/site-map/', module: 'site-map' },
      { id: 'whatsapp', label: 'WhatsApp', path: '/internal/whatsapp/', module: 'whatsapp' },
    ],
  },
  {
    id: 'community',
    label: 'Community',
    icon: 'members',
    pages: [
      { id: 'members', label: 'Members', path: '/internal/members/', module: 'members' },
      { id: 'photo-pool', label: 'Photos', path: '/internal/photo-pool/', module: 'photo-pool' },
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    icon: 'finance',
    pages: [
      { id: 'finance', label: 'Overview', path: '/internal/finance/', module: 'finance' },
      { id: 'finance-dashboard', label: 'Dashboard', path: '/internal/finance/dashboard/', module: 'finance' },
      { id: 'finance-ledger', label: 'Ledger', path: '/internal/finance/ledger/', module: 'finance' },
      { id: 'finance-upi', label: 'UPI', path: '/internal/finance/upi/', module: 'finance' },
      { id: 'finance-approvals', label: 'Approvals', path: '/internal/finance/requests/', module: 'finance' },
      { id: 'finance-parties', label: 'Parties', path: '/internal/finance/parties/', module: 'finance' },
      { id: 'finance-import', label: 'Import', path: '/internal/finance/import/', module: 'finance' },
      { id: 'finance-rules', label: 'Rules', path: '/internal/finance/rules/', module: 'finance' },
      { id: 'finance-requests', label: 'Requests', path: '/internal/finance-requests/', module: 'finance-requests' },
      { id: 'event-payments', label: 'Payments', path: '/internal/event-payments/', module: 'event-payments' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'security',
    pages: [
      { id: 'access', label: 'Access', path: '/internal/access/', superAdmin: true },
      { id: 'security', label: 'Security', path: '/internal/security/', superAdmin: true },
      { id: 'previews', label: 'Preview', path: '/internal/preview-features/', superAdmin: true },
      { id: 'usage', label: 'Usage', path: '/internal/usage/', module: 'usage' },
    ],
  },
];

const PAGE_BLOCK = new Map(BLOCKS.flatMap((b) => b.pages.map((p) => [p.id, b.id])));

// The block a page belongs to, or null for Today and for ids that are not pages.
export function blockOfPage(pageId) {
  return PAGE_BLOCK.get(pageId) ?? null;
}

// `me` is the answer of /api/staff-me ({ isSuperAdmin, tools: [{ module }] }) or null before it arrives.
function canOpen(page, me) {
  if (!me) return false;
  if (page.module) return me.tools.some((t) => t.module === page.module);
  return page.superAdmin === true && me.isSuperAdmin === true;
}

// The blocks and pages this person sees, with the current page and its block flagged. The page you are on is always
// included, so the pane never drops you even before the role lookup answers. Blocks with no visible page are left out.
export function visibleNav(me, currentPageId) {
  return BLOCKS.map((block) => {
    const pages = block.pages
      .filter((p) => p.id === currentPageId || canOpen(p, me))
      .map((p) => ({ ...p, current: p.id === currentPageId }));
    return { id: block.id, label: block.label, icon: block.icon, pages, current: pages.some((p) => p.current) };
  }).filter((b) => b.pages.length > 0);
}

// Where a block's link in the rail goes: the first page this person can open in it.
export function firstPage(block) {
  return block.pages[0];
}
