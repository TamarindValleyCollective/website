// Shared by the homepage's principles teaser (src/pages/index.astro) and the
// fuller "What we stand for" treatment on src/pages/about.astro, so the two
// can't drift out of sync with each other.

export interface Principle {
  // Dictionary key under `principles.*` (src/i18n/{en,kn,ta}.ts) - name/desc
  // below are the English fallback, mirroring site-map.ts's SiteLink.key.
  key: string;
  name: string;
  desc: string;
}

export const PRINCIPLES: Principle[] = [
  { key: 'environmentalHealth', name: 'Environmental Health', desc: 'Protecting soil, water, air, and biodiversity.' },
  { key: 'economicProfitability', name: 'Economic Profitability', desc: 'Ensuring the farm remains viable for the long term.' },
  { key: 'socialEquity', name: 'Social Equity', desc: 'Fair treatment for farm workers and communities.' },
  { key: 'resourceEfficiency', name: 'Resource Efficiency', desc: 'Minimizing non-renewable inputs and waste.' },
];
