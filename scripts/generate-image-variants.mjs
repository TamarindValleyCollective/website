// Pre-build step (see package.json's "build" script, runs before `astro
// build`). public/images/**/*.{jpg,jpeg,png} are plain files Astro copies
// to dist/ as-is - it never runs its image-optimization pipeline on them,
// since that pipeline only covers images imported as ESM modules from src/.
// Rather than migrate every content-collection frontmatter path and
// hardcoded <img src> across the site to a src/assets import (a much larger,
// riskier change touching 50+ markdown files and the already-hard-won
// OG/JSON-LD image-dimension logic in BaseLayout - see its own comments),
// this generates a same-directory .webp + .avif sibling next to every
// source raster, which components/Picture.astro then references via
// <source> - the original file stays put and every existing string
// reference to it (OG tags, JSON-LD, content collection fields) is
// untouched.
//
// Never overwrites an existing target - a handful of .webp files already
// exist under public/images (hero.webp, hero-thumb.webp, etc.) as
// deliberately hand-curated assets (some are cropped thumbnails, not just
// format conversions of the same-named source - see HomeView.astro's
// comments), already referenced directly by several pages. Skip-if-exists
// means those are left alone and simply get reused as-is by
// Picture.astro's same-basename lookup.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.join(process.cwd(), 'public', 'images');
// .webp is also a source (not just a target) - a handful of pre-existing,
// hand-curated .webp thumbnails (see comment above) have no same-named
// jpg/png to derive from, but still deserve an .avif sibling.
const SOURCE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

async function targetExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function generateVariant(sourcePath, format) {
  const targetPath = sourcePath.replace(/\.[^.]+$/, `.${format}`);
  if (await targetExists(targetPath)) return;
  const image = sharp(sourcePath);
  if (format === 'webp') await image.webp({ quality: 80 }).toFile(targetPath);
  else await image.avif({ quality: 60 }).toFile(targetPath);
}

let processed = 0;
for await (const file of walk(ROOT)) {
  const ext = path.extname(file).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(ext)) continue;
  const targets = ext === '.webp' ? [generateVariant(file, 'avif')] : [generateVariant(file, 'webp'), generateVariant(file, 'avif')];
  await Promise.all(targets);
  processed++;
}

console.log(`generate-image-variants: checked ${processed} source images under public/images/`);
