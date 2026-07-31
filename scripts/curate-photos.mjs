#!/usr/bin/env node
// Offline curation tool for the In Pictures page. Run this locally against a
// folder of photos you've already selected (curation itself - picking which
// photos are worth publishing - happens outside this script, by hand).
//
// For each image it: extracts EXIF/GPS via exifr, generates a display and a
// thumbnail JPEG via sharp, uploads both to the tvc-photos R2 bucket, and
// writes one src/content/photos/*.md entry per photo. Photos with no EXIF
// (WhatsApp-forwarded, screenshots, etc.) still get curated - they just end
// up with no camera/gps frontmatter, which the page already renders
// gracefully.
//
// HEIC/HEIF (iPhone photos): exifr reads their EXIF directly, same as any
// other format, but sharp's bundled libheif rejects most real iPhone photos
// outright ("Security limit exceeded: Number of references in iref box") -
// modern iPhones attach enough auxiliary images (thumbnail, depth map,
// portrait/HDR data) to trip a hard-coded libheif limit sharp doesn't expose
// a way to raise. heic-convert (a WASM libheif build with no such limit)
// decodes the pixels to a JPEG buffer first; only that intermediate buffer
// goes to sharp for the actual resize/thumbnail work. EXIF extraction is
// unaffected either way since it never goes through sharp.
//
// If a photo has a sibling "<filename>.caption.txt" file next to it (written
// by scripts/pull-approved-photos.mjs when a curator saved a description in
// the /internal/photo-pool dashboard), its contents are used as the real
// caption instead of the usual filename-derived placeholder.
//
// Usage:
//   node scripts/curate-photos.mjs <folder-of-photos> [--dry-run]
//
// Requires a local .env (gitignored, never commit it) with:
//   R2_ACCOUNT_ID=...
//   R2_ACCESS_KEY_ID=...
//   R2_SECRET_ACCESS_KEY=...
//   R2_BUCKET_NAME=tvc-photos           (optional, this is the default)
//
// --dry-run parses EXIF and reports what would happen without uploading to
// R2 or writing any content files - use it to sanity-check a batch first.

import { readdir, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import exifr from 'exifr';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const contentDir = path.join(root, 'src', 'content', 'photos');

const PUBLIC_BASE_URL = 'https://media.tvc.farm';
const DISPLAY_MAX = 1600;
const THUMB_MAX = 400;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif']);
const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);

const envPath = path.join(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sourceDir = args.find((a) => !a.startsWith('--'));

if (!sourceDir) {
  console.error('Usage: node scripts/curate-photos.mjs <folder-of-photos> [--dry-run]');
  process.exit(1);
}

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME = 'tvc-photos' } = process.env;

if (!dryRun && (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY)) {
  console.error(
    'Missing R2 credentials. Add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY to a .env file in the ' +
      'project root (see this script\'s header comment), or pass --dry-run to test without uploading.'
  );
  process.exit(1);
}

const s3 = dryRun
  ? null
  : new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });

// ---- EXIF field formatting -------------------------------------------------

function formatAperture(fNumber) {
  // EXIF FNumber often arrives as an imprecise float (e.g. 1.7799999713880652
  // from a rational conversion) - round to the 1 decimal place cameras
  // actually report (f/1.8, f/2.8, ...) instead of baking in the noise.
  return typeof fNumber === 'number' ? `f/${Math.round(fNumber * 10) / 10}` : undefined;
}

function formatShutterSpeed(exposureTime) {
  if (typeof exposureTime !== 'number' || exposureTime <= 0) return undefined;
  if (exposureTime >= 1) return `${exposureTime}s`;
  const denominator = Math.round(1 / exposureTime);
  return `1/${denominator}s`;
}

function formatIso(iso) {
  return typeof iso === 'number' ? `ISO ${iso}` : undefined;
}

function formatFocalLength(focalLength) {
  return typeof focalLength === 'number' ? `${Math.round(focalLength)}mm` : undefined;
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ---- per-photo pipeline -----------------------------------------------------

async function processPhoto(filePath) {
  const filename = path.basename(filePath);
  const exif = await exifr.parse(filePath, { gps: true, tiff: true, exif: true, ifd0: true }).catch(() => null);

  const captionSidecarPath = `${filePath}.caption.txt`;
  const sidecarCaption = existsSync(captionSidecarPath) ? (await readFile(captionSidecarPath, 'utf-8')).trim() : null;

  const takenAt = exif?.DateTimeOriginal ?? exif?.CreateDate ?? (await import('node:fs/promises').then((fs) => fs.stat(filePath))).mtime;

  const gps =
    exif?.latitude != null && exif?.longitude != null ? { lat: exif.latitude, lng: exif.longitude } : undefined;

  const camera =
    exif?.Make || exif?.Model
      ? { make: exif.Make ?? 'Unknown', model: exif.Model ?? 'Unknown', lens: exif.LensModel || undefined }
      : undefined;

  const exifOut = camera
    ? {
        aperture: formatAperture(exif.FNumber),
        shutterSpeed: formatShutterSpeed(exif.ExposureTime),
        iso: formatIso(exif.ISO),
        focalLength: formatFocalLength(exif.FocalLength),
      }
    : undefined;

  // heic-convert already applies the HEIC container's own rotation/mirror
  // transforms while decoding (HEIF stores those as box properties, not an
  // EXIF Orientation tag the way JPEG does), so the JPEG buffer it produces
  // needs no further rotation - .rotate() below is then a harmless no-op
  // for it, same as for a JPEG with no Orientation tag.
  const isHeic = HEIC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  const sharpInput = isHeic
    ? Buffer.from(await heicConvert({ buffer: await readFile(filePath), format: 'JPEG', quality: 0.92 }))
    : filePath;

  const image = sharp(sharpInput).rotate(); // auto-orient from EXIF before resizing
  const metadata = await image.metadata();

  const displayBuffer = await image.clone().resize({ width: DISPLAY_MAX, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  const thumbBuffer = await image.clone().resize({ width: THUMB_MAX, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();

  const dateStr = takenAt.toISOString().slice(0, 10);
  const slug = `${dateStr}-${slugify(filename)}`;
  const displayKey = `photos/${dateStr.slice(0, 4)}/${slug}-display.jpg`;
  const thumbKey = `photos/${dateStr.slice(0, 4)}/${slug}-thumb.jpg`;

  return {
    slug,
    filename,
    displayKey,
    thumbKey,
    displayBuffer,
    thumbBuffer,
    hasSidecarCaption: Boolean(sidecarCaption),
    frontmatter: {
      src: `${PUBLIC_BASE_URL}/${displayKey}`,
      thumbSrc: `${PUBLIC_BASE_URL}/${thumbKey}`,
      // Curator-written caption if a .caption.txt sidecar exists; otherwise
      // a filename-derived placeholder - review and rewrite after running.
      caption: sidecarCaption || filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
      takenAt: dateStr,
      width: metadata.width,
      height: metadata.height,
      gps,
      camera,
      exif: exifOut,
    },
  };
}

function toFrontmatterYaml(fm) {
  const lines = [
    `src: "${fm.src}"`,
    `thumbSrc: "${fm.thumbSrc}"`,
    `caption: "${fm.caption.replace(/"/g, '\\"')}"`,
    `takenAt: ${fm.takenAt}`,
  ];
  if (fm.width) lines.push(`width: ${fm.width}`);
  if (fm.height) lines.push(`height: ${fm.height}`);
  if (fm.gps) lines.push(`gps:\n  lat: ${fm.gps.lat}\n  lng: ${fm.gps.lng}`);
  if (fm.camera) {
    lines.push(`camera:\n  make: "${fm.camera.make}"\n  model: "${fm.camera.model}"`);
    if (fm.camera.lens) lines.push(`  lens: "${fm.camera.lens}"`);
  }
  if (fm.exif) {
    const e = fm.exif;
    const exifLines = [];
    if (e.aperture) exifLines.push(`  aperture: "${e.aperture}"`);
    if (e.shutterSpeed) exifLines.push(`  shutterSpeed: "${e.shutterSpeed}"`);
    if (e.iso) exifLines.push(`  iso: "${e.iso}"`);
    if (e.focalLength) exifLines.push(`  focalLength: "${e.focalLength}"`);
    if (exifLines.length) lines.push(`exif:\n${exifLines.join('\n')}`);
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

async function main() {
  const absSourceDir = path.resolve(sourceDir);
  if (!existsSync(absSourceDir)) {
    console.error(`Folder not found: ${absSourceDir}`);
    process.exit(1);
  }

  const entries = await readdir(absSourceDir);
  const files = entries.filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()));

  if (files.length === 0) {
    console.log(`No .jpg/.jpeg/.png/.heic/.heif files found in ${absSourceDir}.`);
    return;
  }

  if (!dryRun) await mkdir(contentDir, { recursive: true });

  let withGps = 0;
  let withCamera = 0;

  for (const file of files) {
    const filePath = path.join(absSourceDir, file);
    let result;
    try {
      result = await processPhoto(filePath);
    } catch (err) {
      console.error(`✗ ${file}: ${err.message}`);
      continue;
    }

    if (result.frontmatter.gps) withGps++;
    if (result.frontmatter.camera) withCamera++;

    const tags = [
      result.frontmatter.gps ? 'gps' : null,
      result.frontmatter.camera ? 'exif' : null,
      result.hasSidecarCaption ? 'caption' : null,
    ].filter(Boolean);
    console.log(`${dryRun ? '[dry-run] ' : ''}✓ ${file} -> ${result.slug} ${tags.length ? `(${tags.join(', ')})` : '(no EXIF)'}`);

    if (dryRun) continue;

    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: result.displayKey, Body: result.displayBuffer, ContentType: 'image/jpeg' }));
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: result.thumbKey, Body: result.thumbBuffer, ContentType: 'image/jpeg' }));

    const mdPath = path.join(contentDir, `${result.slug}.md`);
    await writeFile(mdPath, toFrontmatterYaml(result.frontmatter));
  }

  console.log('');
  console.log(`${files.length} photos processed - ${withGps} with GPS, ${withCamera} with camera data.`);
  if (dryRun) {
    console.log('Dry run only - nothing was uploaded or written. Re-run without --dry-run to publish.');
  } else {
    console.log(`Entries written to ${path.relative(root, contentDir)}/ - review captions before committing.`);
  }
}

main();
