// Shared by the homepage's principles teaser (src/pages/index.astro) and the
// fuller "What we stand for" treatment on src/pages/about.astro, so the two
// can't drift out of sync with each other.

export interface Principle {
  name: string;
  desc: string;
}

export const PRINCIPLES: Principle[] = [
  { name: 'Environmental Health', desc: 'Protecting soil, water, air, and biodiversity.' },
  { name: 'Economic Profitability', desc: 'Ensuring the farm remains viable for the long term.' },
  { name: 'Social Equity', desc: 'Fair treatment for farm workers and communities.' },
  { name: 'Resource Efficiency', desc: 'Minimizing non-renewable inputs and waste.' },
];
