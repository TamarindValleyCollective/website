#!/usr/bin/env node
// Downloads everything a curator has approved via the /internal/photo-pool
// dashboard (Google Drive "Approved" folder) into a local folder, moving
// each file to "Published" in Drive right after its own download succeeds
// (per-file, not batch-at-end, so a mid-run failure can't cause
// re-downloads next run).
//
// If a curator wrote a description for a photo in the dashboard (saved to
// the Drive file's own description field), this writes it alongside as a
// "<filename>.caption.txt" sidecar — curate-photos.mjs picks that up as the
// real caption instead of its usual filename-derived placeholder. Photos
// with no description get no sidecar and fall back to that placeholder,
// same as any other hand-picked folder. Once this script is done, run the
// existing pipeline exactly as you would on any local folder:
//   node scripts/curate-photos.mjs <destination-folder> --dry-run
//   node scripts/curate-photos.mjs <destination-folder>
//
// Usage:
//   node scripts/pull-approved-photos.mjs [destination-folder] [--dry-run]
//
// Requires a local .env (gitignored, never commit it) with:
//   GDRIVE_SERVICE_ACCOUNT_EMAIL=...
//   GDRIVE_SERVICE_ACCOUNT_PRIVATE_KEY=...
//   GDRIVE_APPROVED_FOLDER_ID=...
//   GDRIVE_PUBLISHED_FOLDER_ID=...
//
// --dry-run lists what would be downloaded without downloading, writing
// any files, or moving anything in Drive.

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles, moveFile, downloadFile } from './lib/google-drive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const envPath = path.join(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const destArg = args.find((a) => !a.startsWith('--'));
const destDir = path.resolve(destArg ?? './drive-approved');

const { GDRIVE_APPROVED_FOLDER_ID, GDRIVE_PUBLISHED_FOLDER_ID } = process.env;

if (!GDRIVE_APPROVED_FOLDER_ID || !GDRIVE_PUBLISHED_FOLDER_ID) {
  console.error(
    'Missing GDRIVE_APPROVED_FOLDER_ID or GDRIVE_PUBLISHED_FOLDER_ID. Add them (plus ' +
      'GDRIVE_SERVICE_ACCOUNT_EMAIL and GDRIVE_SERVICE_ACCOUNT_PRIVATE_KEY) to a .env file in the ' +
      'project root — see this script\'s header comment.'
  );
  process.exit(1);
}

async function main() {
  const files = await listFiles(GDRIVE_APPROVED_FOLDER_ID);

  if (files.length === 0) {
    console.log('Nothing in the Approved folder right now.');
    return;
  }

  if (!dryRun) await mkdir(destDir, { recursive: true });

  let downloaded = 0;

  for (const file of files) {
    if (dryRun) {
      console.log(`[dry-run] would download ${file.name} (${file.id})${file.description?.trim() ? ' (with caption)' : ''}`);
      continue;
    }

    try {
      const res = await downloadFile(file.id);
      const buffer = Buffer.from(await res.arrayBuffer());
      await writeFile(path.join(destDir, file.name), buffer);
      if (file.description?.trim()) {
        await writeFile(path.join(destDir, `${file.name}.caption.txt`), file.description.trim());
      }
      await moveFile(file.id, GDRIVE_APPROVED_FOLDER_ID, GDRIVE_PUBLISHED_FOLDER_ID);
      console.log(`✓ ${file.name}${file.description?.trim() ? ' (with caption)' : ''}`);
      downloaded++;
    } catch (err) {
      console.error(`✗ ${file.name}: ${err.message}`);
      console.error('  Left in Approved — safe to re-run this script to retry.');
    }
  }

  console.log('');
  if (dryRun) {
    console.log(`${files.length} photo(s) would be downloaded. Re-run without --dry-run to pull them.`);
  } else {
    console.log(`${downloaded}/${files.length} photo(s) downloaded to ${path.relative(root, destDir)}/ and moved to Published in Drive.`);
    if (downloaded > 0) {
      console.log(`Next: node scripts/curate-photos.mjs ${path.relative(root, destDir)} --dry-run`);
    }
  }
}

main();
