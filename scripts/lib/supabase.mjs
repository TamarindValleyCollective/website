// Hand-rolled Supabase PostgREST REST client for the whatsapp_* tables (see
// supabase/migrations/0001_whatsapp_reply_admin.sql) in the "TVC ERP"
// Supabase project. Uses the service_role key server-side only (RLS bypass
// — see the migration's RLS comment); never import this from anything that
// ships to the browser. Mirrors google-drive.mjs's plain-ESM, no-SDK style —
// PostgREST's REST surface for these few operations (list/upsert/insert) is
// simple enough not to justify the @supabase/supabase-js dependency.

// Exported for reuse by accommodation-db.mjs, which talks to the same
// project's rpc/ endpoints with the same service_role auth.
export function restHeaders(extra = {}) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'content-type': 'application/json',
    ...extra,
  };
}

async function restFetch(path, options = {}) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const res = await fetch(`${supabaseUrl}/rest/v1${path}`, {
    ...options,
    headers: restHeaders(options.headers),
  });
  if (!res.ok) {
    throw new Error(`Supabase REST ${options.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

// Upserts a conversation by wa_phone (unique), bumping last_message_at and
// display_name. Returns the row. PostgREST's on_conflict + merge-duplicates
// does this atomically at the DB level — a separate select-then-insert/
// update round-trip would race under concurrent webhook deliveries for the
// same sender.
//
// last_stale_alert_at is reset to null on every call — each new inbound
// message restarts the stale-alert countdown (see whatsapp-stale-alert.mts)
// rather than inheriting a timestamp from a previous unread streak on this
// same conversation.
export async function upsertConversation({ waPhone, displayName, lastMessageAt }) {
  const res = await restFetch(`/whatsapp_conversations?on_conflict=wa_phone`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([
      {
        wa_phone: waPhone,
        display_name: displayName ?? null,
        last_message_at: lastMessageAt,
        last_stale_alert_at: null,
      },
    ]),
  });
  const rows = await res.json();
  return rows[0];
}

// Inserts one message row. When waMessageId is given, a partial unique index
// (see migration) + ignore-duplicates upsert makes a re-delivered webhook a
// no-op instead of a duplicate row — Meta documents at-least-once delivery
// with retries on non-2xx and occasional duplicates even on 2xx.
/**
 * @param {{ conversationId: string, direction: 'inbound' | 'outbound', body: string, waMessageId?: string, status?: 'received' | 'sent' | 'failed', errorMessage?: string }} params
 */
export async function insertMessage({ conversationId, direction, body, waMessageId, status, errorMessage }) {
  const resolvedStatus = status ?? (direction === 'inbound' ? 'received' : 'sent');
  const res = await restFetch(`/whatsapp_messages${waMessageId ? '?on_conflict=wa_message_id' : ''}`, {
    method: 'POST',
    headers: { Prefer: waMessageId ? 'resolution=ignore-duplicates,return=representation' : 'return=representation' },
    body: JSON.stringify([
      {
        conversation_id: conversationId,
        direction,
        body,
        wa_message_id: waMessageId ?? null,
        status: resolvedStatus,
        error_message: errorMessage ?? null,
      },
    ]),
  });
  const rows = await res.json();
  return rows[0] ?? null;
}

// Conversation list for the admin UI, most recently active first. The admin
// page re-requests with a growing `limit` (rather than tracking an offset)
// when the "Load more" button is used — see whatsapp.astro — so a single
// bumped limit also naturally re-surfaces any new conversation that arrived
// above previously-loaded ones, no separate merge logic needed.
//
// Embeds each conversation's single latest message (PostgREST resource
// embedding with a per-relationship order+limit, via the whatsapp_messages
// foreign key) so the list can show a preview snippet — standard for any
// inbox UI, and cheaper than a second round-trip per row.
export async function listConversations({ limit = 100 } = {}) {
  const res = await restFetch(
    `/whatsapp_conversations?select=*,whatsapp_messages(body,direction,created_at)` +
      `&whatsapp_messages.order=created_at.desc&whatsapp_messages.limit=1` +
      `&order=last_message_at.desc&limit=${limit}`,
  );
  return res.json();
}

// Searches conversations by contact name, or by message content —
// two separate REST calls merged in JS rather than one query, since
// PostgREST has no clean way to OR a top-level column condition together
// with a condition on an inner-joined embedded resource in a single
// request. When a conversation matches by message content, that matching
// message (not necessarily the latest one) is what gets shown as the
// preview — more useful for search than always showing the latest message,
// same idea as how a real search UI highlights the matched snippet.
//
// Never matches on the phone number: it's a contact detail the admin UI must
// not reveal, and a partial-match search would let anyone recover it digit by
// digit. `matchNames: false` also drops the name match, for roles that only
// see masked names (the same letter-by-letter recovery otherwise).
export async function searchConversations(query, { limit = 50, matchNames = true } = {}) {
  const pattern = encodeURIComponent(`*${query}*`);

  const [byFieldRes, byMessageRes] = await Promise.all([
    matchNames
      ? restFetch(
          `/whatsapp_conversations?select=*,whatsapp_messages(body,direction,created_at)` +
            `&whatsapp_messages.order=created_at.desc&whatsapp_messages.limit=1` +
            `&display_name=ilike.${pattern}` +
            `&order=last_message_at.desc&limit=${limit}`,
        )
      : Promise.resolve(new Response('[]')),
    restFetch(
      `/whatsapp_conversations?select=*,whatsapp_messages!inner(body,direction,created_at)` +
        `&whatsapp_messages.body=ilike.${pattern}` +
        `&order=last_message_at.desc&limit=${limit}`,
    ),
  ]);

  const [byField, byMessage] = await Promise.all([byFieldRes.json(), byMessageRes.json()]);

  const merged = new Map();
  for (const c of byField) merged.set(c.id, c);
  for (const c of byMessage) merged.set(c.id, c); // wins on overlap — matched-message preview
  return [...merged.values()].sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()).slice(0, limit);
}

// Mirrors a block/unblock decision made against Meta's Cloud API (see
// handleBlock in whatsapp-admin.mts) into is_blocked/blocked_at, so the
// admin UI can show a "Blocked" badge without a live Graph API round-trip
// on every conversation-list poll. The real enforcement lives with Meta —
// this column is a local reflection of that state, not the source of truth.
export async function setConversationBlocked(conversationId, blocked) {
  await restFetch(`/whatsapp_conversations?id=eq.${conversationId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ is_blocked: blocked, blocked_at: blocked ? new Date().toISOString() : null }),
  });
}

// Marks a conversation read *for everyone* — this is one shared inbox, not
// per-user state, so opening a thread clears its unread flag for all staff.
export async function markConversationRead(conversationId) {
  await restFetch(`/whatsapp_conversations?id=eq.${conversationId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_read_at: new Date().toISOString() }),
  });
}

// One conversation's full message history, oldest first (chat reading order).
export async function listMessages(conversationId, { limit = 200 } = {}) {
  const res = await restFetch(
    `/whatsapp_messages?conversation_id=eq.${conversationId}&select=*&order=created_at.asc&limit=${limit}`,
  );
  return res.json();
}

// Single conversation lookup by id — used by the reply endpoint to get the
// phone number to send to.
export async function getConversation(conversationId) {
  const res = await restFetch(`/whatsapp_conversations?id=eq.${conversationId}&select=*&limit=1`);
  const rows = await res.json();
  return rows[0] ?? null;
}

// Conversations unread for at least staleMinutes with no alert sent in that
// same window — the source list for the digest email in
// whatsapp-stale-alert.mts. "Unread" can't be expressed as a PostgREST
// filter (its operators compare a column to a literal, not to another
// column), so last_message_at/last_read_at is fetched and compared in JS,
// same approach as handleConversations in whatsapp-admin.mts.
export async function listStaleUnreadConversations({ staleMinutes = 60 } = {}) {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
  const res = await restFetch(
    `/whatsapp_conversations?select=*,whatsapp_messages(body,direction,created_at)` +
      `&whatsapp_messages.order=created_at.desc&whatsapp_messages.limit=1` +
      `&last_message_at=lt.${encodeURIComponent(cutoff)}` +
      `&or=(last_stale_alert_at.is.null,last_stale_alert_at.lt.${encodeURIComponent(cutoff)})` +
      `&order=last_message_at.asc`,
  );
  const rows = await res.json();
  return rows.filter((c) => !c.last_read_at || new Date(c.last_message_at) > new Date(c.last_read_at));
}

// Records that a digest alert just covered these conversations, so the next
// cron tick doesn't re-include them until another staleMinutes has passed.
export async function markStaleAlertSent(conversationIds) {
  if (conversationIds.length === 0) return;
  await restFetch(`/whatsapp_conversations?id=in.(${conversationIds.join(',')})`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_stale_alert_at: new Date().toISOString() }),
  });
}

// ---- Outbound template delivery tracking (migration 0032) ----

// Records a template message Meta has accepted, keyed by its wamid so the
// later `statuses` webhook events can update it. Idempotent on wa_message_id.
/**
 * @param {{ waMessageId: string, template: string, eventPaymentId?: string | null, recipientLast4?: string | null }} params
 */
export async function recordTemplateSend({ waMessageId, template, eventPaymentId, recipientLast4 }) {
  await restFetch(`/whatsapp_template_sends?on_conflict=wa_message_id`, {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify([
      {
        wa_message_id: waMessageId,
        template,
        event_payment_id: eventPaymentId ?? null,
        recipient_last4: recipientLast4 ?? null,
      },
    ]),
  });
}

// Which earlier statuses a new status may replace. Webhook events can arrive
// out of order or twice, so a status only ever moves forward
// (accepted → sent → delivered → read); 'failed' replaces anything not yet
// delivered. Returns the updated row (null if the wamid isn't one of ours or
// the update would move backwards) so the caller can act on a failure.
const STATUS_CAN_REPLACE = {
  sent: ['accepted'],
  delivered: ['accepted', 'sent'],
  read: ['accepted', 'sent', 'delivered'],
  failed: ['accepted', 'sent'],
};

/**
 * @param {{ waMessageId: string, status: 'sent' | 'delivered' | 'read' | 'failed', errorCode?: string | null, errorMessage?: string | null, statusAt?: string | null }} params
 */
export async function updateTemplateSendStatus({ waMessageId, status, errorCode, errorMessage, statusAt }) {
  const replaceable = STATUS_CAN_REPLACE[status];
  if (!replaceable) return null;
  const res = await restFetch(
    `/whatsapp_template_sends?wa_message_id=eq.${encodeURIComponent(waMessageId)}&status=in.(${replaceable.join(',')})`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        status,
        error_code: errorCode ?? null,
        error_message: errorMessage ?? null,
        status_at: statusAt ?? new Date().toISOString(),
      }),
    },
  );
  const rows = await res.json();
  return rows[0] ?? null;
}

// Latest delivery state of every template message sent about the given
// bookings, for the Event Payments dashboard.
/**
 * @param {string[]} bookingIds
 * @returns {Promise<Array<{ event_payment_id: string, template: string, status: string, error_message: string | null, status_at: string | null, created_at: string }>>}
 */
export async function listTemplateSendsForBookings(bookingIds) {
  if (bookingIds.length === 0) return [];
  const res = await restFetch(
    `/whatsapp_template_sends?event_payment_id=in.(${bookingIds.map((id) => encodeURIComponent(id)).join(',')})&select=event_payment_id,template,status,error_message,status_at,created_at&order=created_at.asc`,
  );
  return res.json();
}
