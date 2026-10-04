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

const DEFAULT_DOMAINS = ['tvc.farm', 'syntropic.in'];
const NOTIFY_TO = ['core-team@tvc.farm'];
const FROM = 'TVC Website <noreply@tvc.farm>';
const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- pure helpers (unit-tested) -------------------------------------------

// Pulls what we need out of an RDAP domain response. Returns
// { expiresAt: Date | null, registrar: string | null, statuses: string[] }.
export function parseRdap(json) {
  const expiryEvent = (json?.events ?? []).find((e) => e.eventAction === 'expiration');
  const expiresAt = expiryEvent?.eventDate ? new Date(expiryEvent.eventDate) : null;

  let registrar = null;
  for (const entity of json?.entities ?? []) {
    if (!(entity.roles ?? []).includes('registrar')) continue;
    const fn = (entity.vcardArray?.[1] ?? []).find((field) => field[0] === 'fn');
    registrar = fn?.[3] ?? entity.handle ?? null;
    break;
  }

  return {
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
    registrar,
    statuses: json?.status ?? [],
  };
}

// Whole days from `now` until `expiresAt` (negative once expired). Rounds
// down so "13 days 23 hours left" reads as 13, never as a comforting 14.
export function daysUntil(expiresAt, now = new Date()) {
  return Math.floor((expiresAt.getTime() - now.getTime()) / DAY_MS);
}

export function shouldAlert(daysLeft) {
  return daysLeft === 60 || daysLeft === 30 || daysLeft <= 14;
}

// Picks the RDAP base URL for a domain's TLD out of IANA's bootstrap JSON.
export function rdapBaseFromBootstrap(bootstrap, domain) {
  const tld = domain.split('.').pop().toLowerCase();
  for (const [tlds, urls] of bootstrap?.services ?? []) {
    if (tlds.includes(tld)) {
      const url = urls.find((u) => u.startsWith('https://')) ?? urls[0];
      return url.endsWith('/') ? url : `${url}/`;
    }
  }
  return null;
}

// ---- I/O ------------------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/rdap+json, application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function lookupDomain(domain) {
  let rdapUrl = null;
  try {
    const base = rdapBaseFromBootstrap(await getJson(IANA_BOOTSTRAP), domain);
    if (base) rdapUrl = `${base}domain/${domain}`;
  } catch (err) {
    console.warn(`[domain-expiry] IANA bootstrap lookup failed (${err.message}); trying rdap.org`);
  }
  const parsed = parseRdap(await getJson(rdapUrl ?? `https://rdap.org/domain/${domain}`));
  if (!parsed.expiresAt) throw new Error(`no expiration date in the RDAP response for ${domain}`);
  return parsed;
}

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
    const html = `<!doctype html><html><body style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#22291f;">
<p>${worst ? 'A TVC domain is coming up for renewal.' : 'The daily domain expiry check could not finish.'}</p>
<table style="border-collapse:collapse;"><thead><tr style="text-align:left; font-size:13px; color:#57604f;"><th style="padding:6px 12px;">Domain</th><th style="padding:6px 12px;">Expires</th><th style="padding:6px 12px;">Left</th><th style="padding:6px 12px;">Registrar</th></tr></thead><tbody>${rows}</tbody></table>
<p style="font-size:13px; color:#57604f;">Renew at the registrar shown. See DOMAINS.md in the website repo for where each domain lives. This is sent at 60 and 30 days, then daily from 14 days until the expiry date moves.</p>
</body></html>`;
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
