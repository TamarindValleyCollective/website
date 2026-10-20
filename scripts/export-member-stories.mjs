// Part of `npm run build`: fetches the member cards that are PUBLIC from the live site's
// /api/members-published function and writes what the Members page merges over the 2017 cards:
//   src/data/members-published.json    the cards (and which 2017 cards to reduce to a name)
//   public/images/members/up-*.jpg     the uploaded photos, square and full (not committed)
//
// The build has no database or R2 credentials (they are scoped to Functions on purpose), so it asks a
// function that returns only what the public site shows anyway. See netlify/functions/members-public.mts
// and scripts/lib/member-publish.mjs, and docs/plans/member-portal.md, "Public export".
//
// What happens when it cannot get an answer:
//   - the endpoint does not exist yet (404: the first deploy of this feature): skipped, the committed
//     file is kept, and the build carries on;
//   - anything else (a timeout, a 5xx, a response that is not the expected shape) in a PRODUCTION build:
//     the build FAILS, so the site that is already live stays up and keeps the stories it has, instead of
//     quietly going back to the 2017 text; in any other context it warns and carries on.
// MEMBERS_EXPORT_BASE points it elsewhere (a local test server); MEMBERS_EXPORT_SKIP=1 skips it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { jpegInfo } from './lib/member-photo.mjs';
import { photoFileFor, resolvePhotos, sanitizePublished, uploadedPhotos } from './lib/member-publish.mjs';

const BASE = (process.env.MEMBERS_EXPORT_BASE || 'https://tvc.farm').replace(/\/$/, '');
const OUT_JSON = new URL('../src/data/members-published.json', import.meta.url);
const OUT_DIR = new URL('../public/images/members/', import.meta.url);
const PRODUCTION = process.env.CONTEXT === 'production';
const log = (m) => console.log(`[export-member-stories] ${m}`);

class Skip extends Error {}

async function get(path, { json = true } = {}) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 404 && json) throw new Skip(`${path} does not exist yet`);
      if (!res.ok) throw new Error(`${path} answered ${res.status}`);
      return json ? await res.json() : new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof Skip) throw err;
      last = err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw last;
}

async function main() {
  if (process.env.MEMBERS_EXPORT_SKIP === '1') return log('skipped (MEMBERS_EXPORT_SKIP=1)');
  const clean = sanitizePublished(await get('/api/members-published'));
  if (!clean) throw new Error('the response is not the expected shape');

  mkdirSync(OUT_DIR, { recursive: true });
  const downloaded = new Set();
  for (const id of uploadedPhotos(clean.cards)) {
    // a card name is needed for the file name; use the first card that carries this photo
    const card = clean.cards.find((c) => c.photo === id || c.photos?.includes(id));
    try {
      const files = photoFileFor(card.name, id);
      for (const [size, path] of Object.entries(files)) {
        const bytes = await get(`/api/members-published-photo?id=${id}&size=${size}`, { json: false });
        const info = jpegInfo(bytes);
        if (!info.ok || info.hasExif || bytes.length > 2_000_000) throw new Error(`the ${size} photo is not a clean JPEG`);
        writeFileSync(new URL(`../public${path}`, import.meta.url), bytes);
      }
      downloaded.add(id);
    } catch (err) {
      // one bad photo costs that card its picture, not the build
      console.warn(`[export-member-stories] a photo could not be downloaded (${err.message}); that card goes without it`);
    }
  }

  const cards = clean.cards.map((c) => resolvePhotos(c, downloaded));
  writeFileSync(OUT_JSON, `${JSON.stringify({ generatedAt: new Date().toISOString(), cards, hidden: clean.hidden }, null, 2)}\n`);
  log(`${cards.length} published card${cards.length === 1 ? '' : 's'}, ${clean.hidden.length} reduced to a name, ${downloaded.size} photo${downloaded.size === 1 ? '' : 's'} downloaded`);
}

main().catch((err) => {
  if (err instanceof Skip) return log(`skipped: ${err.message}`);
  if (PRODUCTION) {
    console.error(`[export-member-stories] FAILED in a production build: ${err.message}. Failing the build so the live site keeps its current stories.`);
    process.exit(1);
  }
  console.warn(`[export-member-stories] skipped: ${err.message}`);
});
