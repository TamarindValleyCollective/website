# Design language

Moved from the root `CLAUDE.md`, which keeps the CI-enforced core. Update this file in the same change
whenever the rules change.

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
  Forms in dialogs follow one pattern (set in `dialog.modal`): a bold `.field-label` above a 44px field, a quiet `.field-help` line below it, focus shown as an orange border with a soft halo, the error line (`.form-msg`) taking no room until it has text, and `.modal-actions` as a footer under a hairline. Never `append` + `showModal` a dialog directly. On phones (560px and below) the main navigation is a bottom tab bar (`#tabbar`, filled by `renderNav`); fixed-bottom things (toast, story bar, `#view` padding) offset by `--tabbar-h`. A phone-only override placed before its base rule in the file loses to it; raise its specificity.
- Admin navigation is by blocks (Operations, Community, Finance, Settings), defined once in `scripts/lib/admin-nav.mjs`: a
  new page is one line there, and the test fails if a registered tool has no page. A page that is one of several in a block
  passes `currentPage` to `StaffLayout`. On phones the rail is a bottom tab bar (`--tabbar-h`: anything fixed to the bottom keeps
  clear of it) and a block's pages are a row of tabs. Never call the sections "tools" in user-facing copy.
- A page that loads data says what happened and what to do: use `scripts/lib/staff-states.mjs` (`showLoading`, `showFailure` with a
  Try again button, `showEmpty` with its next step) in a polite live region, never a bare grey line. Anything the script builds at
  run time needs `:global()` styles, since Astro's scoped CSS never reaches it.
- Admin portal (`StaffLayout.astro`, `src/pages/internal/*`): the shell owns the shared primitives (`.card`,
  `.hint`, `.note`, `.error`, `.section.wrapper`, `[hidden]`, `.visually-hidden`, `.link-button`, and the button
  modifiers `--outline`, `--primary`, `--danger`, `--danger-outline`, `--small`) and the building blocks of the
  Apple-style layout: `.field` (search), `.segmented` (one choice from a few), `.list` with `.row` (a grouped list;
  `a.row` and `button.row` are tappable), `.pill` (`--ok`, `--warn`, `--crit`), `.sheet` (a modal `<dialog>`),
  `.toast` via `showToast(message, undo?)` in `staff-client.mjs`, and `.crit-row` (a destructive action as plain red
  text in its own list). A short form in a card is `.inline-form` (fields and the button in one wrapping row) and a longer one is `.stack-form` (one column, or a page's own grid): both give labels above fields, 36px fields (44px on touch), strong borders and focus as a border and halo. Their field rules carry no specificity, so a page may make one field denser but never redefines borders, focus or labels; the gate (`SignInGate`) starts hidden and each page shows it only when nobody is signed in. Build a new page from these rather than inventing controls. A page uses them and never
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

