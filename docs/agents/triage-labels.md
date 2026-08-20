# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Avoid `good first issue`

Don't apply GitHub's built-in `good first issue` label, even to issues that are genuinely
simple. The repo is public, and that specific label is actively crawled by contribution-farming
bots and sites (e.g. goodfirstissue.dev, up-for-grabs.net) that surface it to strangers looking
to build their GitHub contribution history — it reliably attracts drive-by fork PRs from people
with no context on the project, each of which also triggers a Netlify deploy preview build. Use
`ready-for-agent` or `ready-for-human` instead to mark something as simple/actionable.
