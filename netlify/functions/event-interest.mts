// Netlify Function (v2 API) backing the "Want this to happen again?" widget
// on past event pages (src/pages/events/[slug].astro). Tracks a public
// per-event interest count in Netlify Blobs -- the site's only publicly
// *readable* piece of server-side state; everything else is either static
// or, like chat.mts and the Netlify Forms submissions, write-only.
//
// To reset a specific event's count (e.g. once it's actually been re-run
// and the demand has been acted on) -- no code needed, just run:
//   netlify blobs:delete event-interest <event-id>
// See README.md's "Event interest" section for the fuller picture,
// including src/content.config.ts's `interestNote` field, which is the
// visitor-facing side of closing the loop (the reset above is silent on
// its own -- interestNote is what actually tells visitors it happened).
import { getStore } from '@netlify/blobs';

interface InterestRecord {
  count: number;
  emails: string[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const store = getStore('event-interest');

  if (req.method === 'GET') {
    const event = url.searchParams.get('event');
    if (!event) return jsonResponse({ error: 'event is required' }, 400);

    const record = await store.get(event, { type: 'json' }) as InterestRecord | null;
    return jsonResponse({ count: record?.count ?? 0 });
  }

  if (req.method === 'POST') {
    let payload: { event?: string; email?: string };
    try {
      payload = await req.json();
    } catch {
      return jsonResponse({ error: 'Invalid request body' }, 400);
    }

    const event = (payload.event ?? '').trim();
    if (!event) return jsonResponse({ error: 'event is required' }, 400);
    // Not validated against the real events content collection -- this is a
    // low-stakes public demand counter, not a security boundary, and a
    // Function can't read Astro's content collections at runtime anyway.
    // Worst case a bogus id creates a harmless stray blob entry.

    const email = (payload.email ?? '').trim().toLowerCase();

    // Read-modify-write via Blobs' own optimistic concurrency (ETag +
    // onlyIfMatch/onlyIfNew) rather than a plain unconditional write --
    // two concurrent submissions could otherwise both read the same count
    // and each overwrite the other's increment. Bounded retries rather than
    // a different storage model, since this site's actual traffic makes
    // more than a couple of retries vanishingly unlikely.
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const existing = (await store.getWithMetadata(event, { type: 'json' })) as { data: InterestRecord; etag: string } | null;
      const record: InterestRecord = existing?.data ?? { count: 0, emails: [] };

      if (email && record.emails.includes(email)) {
        // Same person, already counted (e.g. a different browser/device) --
        // idempotent no-op rather than an error, so the client doesn't need
        // special-case handling; it just doesn't also re-notify the farm team.
        return jsonResponse({ count: record.count, deduped: true });
      }

      const updated: InterestRecord = {
        count: record.count + 1,
        emails: email ? [...record.emails, email] : record.emails,
      };

      const result = await store.setJSON(event, updated, existing ? { onlyIfMatch: existing.etag } : { onlyIfNew: true });
      if (result.modified) {
        return jsonResponse({ count: updated.count, deduped: false });
      }
      // Someone else wrote in between our read and write -- retry with a
      // fresh read rather than clobbering their update.
    }

    return jsonResponse({ error: 'Too many concurrent submissions, please try again.' }, 503);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
};

export const config = {
  path: '/api/event-interest',
};
