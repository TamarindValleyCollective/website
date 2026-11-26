## Architecture documentation

`ARCHITECTURE.md` documents the site's current architecture (hosting, data flow, external
services, serverless functions) with a Mermaid diagram. **Update it in the same change**
whenever something affects that picture — a new integration, a new function, a hosting
change, a new external service call, etc. Don't let it drift from what's actually in the repo.

## Razorpay documentation

`RAZORPAY.md` documents what we actually do with Razorpay — payment links in use, the site's
online-checkout status, and what the connected Razorpay MCP server can do on request. **Update
it in the same change** whenever that changes — a new payment link, real checkout added to the
site, new API/webhook usage, etc.

## Buffer documentation

`BUFFER.md` documents what we actually do with Buffer — connected organization/channels, posts
published or queued, and what the connected Buffer MCP server can do on request. **Update it in
the same change** whenever that changes — a new connected channel, a new campaign posted, new
API usage, etc.

## WhatsApp documentation

`WHATSAPP.md` documents what we actually do with WhatsApp — the AISensy account's status, the
decision to integrate directly against Meta's WhatsApp Cloud API instead, and the setup
checklist/progress toward that. **Update it in the same change** whenever that changes — a setup
step completed, a new webhook/template added, a new trigger wired into the site, etc.

## UPI transaction sync documentation

`UPI-SYNC.md` documents TVC's BHIM UPI transaction-tracking automation — a Google Apps Script
project, unrelated to the website itself, kept here alongside `RAZORPAY.md`/`BUFFER.md` since
that's where TVC's other operational tooling docs live. **Update it in the same change**
whenever that changes — the sync script, sheet layout, trigger cadence, or Drive folder.

## Partner API documentation

`PARTNER-API.md` documents the partner calendar API Linger's booking system calls
(`/api/partner/v1/*`): the endpoints, the operator runbook for keys and grants, what is built versus
planned (phases 0-4), and what has and has not been verified. **Update it in the same change**
whenever that changes — a new endpoint or phase, a changed limit or auth rule, a new migration, a
new partner.

## Usage & limits documentation

`USAGE.md` documents the free-tier / credit usage dashboard (`/internal/usage`) and its alert
emails — what is measured vs typed in, the thresholds, the setup steps, and how to add a meter.
**Update it in the same change** whenever that changes — a new service tracked, a changed
threshold, a new typed-in meter, a new alert rule.

## Finance module documentation

`docs/finance/` holds the design for the finance module (bank and UPI imports, ledger, payment
requests, payroll, budget and dashboards, auditor access) and the numbered session briefs it is
built from. Start at `docs/finance/README.md`. **Update the status table there, and the session's
"Done" section, in the same change** whenever a session lands, and keep `docs/finance/FINANCE.md`
(created by the first session) current. This is a public repo: no names, account numbers, UPI IDs,
salaries or amounts in finance code, tests, fixtures or docs; use invented data.

## Terminology: admin and staff

"Admin" is anyone who runs the internal tools under `/internal`: the core team (community members), plus
Madhavan's admin functions. "Staff" means the people TVC employs on the farm ("local staff", "farm staff"),
and "Linger staff" at the stay partner. Never call a tool user, queue or screen "staff": it is the admin queue,
admin register, admin shell, admin alert. Existing identifiers keep their names (`StaffLayout`, `requireStaff`,
`staff_users`, `staff_audit_log`, `/api/staff-*`, `staff.*` audit actions, `WHATSAPP_STAFF_ALERT_NUMBERS`, the
`tvc_*staff*` Meta template names, `needsStaff`); renaming those needs a migration and a real reason, not a
wording pass. Migration comments and the change log are history and are left as written.

## Design language

In any `.astro` or `.css` file: `--tvc-*` tokens only, never a raw hex. The full rules are in
`src/AGENTS.md` (also `src/CLAUDE.md`; loaded when working under `src/`) and `docs/design-language.md`.

## Change log

`CHANGELOG.md` is a short index; the actual entries live one file per month under
`CHANGELOG/YYYY-MM.md` (e.g. `CHANGELOG/2026-07.md`), newest month first, newest entry at the
top of each file. **Add an entry in the same change** whenever a change discussed in a
conversation is committed and pushed to `main` — skip entries for changes that were never
pushed (e.g. pure evaluation/advice, or work explicitly not committed).

**One line per entry**, not a table row and not a paragraph:

```
- **YYYY-MM-DD** Title (requester) — intent behind the ask in a few words, what actually
  changed. `commit-hash(es)`
```

- **Title**: short, specific, what changed (not the literal ask).
- **Requester**: first name is enough.
- **Intent**: capture *why*, condensed to a clause — never quote the user's request verbatim
  (typos, rambling, and multi-message back-and-forth included). If a whole conversation arc
  matters for context, say so in a few words, don't transcribe it.
- **What changed**: the key outcome/decision, not a step-by-step narration — enough that
  someone skimming knows what to expect if they open the diff, not a substitute for it.
- Keep it to one line. If a change genuinely needs more than that to be useful, that's a sign
  it belongs in `ARCHITECTURE.md`/`RAZORPAY.md`/a dedicated doc instead, referenced briefly here.

When a new month starts, create `CHANGELOG/YYYY-MM.md` (copy the previous month's header) and
add it to the top of `CHANGELOG.md`'s list.

## Agent skills

### Issue tracker

Issues live as GitHub Issues in TamarindValleyCollective/website (uses the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

Bare `astro dev` does not serve `/.netlify/functions/*` or the redirects to them, so any page that
calls a Netlify Function (Google sign-in, everything under `/internal`, the member portal, API
routes) silently fails or 404s there. For those pages, layer Netlify Dev on top of your Astro server
(`netlify.toml`'s `[dev]` block only proxies; it never starts Astro itself) and test on port 8888:

```
netlify dev --port 8888 --target-port <your astro port> --no-open
```

- Always pass `--target-port` of the Astro server you started; without it Netlify Dev attaches to
  whatever holds 4321, which may be another worktree's server running other code.
- Port 8888 is the only port Google sign-in works on (the OAuth client's authorized origin is
  `http://localhost:8888`). If something else holds 8888, stop it; never use another port.

Always render changes in the dev server and verify them with the user before closing it.
