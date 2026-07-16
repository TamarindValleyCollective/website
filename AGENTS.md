## Architecture documentation

`ARCHITECTURE.md` documents the site's current architecture (hosting, data flow, external
services, serverless functions) with a Mermaid diagram. **Update it in the same change**
whenever something affects that picture — a new integration, a new function, a hosting
change, a new external service call, etc. Don't let it drift from what's actually in the repo.

## Change log

`CHANGELOG.md` tracks every website change requested through and made by the assistant.
**Add an entry in the same change** whenever a change discussed in a conversation is committed
and pushed to `main` — new entries go at the top, with: date/time (from the commit), who
requested it, a short summary of the ask (quote the user's request where practical), a summary
of what actually changed, and the commit hash(es). Skip entries for changes that were never
pushed (e.g. pure evaluation/advice, or work explicitly not committed).

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
