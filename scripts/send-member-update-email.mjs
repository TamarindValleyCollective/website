#!/usr/bin/env node
// Notifies members@tvc.farm (BCC'ing each updated member's own email - not
// CC, so members can't see each other's addresses) whenever a push to main
// changes src/data/members.ts - see
// scripts/check-member-story-responses.mjs for the human-run half of this
// process; this script is the automated half, wired into
// .github/workflows/member-update-email.yml on every push to main that
// touches that file.
//
// Diffs the file's *previous* committed version (GITHUB_EVENT_BEFORE, i.e.
// github.event.before from the workflow, falling back to HEAD~1 for local
// testing) against the current one, one line at a time - every member is a
// single-line object literal in this file, so a changed line is a changed
// member; no TS/AST parsing needed, just line-level regex extraction.
//
// A card counts as "new" if its previous line had no `whyTVC` field (the
// one question unique to the "TVC Members: Your Story" form - see
// check-member-story-responses.mjs's own note on this), "updated" if it
// already did. Same heuristic used for the site-wide "X of Y members have
// shared their story" progress stat.
//
// Requires RESEND_API_KEY (Resend dashboard -> API keys) and the existing
// GDRIVE_SERVICE_ACCOUNT_EMAIL/_PRIVATE_KEY (same tvc-photo-pool service
// account used elsewhere, added as GitHub Actions secrets 2026-08-19 so
// this script can look up each changed member's own email from the
// response Sheet to BCC them) as environment variables - see
// .github/workflows/member-update-email.yml.
//
// Usage: node scripts/send-member-update-email.mjs [--dry-run]

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSheetValues } from './lib/google-drive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const envPath = path.join(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const dryRun = process.argv.includes('--dry-run');

const MEMBERS_FILE = 'src/data/members.ts';
const SPREADSHEET_ID = '1rjl8AewOrHCD09_ffK3X6toq79mXvBu0rRkM2POEvKo';
const SHEET_NAME = 'Form responses 1';
const SHEET_RANGE = `'${SHEET_NAME}'!A:L`;
const SITE_URL = 'https://tvc.farm';
const FROM = 'TVC Website <noreply@tvc.farm>';
// TEST_SEND_TO (set via the workflow's manual "test_recipient" input, or
// locally) reroutes a real send to one inbox instead of members@tvc.farm +
// BCCs - lets a real Resend send be verified end-to-end without emailing
// actual members. Diffing/classification logic runs unchanged either way.
const testRecipient = process.env.TEST_SEND_TO;
const TO = testRecipient ? [testRecipient] : ['members@tvc.farm'];

// --- 1. Diff members.ts between the previous and current commit ---------

function fileAtRef(ref) {
  try {
    execSync(`git rev-parse --verify ${ref}^{commit}`, { cwd: root, stdio: 'ignore' });
  } catch {
    // Fails loudly rather than silently treating an unresolvable ref as "no
    // file yet" (empty content) - that fallback used to also swallow a
    // too-shallow checkout, which made every current member look "new"
    // against a phantom empty history. Caught in the first live test run
    // (2026-08-19): a manually-dispatched compare_ref outside the
    // checkout's fetch-depth silently produced a 53-member "everything is
    // new" email instead of erroring - harmless there since it only went to
    // a --dry-run/test recipient, but would have gone to every real member
    // otherwise.
    throw new Error(`Ref '${ref}' not found in this checkout - fetch-depth too shallow? (git rev-parse failed)`);
  }
  try {
    return execSync(`git show ${ref}:${MEMBERS_FILE}`, { cwd: root, encoding: 'utf8' });
  } catch {
    return ''; // ref exists but predates this file (e.g. the very first commit) - legitimately empty
  }
}

// name -> { line, hasWhyTVC, photo }
function parseMemberLines(content) {
  const map = new Map();
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{ name:')) continue;
    const name = line.match(/name: '([^']+)'/)?.[1];
    if (!name) continue;
    map.set(name, {
      line,
      hasWhyTVC: /whyTVC:/.test(line),
      photo: line.match(/photo: '([^']+)'/)?.[1] ?? null,
    });
  }
  return map;
}

const prevRef = process.env.GITHUB_EVENT_BEFORE || execSync('git rev-parse HEAD~1', { cwd: root, encoding: 'utf8' }).trim();
const prevMembers = parseMemberLines(fileAtRef(prevRef));
const currMembers = parseMemberLines(fileAtRef('HEAD'));

const changed = [];
for (const [name, curr] of currMembers) {
  const prev = prevMembers.get(name);
  if (prev && prev.line === curr.line) continue; // untouched
  changed.push({
    name,
    photo: curr.photo,
    kind: prev?.hasWhyTVC ? 'updated' : 'new',
  });
}

const totalMembers = currMembers.size;
const membersWithStory = [...currMembers.values()].filter((m) => m.hasWhyTVC).length;

if (changed.length === 0) {
  console.log('No member cards changed between', prevRef, 'and HEAD - nothing to send.');
  process.exit(0);
}

console.log(`${changed.length} member card(s) changed:`, changed.map((c) => `${c.name} (${c.kind})`).join(', '));

// --- 2. Look up each changed member's own email(s) from the response Sheet -

async function lookupEmails(names) {
  const grid = await getSheetValues(SPREADSHEET_ID, SHEET_RANGE);
  const [header, ...rows] = grid;
  const nameCol = header.indexOf('Name');
  const emailCol = header.indexOf('Email address');
  const consentCol = header.indexOf('OK to publish your name, photo, quote, and link on the public TVC website?');
  const byName = new Map(names.map((n) => [n, new Set()]));
  for (const row of rows) {
    const name = row[nameCol];
    if (!byName.has(name)) continue;
    if (row[consentCol] !== 'Yes') continue;
    const email = row[emailCol];
    if (email) byName.get(name).add(email);
  }
  return byName;
}

const emailsByName = await lookupEmails(changed.map((c) => c.name));
// BCC, not CC - each changed member's own address shouldn't be visible to
// the rest of the members@tvc.farm list or to each other.
const bccEmails = testRecipient ? [] : [...new Set(changed.flatMap((c) => [...(emailsByName.get(c.name) ?? [])]))];

// --- 3. Build the email --------------------------------------------------

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function memberSlug(name) {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Table-based layout with every style attribute inlined, deliberately not
// the div+flexbox+<style>-block approach the browser-preview mockup used -
// that rendered fine in a browser tab but broke in a real inbox (caught via
// the first test send's raw .eml, 2026-08-19): Outlook's rendering engine
// doesn't support flexbox or border-radius at all, and several clients
// (Outlook, some Gmail surfaces) strip a <style> block in <head> entirely,
// dropping every class-based rule with it. Tables + inline styles are the
// only layout method that survives across all of them - see
// https://www.caniemail.com if a future edit wants to reach for anything
// fancier than what's used here.
const FONT_BODY = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_DISPLAY = "Georgia,'Times New Roman',serif";

const cardsHtml = changed
  .map(({ name, photo, kind }) => {
    const safeName = escapeHtml(name);
    const tagBg = kind === 'new' ? '#e8f2ea' : '#f78520';
    const tagColor = kind === 'new' ? '#294a36' : '#ffffff';
    const tagLabel = kind === 'new' ? 'New profile' : 'Updated';
    const blurb = kind === 'new' ? 'Shared their story for the first time.' : 'Updated their story.';
    const photoUrl = photo ? `${SITE_URL}${photo}` : `${SITE_URL}/images/members/placeholder.jpg`;
    const link = `${SITE_URL}/people/members#${memberSlug(name)}`;
    return `
        <tr>
          <td style="padding:0 32px 30px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="64" valign="top" style="width:64px; padding-right:18px;">
                  <img src="${photoUrl}" width="64" height="64" alt="${safeName}" style="display:block; width:64px; height:64px; border-radius:50%; border:1px solid #e2ddc9; object-fit:cover;" />
                </td>
                <td valign="top">
                  <span style="display:inline-block; font-family:${FONT_BODY}; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; padding:4px 10px; border-radius:100px; margin-bottom:10px; background:${tagBg}; color:${tagColor};">${tagLabel}</span>
                  <h2 style="font-family:${FONT_DISPLAY}; font-weight:600; font-size:19px; margin:6px 0; color:#22291f;">${safeName}</h2>
                  <p style="margin:0 0 12px 0; font-family:${FONT_BODY}; font-size:14px; line-height:1.5; color:#57604f;">${blurb}</p>
                  <a href="${link}" style="font-family:${FONT_BODY}; font-size:14px; font-weight:700; color:#3d6e52; text-decoration:none; border-bottom:1px solid #3d6e52;">View their card on tvc.farm &rarr;</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
  })
  .join('\n');

const pct = Math.round((membersWithStory / totalMembers) * 100);

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0; padding:0; background:#eee9db;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eee9db;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:100%; background:#faf7ee;">
          <tr>
            <td style="background:#294a36; padding:28px 32px 24px 32px;">
              <div style="font-family:${FONT_DISPLAY}; font-weight:700; font-size:20px; color:#ffffff;">Tamarind Valley Collective</div>
              <div style="font-family:${FONT_BODY}; margin-top:6px; color:#bcd2c2; font-size:13px;">Member directory update</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 8px 32px;">
              <h1 style="font-family:${FONT_DISPLAY}; font-weight:600; font-size:25px; line-height:1.3; margin:0 0 14px 0; color:#294a36;">${changed.length} member profile${changed.length === 1 ? '' : 's'} updated</h1>
              <p style="margin:0 0 6px 0; font-family:${FONT_BODY}; font-size:15px; line-height:1.6; color:#57604f;">Here's what changed on the <a href="${SITE_URL}/people/members" style="color:#3d6e52; font-weight:600;">Members page</a>. Click through to see any card in full.</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px; background:#e8f2ea; border-radius:10px;">
                <tr>
                  <td style="padding:16px 18px 16px 18px;">
                    <span style="font-family:${FONT_DISPLAY}; font-weight:700; font-size:26px; color:#294a36;">${membersWithStory}</span>
                    <span style="font-family:${FONT_BODY}; font-size:13.5px; font-weight:600; color:#294a36;"> of ${totalMembers} members</span>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:9px;">
                      <tr>
                        <td width="${pct}%" style="background:#3d6e52; height:6px; font-size:6px; line-height:6px;">&nbsp;</td>
                        <td style="background:#cfe0d4; height:6px; font-size:6px; line-height:6px;">&nbsp;</td>
                      </tr>
                    </table>
                    <p style="margin:10px 0 0 0; font-family:${FONT_BODY}; font-size:13px; line-height:1.55; color:#57604f;">have updated their profile with the new "Your Story" form so far &mdash; the rest still show their original, shorter bio. Haven't told yours yet? <a href="${SITE_URL}/people/members/story-guide" style="color:#3d6e52; font-weight:600;">Fill out the form &rarr;</a></p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 32px;">
              <div style="border-top:1px solid #e2ddc9; font-size:1px; line-height:1px;">&nbsp;</div>
            </td>
          </tr>
${cardsHtml}
          <tr>
            <td style="padding:26px 32px 34px 32px; border-top:1px solid #e2ddc9; font-family:${FONT_BODY}; font-size:12.5px; line-height:1.7; color:#57604f;">
              <div style="font-family:${FONT_DISPLAY}; font-style:italic; color:#294a36; font-size:14px; margin-bottom:10px;">&mdash; The TVC website</div>
              Sent because you're a TVC member with a profile on tvc.farm. Spot something to fix in your own card? Reply to this email or resubmit the <a href="${SITE_URL}/people/members/story-guide" style="color:#57604f;">Members: Your Story</a> form.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

const subjectBase = `${changed.length} member profile${changed.length === 1 ? '' : 's'} updated on tvc.farm`;
const subject = testRecipient ? `[TEST] ${subjectBase}` : subjectBase;

// --- 4. Send via Resend ----------------------------------------------------

if (dryRun) {
  if (process.env.DRY_RUN_HTML_OUT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.DRY_RUN_HTML_OUT, html);
  }
  console.log('--dry-run: not sending. Subject:', subject);
  console.log('To:', TO, 'Bcc:', bccEmails);
  process.exit(0);
}

const payload = { from: FROM, to: TO, subject, html };
if (bccEmails.length > 0) payload.bcc = bccEmails;

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
}

const result = await res.json();
console.log('Sent:', result.id, '- to', TO, 'bcc', bccEmails);
