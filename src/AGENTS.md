## Design language

`src/styles/global.css` is the single source of truth for TVC's design tokens; the design-system
artifact is a derived copy, so if the two disagree `global.css` wins. In any `.astro` or `.css` file:

- Use a `--tvc-*` color token, never a raw hex. Add a token to `global.css` first if one is missing.
- Never reference a custom property that `global.css` doesn't define (CI fails on this).
- Orange has three jobs: `--tvc-orange-cta` fills the primary `.button` only; `--tvc-orange` is for
  non-text marks; small orange text uses `--tvc-orange-text`, and orange on dark green uses
  `--tvc-orange-light`. Never white text on `--tvc-orange-cta`.
- The admin shell (`StaffLayout.astro`) and member portal (`members/index.astro`) have their own look and
  shared primitives; read `docs/design-language.md` before touching `.astro`/`.css` there, and don't
  restyle shared primitives per page.

`npm run lint:css` checks this (Stylelint) and the `Design language` GitHub Action runs it on every PR.
Update `docs/design-language.md` (and this section, plus the pointer in the root `CLAUDE.md`, if the
core rules change) in the same change.
