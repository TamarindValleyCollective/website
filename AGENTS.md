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

## Usage & limits documentation

`USAGE.md` documents the free-tier / credit usage dashboard (`/internal/usage`) and its alert
emails — what is measured vs typed in, the thresholds, the setup steps, and how to add a meter.
**Update it in the same change** whenever that changes — a new service tracked, a changed
threshold, a new typed-in meter, a new alert rule.

## Terminology: admin and staff

"Admin" is anyone who runs the internal tools under `/internal`: the core team (community members), plus
Madhavan's admin functions. "Staff" means the people TVC employs on the farm ("local staff", "farm staff"),
and "Linger staff" at the stay partner. Never call a tool user, queue or screen "staff": it is the admin queue,
admin register, admin shell, admin alert. Existing identifiers keep their names (`StaffLayout`, `requireStaff`,
`staff_users`, `staff_audit_log`, `/api/staff-*`, `staff.*` audit actions, `WHATSAPP_STAFF_ALERT_NUMBERS`, the
`tvc_*staff*` Meta template names, `needsStaff`); renaming those needs a migration and a real reason, not a
wording pass. Migration comments and the change log are history and are left as written.

## Design language

`src/styles/global.css` is the single source of truth for TVC's design tokens (colors, type,
spacing, radii, shadows); the design-system artifact is a derived reference copy, so if the two
disagree `global.css` wins. In any `.astro` or `.css` file:

- Use a `--tvc-*` color token, never a raw hex. Add a token to `global.css` first if one is missing.
- Never reference a custom property that `global.css` doesn't define (CI fails on this).
- Orange has three jobs: `--tvc-orange-cta` fills the primary `.button` only; `--tvc-orange` is for
  non-text marks (focus rings, underlines, hover); small orange text uses `--tvc-orange-text`, and
  orange on dark green uses `--tvc-orange-light`. Never white text on `--tvc-orange-cta`.
- Inside the admin shell (`StaffLayout.astro`) `.button` is a compact 36px dark-green control, not the
  public orange pill; don't restyle buttons per page, add a modifier class only when a page needs a
  different colour.
- Use `--radius` (14px, cards), `--radius-sm` (8px), `--radius-field` (10px) and `--shadow-soft`
  rather than literals.
- Fonts: headings use `--font-display`, everything else `--font-body`; `--font-wordmark` is only
  for the nav/footer lockup, and the `--font-3bs1h-*` faces only inside the 3Bs&1H series.
- Member portal (`members/index.astro`) wears the admin portal's look: both shells import
  `src/styles/portal-look.css` (the neutral tokens, the system type face and the dark appearance), so
  `--font-display` is the system face there and a token change lands in both. The shell matches
  `StaffLayout` (frosted sidebar, solid-green current item, compact 36px `.btn`, border-only cards, an
  Auto/Light/Dark control in the account menu). Type: sizes come from the `--text-*` scale (nothing
  smaller than 0.8rem; text people read (contact lines, hints, captions, table headers, filter labels) is
  `--text-sm`, and `--text-xs` is for pills, badges and uppercase labels); the page title is 2.125rem 700 like the admin `h1`; section and dialog titles
  lg / xl; subheads weight 600; small uppercase labels only for non-heading labels, tracking 0.08em.
  Sentence case everywhere else (never uppercase an email). Every dialog on the member page goes through
  `presentSheet(dlg)` (a card that grows from its trigger; a swipe-down bottom sheet on phones; `locked` for
  one that must be read) and calls `dlg.close()` as usual: the presenter wraps `close` to play the exit.
  Never `append` + `showModal` a dialog directly. On phones (560px and below) the main navigation is a bottom tab bar (`#tabbar`, filled by `renderNav`); fixed-bottom things (toast, story bar, `#view` padding) offset by `--tabbar-h`. A phone-only override placed before its base rule in the file loses to it; raise its specificity.
- Admin portal (`StaffLayout.astro`, `src/pages/internal/*`): the shell owns the shared primitives (`.card`,
  `.hint`, `.note`, `.error`, `.section.wrapper`, `[hidden]`, `.visually-hidden`, `.link-button`, and the button
  modifiers `--outline`, `--primary`, `--danger`, `--danger-outline`, `--small`) and the building blocks of the
  Apple-style layout: `.field` (search), `.segmented` (one choice from a few), `.list` with `.row` (a grouped list;
  `a.row` and `button.row` are tappable), `.pill` (`--ok`, `--warn`, `--crit`), `.sheet` (a modal `<dialog>`),
  `.toast` via `showToast(message, undo?)` in `staff-client.mjs`, and `.crit-row` (a destructive action as plain red
  text in its own list). Build a new page from these rather than inventing controls. A page uses them and never
  redefines them; it may add to one (WhatsApp's `.card` sets padding and overflow) and
  `scripts/lib/admin-primitives.test.mjs` lists the few that do. Font sizes are `--text-*` tokens with
  nothing below 0.8rem (only display sizes of 1.3rem and up may be literal; Stylelint errors otherwise). A
  destructive control uses `--danger` or `--danger-outline`, never the primary fill, and a reversible action
  (deactivate someone) happens at once with an Undo toast instead of a `confirm()` box; only irreversible money gets
  an alert. The admin's look follows the Apple-style concept: calm cool neutrals and the system type face (SF Pro on
  Apple devices, Inter elsewhere) set as token overrides on admin pages only (the `html:root` block in
  `StaffLayout.astro`), not the public site's warm tokens or Fraunces. The admin also has a
  dark appearance (same file, tokens only) that follows the device or the account menu's Appearance choice; keep it
  working by using `--tvc-*` tokens for every colour in admin files (a raw colour will not turn dark; mix tokens with
  `color-mix` when you need an in-between shade) and check a new page in Dark as well as Light.

`npm run lint:css` checks this (Stylelint); the `Design language` GitHub Action runs it on every
PR. Raw hex colors are errors (CI fails); radius literals are warnings for now. Admin font sizes outside the scale are errors. A color that genuinely isn't a TVC color (a third-party brand, a data
color) gets a `/* stylelint-disable-next-line color-no-hex -- reason */` comment above it. Update this section in the same change if the rules change.

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

Always render changes in the dev server and verify them with the user before closing it.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
