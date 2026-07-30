# Buffer

> **Keep this file up to date.** Whenever what we actually do with Buffer changes — a new
> connected channel, a new scheduled/published post campaign, new API usage, a change to the
> connected organization, etc. — update this file in the same change. See the note in `AGENTS.md`.

## What Buffer is used for today

Buffer manages TVC's social media posting. There's no Buffer integration in the codebase — no
API keys, no webhooks, no server-side calls from `netlify/functions/`. It's a workspace the
assistant connects to on request (via Buffer's MCP server) to draft, schedule, and publish posts
on TVC's behalf; nothing about it is wired into the site itself.

**Organization:** Tamarind Valley Collective (`contact@tvc.farm` account).

**Connected channels** (3, the plan's limit):

| Channel | Service | Handle |
|---|---|---|
| Instagram | `business` | `tamarindvalleycollective` |
| Facebook | `page` | Tamarind Valley Collective |
| LinkedIn | `page` | `tvcfarm` |

**Posts published so far:** on 2026-07-30, an "our website just got a fresh new look" post was
queued to Instagram and Facebook, announcing `tvc.farm` and summarizing the site's Explore/Engage
navigation structure, using the homepage hero image
(`https://tvc.farm/images/pages/home/hero.jpg`) as the asset. Both were added to each channel's
queue (`addToQueue`), not published immediately — check Buffer for actual send times. LinkedIn
wasn't included in that round.

## What the Buffer MCP server can do

The assistant has a Buffer MCP server connected (workspace-level access, separate from the
website codebase). It's available on request for content operations — drafting/scheduling/
publishing/editing/deleting posts, browsing channels, capturing ideas, pulling post analytics,
etc. — but nothing it does happens automatically; every post requires an explicit ask, and
publishing to real channels is confirmed with the user before it goes out. Tool groups available:

| Area | Tools |
|---|---|
| Account / channels | `get_account`, `list_channels`, `get_channel` |
| Posts | `create_post`, `list_posts`, `get_post`, `edit_post`, `delete_post` |
| Ideas | `list_idea_groups`, `list_ideas`, `create_idea` |
| Analytics | `get_aggregated_post_metrics` |
| Raw GraphQL access | `introspect_schema`, `execute_query`, `execute_mutation` |

`create_post` defaults to `addToQueue` scheduling unless told otherwise, and requires an exact
channel ID from `list_channels` — never guessed.
