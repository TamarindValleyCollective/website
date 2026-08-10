#!/usr/bin/env node
// Downloads one member's photo from the "TVC Members: Your Story" response
// Sheet (see check-member-story-responses.mjs and RAZORPAY.md-style docs
// note in ARCHITECTURE.md) and drops it into public/images/members/ ready
// to reference from MembersView.astro.
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

// .rotate() with no args reads the EXIF orientation tag and bakes the
// correct rotation into the pixels *before* resize/crop touches them, then
// the encode step strips EXIF (default) so the output has no leftover
// orientation tag for a browser to (dis)honor - matches every other photo
// already in this folder, all plain unrotated 400x400 squares.
await sharp(buf)
  .rotate()
  .resize(400, 400, { fit: 'cover' })
  .jpeg({ quality: 85, progressive: true })
  .toFile(outPath);

console.log(`wrote ${path.relative(root, outPath)} (${buf.length} bytes source)`);
