// Domain-expiry lookups shared by scripts/check-domain-expiry.mjs (the daily
// GitHub Action that emails core-team@tvc.farm) and netlify/functions/
// usage-admin.mts (the usage dashboard's domains card). Kept free of any
// "run when invoked directly" entry point on purpose: this file is bundled
// into a Netlify Function, where such a check could fire unexpectedly.
//
// Expiry comes from the domain registry's own public RDAP service (the
// machine-readable successor to WHOIS): no account, no API key and nothing
// secret about it, and it reports the same date whichever registrar the
// domain sits at. The registry endpoint is found through IANA's RDAP
// bootstrap file, with rdap.org (a public redirector for the same data) as a
// fallback for TLDs the bootstrap file doesn't list.

export const DEFAULT_DOMAINS = ['tvc.farm', 'syntropic.in'];
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

async function getJson(url, timeoutMs) {
  const res = await fetch(url, { headers: { accept: 'application/rdap+json, application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// timeoutMs applies to each request; the daily Action is happy to wait, the
// usage dashboard (a request someone is waiting on) passes a shorter one.
export async function lookupDomain(domain, { timeoutMs = 20_000 } = {}) {
  let rdapUrl = null;
  try {
    const base = rdapBaseFromBootstrap(await getJson(IANA_BOOTSTRAP, timeoutMs), domain);
    if (base) rdapUrl = `${base}domain/${domain}`;
  } catch (err) {
    console.warn(`[domain-expiry] IANA bootstrap lookup failed (${err.message}); trying rdap.org`);
  }
  const parsed = parseRdap(await getJson(rdapUrl ?? `https://rdap.org/domain/${domain}`, timeoutMs));
  if (!parsed.expiresAt) throw new Error(`no expiration date in the RDAP response for ${domain}`);
  return parsed;
}

