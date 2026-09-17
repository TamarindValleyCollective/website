// Runs after `astro build`. IndexNow lets a site push its full URL list to
// participating search engines (Bing, Yandex, Seznam, Naver, ...) instead of
// waiting for their crawlers to notice a change - api.indexnow.org fans the
// submission out to all of them from one call. Only fires on real Netlify
// production builds (CONTEXT=production) - a local `npm run build` or a
// deploy-preview/branch-deploy build has no business notifying search
// engines about a domain that isn't live at that URL.
//
// The key file at public/<key>.txt is IndexNow's ownership check: the
// protocol requires the key to be served at https://<host>/<key>.txt before
// it'll accept submissions signed with that key.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEXNOW_KEY = '051fae095f051244a7cf06c7e1271dbf';
const HOST = 'tvc.farm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');

if (process.env.CONTEXT !== 'production') {
  console.log('Skipping IndexNow submission (not a production build).');
  process.exit(0);
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

const indexXml = await readFile(path.join(distDir, 'sitemap-index.xml'), 'utf-8');
const sitemapUrls = extractLocs(indexXml);

const urlList = [];
for (const sitemapUrl of sitemapUrls) {
  const filename = path.basename(new URL(sitemapUrl).pathname);
  const xml = await readFile(path.join(distDir, filename), 'utf-8');
  urlList.push(...extractLocs(xml));
}

if (urlList.length === 0) {
  console.warn('IndexNow: no URLs found in the sitemap, skipping submission.');
  process.exit(0);
}

try {
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: HOST,
      key: INDEXNOW_KEY,
      keyLocation: `https://${HOST}/${INDEXNOW_KEY}.txt`,
      urlList,
    }),
  });
  if (res.ok) {
    console.log(`IndexNow: submitted ${urlList.length} URLs (${res.status}).`);
  } else {
    console.warn(`IndexNow: submission returned ${res.status} ${res.statusText} - not failing the build.`);
  }
} catch (err) {
  console.warn(`IndexNow: submission failed (${err.message}) - not failing the build.`);
}
