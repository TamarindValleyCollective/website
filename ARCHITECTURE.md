# Website Architecture

> **Keep this file up to date.** Whenever a change affects hosting, data flow, external
> services, or how a page/feature is served (new integration, new serverless function, moving
> off Netlify, etc.), update the diagram and the relevant section below in the same change.
> See the note in `AGENTS.md`.

## Overview

The site is an Astro rebuild of the original Tamarind Valley Collective website, almost
entirely static (prerendered HTML/CSS/JS, no server at request time). There are two
deliberate exceptions that need a small serverless backend: the site-wide chat assistant and
the newsletter signup form. Both are built against **Netlify**, the intended hosting
platform — see [Current Production Status](#current-production-status) before assuming any
of this is live.

## Diagram

```mermaid
flowchart TD
    subgraph SRC["1 · Source — github.com/TamarindValleyCollective/website (main)"]
        PAGES["src/pages/*.astro<br/>File-based routes: Home, About, Visit,<br/>Events, Ecosystem, Timeline, Contact, etc."]
        COMPONENTS["src/components/<br/>Nav, Footer, PageHero, ChatWidget,<br/>JourneyTimelineStandalone, BiodiversityExplorer"]
        CONTENT["src/content/*<br/>Markdown collections: events, partners,<br/>products, community-outreach"]
        FUNC_SRC["netlify/functions/chat.mts<br/>Serverless function, calls Anthropic API server-side"]
        SCRIPT_SRC["scripts/build-chat-context.mjs<br/>Strips nav/footer from built HTML →<br/>content corpus for the chatbot"]
    end

    subgraph BUILD["2 · Build — on push to main"]
        B1["npm run build<br/>→ astro build (prerenders every page)"]
        B2["→ build-chat-context.mjs<br/>writes site-content.json (gitignored)"]
        B3["Output: dist/ (static site) + bundled function<br/>netlify.toml declares build cmd, publish dir, functions dir"]
    end

    subgraph HOST["3 · Hosting: Netlify — target platform, NOT YET LIVE"]
        CDN["Static CDN<br/>Serves dist/ — everything except<br/>the two exceptions to the right"]
        APIFN["Netlify Function: /api/chat<br/>Runs chat.mts server-side.<br/>Reads ANTHROPIC_API_KEY (env var,<br/>set in Netlify dashboard, never in repo)"]
        FORMS["Netlify Forms<br/>Build-time form detection for the<br/>/contact newsletter signup — no custom backend"]
    end

    subgraph BROWSER["4 · Visitor's Browser"]
        CHATW["ChatWidget.astro<br/>Floating widget, site logo.<br/>Calls /api/chat"]
        NEWS["Newsletter form<br/>Plain HTML POST,<br/>data-netlify=true + honeypot"]
        BIODIV["BiodiversityExplorer<br/>Fetches sightings directly from<br/>iNaturalist's public API"]
        TIMELINE["Timeline / other pages<br/>Era-based year timeline, event listings —<br/>pure static, no calls out"]
    end

    subgraph EXTERNAL["External services (called directly by the browser)"]
        INAT["iNaturalist API"]
        GMAPS["Google Maps / My Maps (iframe)"]
        YT["YouTube (iframe)"]
        GPHOTOS["Google Photos (link-out only)"]
        ANTHROPIC["Anthropic Claude API<br/>(via chat.mts only)"]
    end

    SRC --> BUILD
    BUILD --> HOST
    HOST --> BROWSER
    BIODIV -.-> INAT
    APIFN -.-> ANTHROPIC
    CHATW --> APIFN
    NEWS --> FORMS

    classDef staticStyle fill:#e8f2ea,stroke:#17723b,color:#0f5029
    classDef netlifyStyle fill:#fdead3,stroke:#f78520,color:#9a5310
    classDef externalStyle fill:#f6f1e7,stroke:#c9c2a8,color:#22291f

    class PAGES,COMPONENTS,CONTENT,CHATW,NEWS,BIODIV,TIMELINE,CDN staticStyle
    class FUNC_SRC,SCRIPT_SRC,APIFN,FORMS,ANTHROPIC netlifyStyle
    class INAT,GMAPS,YT,GPHOTOS externalStyle
```

**Legend:** 🟢 static / no server required · 🟠 depends on Netlify specifically (Functions or
Forms) · ⬜ external third-party service.

## Layer-by-layer detail

### 1. Source (GitHub)

- **`src/pages/*.astro`** — file-based routes for every page: Home, About, Visit, Events,
  Ecosystem, Timeline, Contact, and their sub-pages.
- **`src/components/`** — shared UI: Nav, Footer, PageHero, the ChatWidget, the year-by-year
  `JourneyTimelineStandalone` component, and the live `BiodiversityExplorer`.
- **`src/content/`** — Markdown content collections that change over time without touching
  code: `events`, `partners`, `products`, `community-outreach`.
- **`netlify/functions/chat.mts`** — the one serverless function, powering the chat widget.
- **`scripts/build-chat-context.mjs`** — post-build script that prepares the chat widget's
  knowledge base.

### 2. Build

On every push to `main` (once connected to hosting):

1. `astro build` — prerenders every route to static HTML into `dist/`.
2. `build-chat-context.mjs` — strips repeated Nav/Footer markup out of the built HTML and
   writes the remaining page text into a single JSON corpus (`site-content.json`, regenerated
   every build, gitignored).

`netlify.toml` declares the build command, publish directory (`dist`), and functions directory
(`netlify/functions`) so a Netlify deploy needs no manual configuration.

### 3. Hosting — Netlify (target platform)

- **Static CDN** — serves every prerendered page directly; the large majority of the site
  needs nothing more than this.
- **Netlify Function** — runs `chat.mts` server-side at `/api/chat`. Reads an
  `ANTHROPIC_API_KEY` environment variable (set in the Netlify dashboard, never committed or
  exposed to the browser) and calls the Anthropic Claude API with the site's own content as
  context, so it can only answer questions using what's actually on the website.
- **Netlify Forms** — detects the newsletter signup form at build time
  (`data-netlify="true"`) and captures submissions with no custom backend code required.

### 4. Visitor's Browser

- **ChatWidget** — floating widget using the site logo; sends the visitor's question to
  `/api/chat`.
- **Newsletter form** — plain HTML form submission with a spam honeypot field; redirects to a
  confirmation page on success.
- **BiodiversityExplorer** — fetches live biodiversity sightings directly from iNaturalist's
  public API on every page load; no TVC backend involved.
- **Timeline and other pages** — the era-based year-by-year story, event listings, and the
  rest of the site are pure static content with no external calls.
- A few pages also embed third-party content directly: Google Maps/My Maps (directions and
  farm layout), YouTube (aerial drone flyover), and a link out to a community-maintained
  Google Photos album (which can't be embedded — that service sends its own
  `X-Frame-Options: SAMEORIGIN` header).

## Current Production Status

**The public `tvc.farm` domain is not currently running this codebase.** It serves a separate,
older, Publii-based static export, hosted on infrastructure that has not yet been confirmed or
connected to this repository. None of the following are visible to the public yet:

- The site-wide AI chat assistant
- The working newsletter signup
- The interactive year-by-year timeline
- Recent content fixes (member list, link-preview images, etc.)

Deploying this rebuild requires: (1) confirming who owns/controls the hosting and DNS for
`tvc.farm`, (2) connecting that hosting — or a new Netlify project — to this GitHub repository
for continuous deployment, and (3) setting the `ANTHROPIC_API_KEY` environment variable so the
chat widget can respond. Until that happens, this document describes readiness, not reality.
