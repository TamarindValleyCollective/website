// Checks when each of TVC's domains expires and emails core-team@tvc.farm as
// renewal approaches. Run daily by .github/workflows/domain-expiry.yml; also
// runnable by hand (DRY_RUN=1 node scripts/check-domain-expiry.mjs).
//
// Expiry comes from the domain registry's own public RDAP service (the
// machine-readable successor to WHOIS): no account, no API key and nothing
// secret about it, and it reports the same date whichever registrar the
// domain sits at — so it keeps working across the tvc.farm Squarespace ->
// Cloudflare transfer. The registry endpoint is found through IANA's RDAP
// bootstrap file, with rdap.org (a public redirector for the same data) as a
// fallback for TLDs the bootstrap file doesn't list.
//
// The only secret used is RESEND_API_KEY (already a repo secret for
// member-update-email.yml), to send the email. No database credentials.
//
// Reminder cadence (stateless, so a missed day can't lose an alert): at 60
// and 30 days left, then every day from 14 days left until renewed. A lookup
// that fails also emails (and fails the run), because a monitor that goes
// quiet when it breaks is worse than none.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DOMAINS, daysUntil, lookupDomain, shouldAlert } from './lib/domain-expiry.mjs';
import { renderStaffEmail } from './lib/email-layout.mjs';

const NOTIFY_TO = ['core-team@tvc.farm'];
const FROM = 'TVC Website <noreply@tvc.farm>';

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendEmail(subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || process.env.DRY_RUN) {
    console.log(`[domain-expiry] (not sending) ${subject}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: NOTIFY_TO, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const domains = (process.env.DOMAINS ?? '').split(',').map((d) => d.trim()).filter(Boolean);
  const list = domains.length ? domains : DEFAULT_DOMAINS;
  const now = new Date();
  const results = [];

  for (const domain of list) {
    try {
      const info = await lookupDomain(domain);
      results.push({ domain, ok: true, ...info, daysLeft: daysUntil(info.expiresAt, now) });
    } catch (err) {
      results.push({ domain, ok: false, error: err.message });
    }
  }

  const lines = ['| Domain | Expires | Days left | Registrar |', '|---|---|---|---|'];
  for (const r of results) {
    lines.push(r.ok ? `| ${r.domain} | ${fmtDate(r.expiresAt)} | ${r.daysLeft} | ${r.registrar ?? 'unknown'} |` : `| ${r.domain} | LOOKUP FAILED | — | ${r.error} |`);
  }
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);

  const failed = results.filter((r) => !r.ok);
  const due = results.filter((r) => r.ok && shouldAlert(r.daysLeft));

  if (due.length || failed.length) {
    const rows = results
      .map((r) =>
        r.ok
          ? `<tr><td style="padding:6px 12px;"><strong>${escapeHtml(r.domain)}</strong></td><td style="padding:6px 12px;">${fmtDate(r.expiresAt)}</td><td style="padding:6px 12px;">${r.daysLeft <= 0 ? 'EXPIRED' : `${r.daysLeft} days`}</td><td style="padding:6px 12px;">${escapeHtml(r.registrar ?? 'unknown')}</td></tr>`
          : `<tr><td style="padding:6px 12px;"><strong>${escapeHtml(r.domain)}</strong></td><td colspan="3" style="padding:6px 12px;">Could not check: ${escapeHtml(r.error)}</td></tr>`,
      )
      .join('');
    const worst = due.length ? due.reduce((a, b) => (a.daysLeft <= b.daysLeft ? a : b)) : null;
    const subject = worst
      ? worst.daysLeft <= 0
        ? `Domain EXPIRED: ${worst.domain}`
        : `Domain renewal: ${worst.domain} expires in ${worst.daysLeft} day${worst.daysLeft === 1 ? '' : 's'}`
      : 'Domain expiry check failed';
    const html = renderStaffEmail(`<p style="margin-top:0;">${worst ? 'A TVC domain is coming up for renewal.' : 'The daily domain expiry check could not finish.'}</p>
<table style="border-collapse:collapse;"><thead><tr style="text-align:left; font-size:13px; color:#57604f;"><th style="padding:6px 12px;">Domain</th><th style="padding:6px 12px;">Expires</th><th style="padding:6px 12px;">Left</th><th style="padding:6px 12px;">Registrar</th></tr></thead><tbody>${rows}</tbody></table>
<p style="font-size:13px; color:#57604f;">Renew at the registrar shown. See DOMAINS.md in the website repo for where each domain lives. This is sent at 60 and 30 days, then daily from 14 days until the expiry date moves.</p>`);
    await sendEmail(subject, html);
  }

  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
