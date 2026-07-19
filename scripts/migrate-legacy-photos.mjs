#!/usr/bin/env node
// One-time migration: brings the 114 photos that used to live as a hardcoded
// array in src/pages/in-pictures.astro into the new `photos` content
// collection, so the redesigned page has real content immediately. These
// predate the curation workflow (scripts/curate-photos.mjs) - they're old
// WhatsApp-forwarded/imported photos with no EXIF left, so entries here
// intentionally have no camera/gps/exif fields, and images stay on-disk
// under public/images/ rather than moving to R2 (nothing to gain by moving
// already-published, non-curated images). Safe to re-run; overwrites its
// own output each time. Not part of the ongoing curation workflow - run
// scripts/curate-photos.mjs for new photos going forward.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const contentDir = path.join(root, 'src', 'content', 'photos');
const publicDir = path.join(root, 'public');

// Mirrors the old hardcoded archive in in-pictures.astro - folder, a
// representative date for the bucket (exact per-photo dates aren't known),
// and a caption.
const BUCKETS = [
  { dir: 'public/images/pages/in-pictures/2020-10', takenAt: '2020-10-02', caption: 'TVC, October 2020' },
  { dir: 'public/images/pages/in-pictures/2019-2020', takenAt: '2019-06-01', caption: 'TVC, circa 2019–2020' },
  { dir: 'public/images/pages/in-pictures/2017-02', takenAt: '2017-02-01', caption: 'TVC, February 2017' },
];

// Same file lists as the old archive array, newest bucket first.
const FILES = {
  'public/images/pages/in-pictures/2020-10': [
    'WhatsApp-Image-2020-10-02-at-9.26.30-PM.jpeg', 'WhatsApp-Image-2020-10-02-at-9.26.25-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.26.24-PM-1.jpeg', 'WhatsApp-Image-2020-10-02-at-9.26.19-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.25.28-PM-1.jpeg', 'WhatsApp-Image-2020-10-02-at-9.25.28-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.25.25-PM.jpeg', 'WhatsApp-Image-2020-10-02-at-9.25.22-PM-1.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.25.22-PM.jpeg', 'WhatsApp-Image-2020-10-02-at-9.25.20-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.25.19-PM.jpeg', 'WhatsApp-Image-2020-10-02-at-9.25.18-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.25.16-PM.jpeg', 'WhatsApp-Image-2020-10-02-at-9.25.15-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.24.11-PM.jpeg', 'WhatsApp-Image-2020-10-02-at-9.24.10-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.24.09-PM.jpeg', 'WhatsApp-Image-2020-10-02-at-9.24.08-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.24.07-PM.jpeg', 'WhatsApp-Image-2020-10-02-at-9.24.06-PM-1.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.24.06-PM.jpeg', 'WhatsApp-Image-2020-10-02-at-9.24.05-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.24.04-PM-1.jpeg', 'WhatsApp-Image-2020-10-02-at-9.24.04-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.24.03-PM.jpeg', 'WhatsApp-Image-2020-10-02-at-9.24.02-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.24.01-PM-1.jpeg', 'WhatsApp-Image-2020-10-02-at-9.24.01-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.24.00-PM-1.jpeg', 'WhatsApp-Image-2020-10-02-at-9.24.00-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.23.59-PM-1.jpeg', 'WhatsApp-Image-2020-10-02-at-9.23.59-PM.jpeg',
    'WhatsApp-Image-2020-10-02-at-9.23.58-PM.jpeg',
  ],
  'public/images/pages/in-pictures/2019-2020': [
    'RockView.jpg', 'Camping1.jpg', 'Pot-Drink.jpg', 'Lattern.jpg', 'Camping-3.jpg', 'Toilet.jpg', 'camping4.jpeg',
    'WhatsApp-Image-2020-09-13-at-8.31.28-PM.jpeg', 'WhatsApp-Image-2020-09-19-at-12.51.06-PM.jpeg',
    'WhatsApp-Image-2020-09-05-at-1.18.06-PM.jpeg', 'WhatsApp-Image-2020-09-05-at-1.18.25-PM.jpeg',
    'WhatsApp-Image-2020-09-05-at-1.19.43-PM.jpeg', 'WhatsApp-Image-2020-09-05-at-1.19.44-PM.jpeg',
    'WhatsApp-Image-2020-09-13-at-8.30.30-PM.jpeg', 'WhatsApp-Image-2020-09-10-at-12.39.00-PM.jpeg',
    'WhatsApp-Image-2020-09-13-at-8.36.04-PM.jpeg', 'WhatsApp-Image-2020-09-13-at-8.36.03-PM.jpeg',
    'WhatsApp-Image-2020-09-13-at-8.36.46-PM.jpeg', 'WhatsApp-Image-2020-09-13-at-8.54.44-PM.jpeg',
    'WhatsApp-Image-2020-09-30-at-6.27.58-AM.jpeg', 'WhatsApp-Image-2020-09-30-at-1.18.48-PM.jpeg',
  ],
  'public/images/pages/in-pictures/2017-02': [
    '70CF3E2E-A663-4053-B3C8-6D98489864F7.jpeg', 'E948A51E-7CBC-4AB4-937F-E4784603EFE8.jpeg',
    'B2B78757-F632-4BC8-A43D-BEDE5B93892A.jpeg', '22EF164E-A710-48C9-997A-ED099B766509.jpeg',
    'F7E13DC2-E62C-445F-9603-55B66D6EA755.jpeg', '2346B3AF-4BE0-4DD4-85CD-B41BE47866BE.jpeg',
    'FCD2F4EB-8BFA-4FDE-8866-EF80CB777925.jpeg', 'FDD116F5-9069-46E8-B4CF-5CA940FC048F.jpeg',
    'FB529F9C-32A7-4B0E-A91B-C32D82749E9C.jpeg', '7C8D8B9E-A649-4329-A057-7BE30973CCF7.jpeg',
    'D7C1EF76-C696-45AA-9ED2-9F2E5428C307.jpeg', '91276B69-4F9C-4B02-94B1-87B99B273CC3.jpeg',
    'DF81232C-E1B7-423E-AD5A-F159F53776B1.jpeg', '7D9DCE2D-9E87-4EF9-9B1A-904BA9E89161.jpeg',
    'A1B3DC5A-5E6A-4403-8F7E-B4CD67182532.jpeg', 'A6F41A5F-7CA6-4AD8-9E8C-8C5635FFE243.jpeg',
    '150B6B5A-000C-4867-A816-7A43C6284671.jpeg', '91BCB49A-1BEE-43BA-B4F4-C72AFF09410B.jpeg',
    '482C631C-915A-4511-8A03-0D6926276864.jpeg', 'B9F6AD56-1AC7-4F51-ABAB-FB316E8E1BC7.jpeg',
    'DEE47F45-1358-4FC4-8509-6C9A397CF3BD.jpeg', '1D809BFE-6172-43D1-B34A-7225F6192822.jpeg',
    '3684B3AE-11EB-4082-ADDD-1D5F65C02E5C.jpeg', '1A125A90-2153-415F-A736-37A3F544816E.jpeg',
    'C6063E9E-93E3-4240-9C80-431E0A639956.jpeg', 'DBCB9803-8AF8-4CAA-BCA0-5CA1E32F882A.jpeg',
    '4B0831B8-5ADD-4E49-934D-539290BC3AB1.jpeg', '198FC6FF-CAF9-43D7-B25E-0E0F40C9F059.jpeg',
    '8F4BAA09-7B37-4F2F-B673-C515052FD477.jpeg', '69DFEAE6-2D5C-44D6-9F35-AD3F15E8BF7B.jpeg',
    'CB0F2C57-98D7-4B17-A02C-DCEFAE8DA58A.jpeg', '536E6767-BCCA-4A7C-AA16-6C943675F7FB.jpeg',
    'ED503CCC-1AF8-4A1A-A268-1A833E4CDF20.jpeg', '40D54E95-EE7F-46B2-9213-4922F3DE2F29.jpeg',
    'BC2EA8D7-1C47-4A82-ABAD-85D1486650D9.jpeg', '66926229-6F08-494E-90EA-31245C04DDF8.jpeg',
    '640D7047-F68C-4257-ACAF-26843F77E7A0.jpeg', '75E544E2-5064-4B96-8969-1D89F6F7660D.jpeg',
    'FF54689A-4639-49FF-95CD-A0837574E398.jpeg', '3BB07B7E-62DE-42BC-8305-328B5268B200.jpeg',
    '08324A92-FD71-48B9-8CE4-DB1ACEDFE7EE.jpeg', 'AEBC2FD3-C12B-4D9E-BCE4-E834F9D746F1.jpeg',
    '1953D117-7A61-4CCE-946D-7044968228A0.jpeg', '194C8FD0-7F6B-4577-918A-FAE2A5F527BF.jpeg',
    'CDDF6A2F-B78B-4198-995C-066BF8235039.jpeg', 'BBFFA16C-9CDA-4027-A847-9B59FC4AE359.jpeg',
    '0644E35B-70C7-4000-90E3-3EB64D924471.jpeg', '106162B2-DB12-46B8-ADA6-6BC8F0E68C79.jpeg',
    'A82E401B-16D8-467A-B671-1812C3443CB8.jpeg', 'B60749DE-F96F-43FB-88FC-D4B4D5FBD7AB.jpeg',
    'C87BDC0C-2C0A-4B4A-B69D-E319A87CE55E.jpeg', 'FFABD6BF-0F06-4885-95DF-44D50A3FA92C.jpeg',
    '08925DA8-B953-46AC-80F8-78EA20F785BC.jpeg', '605CC0A3-C006-4874-ADA9-764753FB3B58.jpeg',
    '815D53E3-E401-43D6-A90C-211C579135E2.jpeg', 'DDB5B727-F5F4-4C1F-A53C-AC701B644354.jpeg',
    'C221B090-5563-4201-B9CE-644FDC35A65A.jpeg', 'B4E7DFFC-0E12-4892-A78E-98E16695C44A.jpeg',
    '1D6EDB6F-A695-423A-989A-47C9F4845A50.jpeg', 'A58AFF9C-180D-4136-8C6D-26A1189890DC.jpeg',
  ],
};

async function main() {
  await mkdir(contentDir, { recursive: true });
  let count = 0;

  for (const bucket of BUCKETS) {
    const files = FILES[bucket.dir];
    // Stagger takenAt by a second per photo within the bucket so the sort
    // order (and any future day-level filtering) matches the original
    // array order instead of every photo in a bucket colliding on one instant.
    for (const [i, file] of files.entries()) {
      const publicPath = `/${path.relative(publicDir, path.join(root, bucket.dir, file)).split(path.sep).join('/')}`;
      const absPath = path.join(root, bucket.dir, file);

      let width, height;
      try {
        const metadata = await sharp(absPath).metadata();
        width = metadata.width;
        height = metadata.height;
      } catch {
        // Non-fatal - width/height are optional in the schema.
      }

      const takenAt = new Date(`${bucket.takenAt}T00:00:00Z`);
      takenAt.setUTCSeconds(takenAt.getUTCSeconds() + (files.length - i));

      const slug = `${bucket.takenAt}-${file.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)}`;
      const lines = [`src: "${publicPath}"`, `caption: "${bucket.caption}"`, `takenAt: ${takenAt.toISOString()}`];
      if (width) lines.push(`width: ${width}`);
      if (height) lines.push(`height: ${height}`);

      await writeFile(path.join(contentDir, `${slug}.md`), `---\n${lines.join('\n')}\n---\n`);
      count++;
    }
  }

  console.log(`Wrote ${count} legacy photo entries to ${path.relative(root, contentDir)}/`);
}

main();
