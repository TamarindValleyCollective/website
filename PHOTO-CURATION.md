# Photo curation guide

How new photos get from "someone took this at the farm" onto `/in-pictures`. Two roles are
involved — **reviewing** (anyone can do this) and **publishing** (needs a developer, since it
touches the codebase) — and they don't have to be the same person.

## 1. Adding photos to the pool

Anyone with access — staff, partners, volunteers — drops photos straight into the shared Google
Drive folder:

**[TVC Photo Pool → Inbox](https://drive.google.com/drive/folders/1qK1iV1l1WpVErSYW2kghbJKI0Qi03ZNb)**

That's it. No app, no account beyond Drive access. JPEG, PNG, and HEIC (the format iPhones use
by default) all work.

## 2. Reviewing photos

Open the review dashboard: **tvc.farm/internal/photo-pool** and sign in with your own Google
account. If you're not already on the curator list, ask whoever manages the site to add your
email — it's a one-line addition to a shared Google Sheet, no redeploy needed.

Every photo waiting in Inbox shows up as a card with:

- **A thumbnail** — may say "No preview yet" for a few minutes right after upload; Drive
  generates thumbnails in the background. Refresh later.
- **Uploaded by** — whoever's Google account added the file.
- **When it was taken** — from the photo's own metadata, not when it was uploaded.
- **Camera details and GPS** (when the photo has them) — aperture, shutter speed, ISO, focal
  length, and a link to the location on Google Maps. Screenshots, WhatsApp-forwarded images, and
  some phone exports won't have this — that's normal, not an error.
- **A description box** — write what's happening in the photo here. **This becomes the actual
  caption on the live site**, so write it the way you'd want a visitor to read it (e.g. "Kids
  planting saplings during the monsoon volunteer day", not "IMG_4021"). Click **Save** — it
  saves immediately, independent of your approve/reject decision below, so you can come back to
  a batch of descriptions before deciding on any of them.
- **Approve / Reject** — Approve queues it for publishing; Reject sets it aside. Neither is
  destructive: both just move the file into a different Drive subfolder (`Approved` or
  `Rejected`), so nothing is deleted and a decision can always be undone by dragging the file
  back to `Inbox` in Drive directly.

You don't need to decide on a description before approving — an approved photo with no
description just gets a generic placeholder caption later, which someone can rewrite by hand
before it goes live.

## 3. Publishing approved photos (developer step)

Whoever maintains the codebase runs, from the project root:

```sh
node scripts/pull-approved-photos.mjs --dry-run   # preview what's approved
node scripts/pull-approved-photos.mjs             # downloads them, moves each to "Published" in Drive
```

This downloads everything from the `Approved` Drive folder into `./drive-approved/` and carries
any saved description along as that photo's caption. Then, same as curating any other batch of
photos:

```sh
node scripts/curate-photos.mjs ./drive-approved --dry-run   # preview
node scripts/curate-photos.mjs ./drive-approved             # uploads to R2, writes content entries
```

Photos with a description from step 2 get that as their real caption. Photos approved without
one get a placeholder derived from the filename — review `src/content/photos/*.md` for those and
rewrite the caption before committing, or run `scripts/caption-photos.mjs` to have Claude draft
one from the image itself (still a draft to review, not final copy).

Commit the new `src/content/photos/*.md` files and push — they'll appear on `/in-pictures` on
the next deploy.

## Troubleshooting

- **"This Google account isn't authorized to review photos"** — your account isn't on the
  curator Sheet yet; ask an admin to add it, then use "Use a different account" (or just sign in
  again) to retry.
- **Sign-in seems to do nothing** — try again once the page has fully loaded; the sign-in button
  needs Google's script to finish loading first.
- **A photo you just approved doesn't show up when publishing** — check it actually landed in
  the `Approved` Drive folder, not still in `Inbox` (Reject also removes it from Inbox, into
  `Rejected` instead).
- **No EXIF/GPS on a phone photo** — some sharing methods (WhatsApp, some export/AirDrop paths)
  strip metadata before the file ever reaches Drive. Nothing to fix on the review side.
- **A HEIC photo fails during `curate-photos.mjs`** — should be rare (HEIC is supported), but if
  it happens, converting that one file to JPEG first and re-running is always a safe fallback.
