// Simple stroke icons for the internal staff pages (24x24 viewBox, drawn with
// currentColor). Shared by the sidebar (StaffLayout.astro) and the tool tiles on
// the landing page (internal/index.astro). Decorative: the text label is what
// screen readers read. Keyed by module id, plus 'home', 'access' and 'security'.
export const STAFF_ICONS: Record<string, string> = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  'photo-pool': '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>',
  whatsapp: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.5A8 8 0 1 1 21 12z"/>',
  'event-payments': '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  accommodation: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  usage: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  access: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M17 11a3 3 0 1 0 0-6M21 20c0-2.5-1.5-4.6-3.7-5.5"/>',
  security: '<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
};
