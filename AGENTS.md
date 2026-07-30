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

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
