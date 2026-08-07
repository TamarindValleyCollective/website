#!/usr/bin/env node
// Checks Google's own indexing/crawl status for one or more live URLs via
// the Search Console API, instead of eyeballing the Pages report by hand.
// Useful right after landing a redirect fix (see netlify.toml) to see
// whether Google has recrawled and picked it up yet.
//
// Usage:
//   node scripts/check-search-console.mjs <url> [url...]
//
// Requires a local .env (gitignored, never commit it) with:
//   GDRIVE_SERVICE_ACCOUNT_EMAIL=...
//   GDRIVE_SERVICE_ACCOUNT_PRIVATE_KEY=...
//
// The service account must be added as a Restricted (or Full) user on the
// tvc.farm Search Console property first — Settings → Users and
// permissions — otherwise every call 403s.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectUrl } from './lib/google-drive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const envPath = path.join(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const SITE_URL = 'https://tvc.farm/';

async function main() {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error('Usage: node scripts/check-search-console.mjs <url> [url...]');
    process.exit(1);
  }

  for (const url of urls) {
    try {
      const { inspectionResult } = await inspectUrl(SITE_URL, url);
      const idx = inspectionResult?.indexStatusResult;
      // coverageState (e.g. "Not found (404)", "Submitted and indexed") is
      // what actually shows up in the Pages report — the top-level verdict
      // (PASS/NEUTRAL/FAIL) is coarser and less informative on its own.
      const state = idx?.coverageState ?? 'UNKNOWN';
      const lastCrawl = idx?.lastCrawlTime ? new Date(idx.lastCrawlTime).toISOString() : 'never crawled';
      const finalUrl = idx?.googleCanonical && idx.googleCanonical !== url ? ` → ${idx.googleCanonical}` : '';
      console.log(`${state.padEnd(24)} ${url}${finalUrl}  (last crawl: ${lastCrawl})`);
    } catch (err) {
      console.error(`ERROR                    ${url}: ${err.message}`);
    }
  }
}

main();
