#!/usr/bin/env node
// Downloads one member's photo from the "TVC Members: Your Story" response
// Sheet (see check-member-story-responses.mjs and RAZORPAY.md-style docs
// note in ARCHITECTURE.md) and drops it into public/images/members/ ready
// to reference from MembersView.astro.
//
// Writes two files: the existing 400x400 square crop (card thumbnail/popup
// avatar) plus an uncropped `-full` version capped at 1600px on the long
// edge, for the popup's click-to-enlarge lightbox - the square crop alone
// isn't enough there since a group photo often loses people/context to the
// crop (e.g. Om & Pavithra's card, caught 2026-08-12: the square-cropped
// avatar was the only asset the lightbox could show, so "enlarge" just
// blew up an already-cropped thumbnail instead of revealing the actual
// photo). Member.photoFull/photosFull point at this second file; cards
// with no full version (the ~53 legacy photos, or any processed before
// this) just fall back to the square crop, same as today.
//
// Always call this rather than hand-rolling a one-off download+resize
// script per batch - .rotate() (auto-orient from EXIF) below exists
// specifically because an earlier ad-hoc version omitted it: sharp does
// NOT auto-rotate on resize by default, so a photo taken in portrait on a
// phone (EXIF orientation tag, pixels stored landscape) got cropped/resized
// against its raw un-rotated pixels and came out sideways once the resize
// baked in a fixed rotation with no EXIF left to correct it after the fact
// (Sree & Prameela's card, caught 2026-08-10, PR #68/#69).
//
// Usage:
//   node scripts/fetch-member-photo.mjs <driveFileId> <output-filename.jpg>
//
// Requires the same .env vars as check-member-story-responses.mjs
// (GDRIVE_SERVICE_ACCOUNT_EMAIL/_PRIVATE_KEY). The Drive file must be
// readable by that service account - if this 404s, that's a Drive sharing
// gap (the Form's upload folder needs to be shared with the service account
// separately from the response Sheet), not a bug here.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { downloadFile } from './lib/google-drive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const envPath = path.join(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const [fileId, outName] = process.argv.slice(2);
if (!fileId || !outName) {
  console.error('Usage: node scripts/fetch-member-photo.mjs <driveFileId> <output-filename.jpg>');
  process.exit(1);
}

const res = await downloadFile(fileId);
const buf = Buffer.from(await res.arrayBuffer());
const outPath = path.join(root, 'public/images/members', outName);
const fullOutPath = path.join(root, 'public/images/members', outName.replace(/\.jpg$/i, '-full.jpg'));

// .rotate() with no args reads the EXIF orientation tag and bakes the
// correct rotation into the pixels *before* resize/crop touches them, then
// the encode step strips EXIF (default) so the output has no leftover
// orientation tag for a browser to (dis)honor - matches every other photo
// already in this folder, all plain unrotated 400x400 squares. .clone()
// runs the square-crop and full-size pipelines off the same decoded/rotated
// source rather than re-reading and re-rotating the buffer twice.
const rotated = sharp(buf).rotate();

await rotated
  .clone()
  .resize(400, 400, { fit: 'cover' })
  .jpeg({ quality: 85, progressive: true })
  .toFile(outPath);

await rotated
  .clone()
  .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 88, progressive: true })
  .toFile(fullOutPath);

console.log(`wrote ${path.relative(root, outPath)} and ${path.relative(root, fullOutPath)} (${buf.length} bytes source)`);
