# Fingerprints

Every site you build with **scroll-craft** gets one row here, appended after it
ships. The registry exists so your next build can prove it is a different page
rather than a re-skin of one you already made.

This file is **yours**. It starts empty on purpose: the gate is about not
repeating *yourself*, so it has nothing to say until you have built something.

The rules and the gate live in the skill's
`references/uniqueness.md`. Short version:

**A new build must differ from EVERY row below on at least 4 of the 6
dimensions.** Four against each row individually, not four on average across the
table. If a planned build fails, change the plan. Never edit a row to make room
for it.

The six dimensions are: **grammar**, **nav treatment**, **hero device**,
**act-sequence shape**, **close pattern**, **signature move**.

Dimension 6 is free, because a signature move is unique by definition. So the
gate really asks for three more out of the remaining five, and a build that
changes only grammar and world will fail it.

---

## The registry

| Build | Grammar | Nav treatment | Hero device | Act-sequence shape | Close pattern | Signature move | World | Port |
|---|---|---|---|---|---|---|---|---|
| our-journey | Chaptered editorial | Fixed margin folio (year+title, updates on chapter change) | Title page: type on paper, no media, plain greet-and-hold cue | 8 acts, ~12.6vh: flow(kinetic-free hero) > flow(reveal) > flow(parallax) > pan(5-item rail) > flow(kinetic, dark ground) > flow(count) > flow(reveal, peak, largest span) > flow(colophon) | Colophon: small type, CTA as a line of running text, no button | "The skyline mends itself": TVC's own real per-year monoline icons accrete onto a fixed margin line; two real setback-to-recovery transitions render as a cracked icon that fills solid + gets a stitch mark the instant the next chapter lands | Photographic (real farm photography, no generation) | Static HTML/CSS/JS, no framework |

*(First build in this workspace: registry was empty, gate trivially cleared.)*

---

## What is taken

Add a bullet here whenever a build claims something a later build should avoid
reusing: a grammar, a nav treatment, a close pattern, a signature move, an
act-count-and-length band. The shared columns are what the next build inherits
as a constraint, so writing them down is the whole point.

- **our-journey** claims: chaptered editorial as a grammar, a fixed-margin
  folio built from a client's own real per-year iconography (rather than a
  generic mark or number), a crack-then-mend signature move keyed to real
  narrative setbacks, and a colophon close with the CTA set as running text
  (no button). A later build should not repeat the "real iconography accretes
  onto a fixed margin line" device unless it earns a genuinely different
  narrative use for it.

---

## Appending a row

After shipping, add one line to the table and one bullet to **What is taken** if
the build claimed something new. Fill every column. Say what the build shares
with existing rows.

Rows are append-only. A build that has been superseded stays in the table,
because the space it occupies is still occupied.

---

## Worked example

The skill's author kept a registry of twelve builds across eight page grammars.
If you want to see what a filled-in table looks like, and which shapes tend to
collide, read `EXAMPLES.md` in the scroll-craft repository. Treat it as
illustration only: those rows are somebody else's builds and they do **not**
constrain yours.
