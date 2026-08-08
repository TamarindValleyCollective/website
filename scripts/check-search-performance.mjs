#!/usr/bin/env node
// Reports sitemap submission/crawl status and real search performance
// (clicks/impressions by page and query) from Search Console - the two
// report types that were blocked for the tvc-photo-pool service account
// until it was upgraded from Restricted to Full user (2026-08-08; see
// ARCHITECTURE.md). Complements check-search-console.mjs, which only
// inspects individual URLs one at a time.
//
// Usage:
//   node scripts/check-search-performance.mjs [days]
//
// days defaults to 28. Requires the same .env vars as
// check-search-console.mjs (GDRIVE_SERVICE_ACCOUNT_EMAIL/_PRIVATE_KEY).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSitemaps, querySearchAnalytics } from './lib/google-drive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const envPath = path.join(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const SITE_URL = 'https://tvc.farm/';

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function printTable(rows, label) {
  console.log(`\nTop ${label} by clicks:`);
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const row of rows) {
    const [key] = row.keys;
    console.log(
      `  ${String(row.clicks).padStart(4)} clicks  ${String(row.impressions).padStart(5)} impr  ` +
        `pos ${row.position.toFixed(1).padStart(5)}  ${key}`
    );
  }
}

async function main() {
  const days = Number(process.argv[2]) || 28;
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const startDate = isoDate(start);
  const endDate = isoDate(end);

  console.log('=== Sitemaps ===');
  const sitemaps = await listSitemaps(SITE_URL);
  if (sitemaps.length === 0) console.log('No sitemaps submitted.');
  for (const sm of sitemaps) {
    const contents = (sm.contents ?? [])
      .map((c) => `${c.submitted ?? 0} submitted / ${c.indexed ?? 0} indexed (${c.type})`)
      .join(', ');
    console.log(sm.path);
    console.log(`  last submitted: ${sm.lastSubmitted ?? 'never'}`);
    console.log(`  last downloaded: ${sm.lastDownloaded ?? 'never'}`);
    console.log(`  warnings: ${sm.warnings ?? 0}, errors: ${sm.errors ?? 0}`);
    if (contents) console.log(`  ${contents}`);
  }
  // The "indexed" count above is a known-unreliable field on this legacy
  // endpoint - it's shown 0 on sites with real, confirmed search traffic.
  // Cross-check against the performance numbers below rather than trusting
  // it alone.
  console.log('(Note: "indexed" above is a known-unreliable legacy field - cross-check against performance below.)');

  console.log(`\n=== Search performance (${startDate} to ${endDate}) ===`);
  const [totals] = await querySearchAnalytics(SITE_URL, { startDate, endDate });
  if (totals) {
    console.log(
      `Site-wide: ${totals.clicks} clicks, ${totals.impressions} impressions, ` +
        `${(totals.ctr * 100).toFixed(1)}% CTR, avg position ${totals.position.toFixed(1)}`
    );
  } else {
    console.log('No search performance data for this period.');
  }

  const pages = await querySearchAnalytics(SITE_URL, { startDate, endDate, dimensions: ['page'], rowLimit: 20 });
  printTable(pages, 'pages');

  const queries = await querySearchAnalytics(SITE_URL, { startDate, endDate, dimensions: ['query'], rowLimit: 20 });
  printTable(queries, 'queries');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
