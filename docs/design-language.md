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
- Finance dashboard charts (`/internal/finance/dashboard/`) take their colours from `--tvc-chart-in`, `-out`, `-balance`, `-salary`, `-farm`, `-projects`, `-company`
  (light in `global.css`, dark in `portal-look.css`), validated together for colour-blind separation. The chart markup has classes only (`bar-in`, `g-salary`, ...) and the
  page colours them; a chart has a legend, tooltips and a table view because some light steps sit below 3:1 on the card.
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
- **Amounts.** Every admin table that shows a transaction (Ledger, UPI) writes the amount one way, from `moneyNode` / `moneyText` in
  `scripts/lib/finance-ui.mjs` and the colours in `src/styles/money.css`: the sign always (`−₹13,800.00`, `+₹5,000.00`), **credits green**, a transfer between TVC's
  own accounts **blue with ⇄** (`⇄ −₹50,000.00`), and a **debit plain**, because most rows are debits and orange or red already mean "problem". Colour is
  the second cue, never the only one. A credit or a transfer also gets a 4px **stripe** down its row (the shared table's `rowKind`; the ledger's own rows);
  never a row fill, which would clash with a ticked row. A request is not a transaction, so its amount stays plain, and a matched request shows the debit
  it is linked to. A total (Paid in total, Received in total) is a sum, not a transaction: plain, under its heading. There is no separate Debit / credit column.
- Choosing from a long list, or a value that lives under other values (Maintenance › year › unit, Vendors › a vendor), uses the **linked picker**
  (`scripts/lib/linked-picker.mjs`, styles `src/styles/linked-picker.css`; read `docs/linked-picker.md`), never a native `<select>` with dozens of options. A short fixed
  list (a handful of choices) stays a `.segmented` or a plain select. `combo()` in `scripts/lib/finance-ui.mjs` is the flat-list wrapper over it. Its list opens outside any scrolling table, so
  a page does not need to give it room.

- **Data tables.** Every admin table has the Ledger's format: a search box that holds chips (its ▾ opens Filters, Group by and Favorites), sortable
  headers over a row of column filters (`^word`, `=word`, `!word`, `>1000`, `2026-10`), group bands, selected rows with a bulk bar (it sticks to the bottom of the table's own column, never fixed to the whole window, where it would slide under the admin rail; it is a green-tinted band with a green top edge, layered on the opaque card colour because the shell's tint is translucent, with Clear at the far end), and cards on a phone. Words: a row is *selected* (the checkbox) and a suggestion is *accepted* (the ✓); "tick" is not used for both. It is
  one shared component: the engine in `scripts/lib/data-table-engine.mjs` (a TanStack `table-core` instance, the same library the Ledger uses, with the Ledger's column syntax plugged in as its filter and sort; tested), the pure pieces (column matching, grouping, favorites) in `scripts/lib/data-table.mjs` (tested), DOM in `scripts/lib/data-table-ui.mjs`, styles in `src/styles/data-table.css`. A page
  describes its columns, chip filters and groupings and hands over rows; it does not restyle the table. Parties, UPI, both Requests pages and Rules (rules and categories) use it; the Ledger keeps its own
  virtualised build (it moves over only if the two start to drift apart). Columns can be `sortable: false`, `wrap: true` or `sticky: true` (a column of buttons stays in view), and a page can give a row a full-width `detail` row. A filter can name a `group`: chips of one group are alternatives (BHIM or Paytm), groups combine. A page that passes a `layoutKey` gets a **Columns** menu (the Ledger has the same one, from `scripts/lib/admin-columns-menu.mjs`, with its category and party as `required` columns that can move but not hide, and its narration and wording hidden by default via `hiddenByDefault`; no admin table builds its own): show or hide a column, move it earlier or later (buttons, so it works from the keyboard and on a phone), or reset to the default; the layout is kept per admin in this browser and applies to the wide table only (phone cards are the page's own). A `sticky` or `fixed` column (a column of buttons) is always shown and does not move; a column that is hidden drops its filter, and if it was the sort column the sort goes back to the page's default. The Dashboard and Budget are not tables and stay out of it.

- **Cell and header menus.** Every shared table has them. A **cell menu** (right-click, or a long press on a touch screen) offers Filter to this value, Filter out this value and Group by this column; it types the condition (`=Vendor`, `!=Vendor`, `=18250`) into that column's filter box, so the filter is visible and removable there, and it leaves the browser's own menu alone over a link, a button, a field or selected text. Dates have no "filter out" (the syntax has no "not this date"), and a cell with nothing to filter on shows no menu. Each **header** has a ▾ (or right-click) menu: Sort ascending, Sort descending, Group by this column, Hide column. Any plain text column can be grouped unless it says `groupable: false` (`groupable: true` allows another type, `groupValue(row)` groups on something other than what it shows); rows with no value fall in a "No ..." group that comes last. Right-click is never the only way in: the header ▾ is an ordinary button, reachable by keyboard (arrow keys, Home, End, Escape). The cell menu has no keyboard path yet; the header menu and the column filter boxes cover it. The Ledger has the same menus (`scripts/lib/admin-menu.mjs`, `styles/admin-controls.css`), wired to its own column filters and grouping, and its column search under the headings is always shown (there is no button to open it).

- **Icon buttons.** An icon replaces the words only for a familiar action repeated down a table or in a toolbar: change (pencil), choose columns, search, close. A
  primary or consequential action keeps its words: Post, Save, Accept suggestions, Add rule, Turn on or off, Approve, Reject, anything that deletes or cannot be undone. An
  icon-only button always has an `aria-label` (specific: "Change Fuel") and a tooltip (`title`), is at least 36px square (44px on a touch screen), and one icon
  means one thing everywhere. Make them with `iconButton` in `scripts/lib/admin-icons.mjs`; the icons share the sidebar's stroke style (24x24, `currentColor`, round caps).
  A row that needs more than one icon-only action groups the extras under a ⋯ menu with words. A new icon goes into `admin-icons.mjs` with a comment saying what it means; do not draw one inline in a page.

`npm run lint:css` checks this (Stylelint); the `Design language` GitHub Action runs it on every
PR. Raw hex colors are errors (CI fails); radius literals are warnings for now. Admin font sizes outside the scale are errors. A color that genuinely isn't a TVC color (a third-party brand, a data
color) gets a `/* stylelint-disable-next-line color-no-hex -- reason */` comment above it. Update this section in the same change if the rules change.

