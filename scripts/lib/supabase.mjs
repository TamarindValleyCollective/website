// Hand-rolled Supabase PostgREST REST client for the whatsapp_* tables (see
// supabase/migrations/0001_whatsapp_reply_admin.sql) in the "TVC ERP"
// Supabase project. Uses the service_role key server-side only (RLS bypass
// — see the migration's RLS comment); never import this from anything that
// ships to the browser. Mirrors google-drive.mjs's plain-ESM, no-SDK style —
// PostgREST's REST surface for these few operations (list/upsert/insert) is
// simple enough not to justify the @supabase/supabase-js dependency.

function restHeaders(extra = {}) {
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
