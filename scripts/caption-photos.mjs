#!/usr/bin/env node
// Backfills AI-drafted captions for existing src/content/photos/*.md entries
// that still have the filename-derived placeholder caption written by
// curate-photos.mjs (e.g. "img 0795"). Uses Claude's vision API to look at
// each photo's thumbnail and suggest a short, literal caption - these are a
// starting point, not final copy. Review and rewrite after running this.
//
// Usage:
//   node scripts/caption-photos.mjs [--dry-run]
//
// Requires ANTHROPIC_API_KEY in a local .env (gitignored).

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const contentDir = path.join(root, 'src', 'content', 'photos');

const envPath = path.join(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Missing ANTHROPIC_API_KEY. Add it to a .env file in the project root.');
  process.exit(1);
}

// Placeholder captions from curate-photos.mjs are just the filename with
// separators turned into spaces (e.g. "IMG_0795.JPG" -> "img 0795"). Detect
// that shape so re-running this script only touches un-captioned entries.
function looksLikePlaceholder(caption) {
  return /^img[ -]?\d+$/i.test(caption.trim());
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;
  const body = match[1];
  const get = (key) => {
    const m = body.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?\\s*$`, 'm'));
    return m ? m[1] : undefined;
  };
  return { fullMatch: match[0], src: get('src'), thumbSrc: get('thumbSrc'), caption: get('caption') };
}

async function fetchImageBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.toString('base64');
}

async function generateCaption(imageBase64) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 60,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
            {
              type: 'text',
              text:
                'Write a short, literal, factual caption for this photo (under 12 words, no fluff, no "a photo of"). ' +
                'It is from a permaculture farm community. Describe only what is visibly happening - people, activity, ' +
                'setting, plants, animals. Do not guess names or invent context. Reply with only the caption text.',
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.type === 'text' ? data.content[0].text.trim() : '';
  return text.replace(/^["']|["']$/g, '');
}

async function main() {
  const files = (await readdir(contentDir)).filter((f) => f.endsWith('.md'));

  let updated = 0;
  let skipped = 0;

  for (const file of files) {
    const filePath = path.join(contentDir, file);
    const raw = await readFile(filePath, 'utf-8');
    const fm = parseFrontmatter(raw);

    if (!fm || !fm.caption || !looksLikePlaceholder(fm.caption)) {
      skipped++;
      continue;
    }

    const imageUrl = fm.thumbSrc || fm.src;
    try {
      const imageBase64 = await fetchImageBase64(imageUrl);
      const caption = await generateCaption(imageBase64);

      if (!caption) {
        console.log(`? ${file}: empty response, left unchanged`);
        continue;
      }

      console.log(`${dryRun ? '[dry-run] ' : ''}✓ ${file}: "${fm.caption}" -> "${caption}"`);
      updated++;

      if (dryRun) continue;

      const escaped = caption.replace(/"/g, '\\"');
      const newRaw = raw.replace(/^caption: "[^"]*"$/m, `caption: "${escaped}"`);
      await writeFile(filePath, newRaw);
    } catch (err) {
      console.error(`✗ ${file}: ${err.message}`);
    }
  }

  console.log('');
  console.log(`${updated} captions ${dryRun ? 'would be updated' : 'updated'}, ${skipped} already had a real caption.`);
  if (!dryRun) console.log('Review the results - these are drafts, rewrite any that need real names/context.');
}

main();
