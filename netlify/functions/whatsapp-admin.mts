// Netlify Function (v2 API) backing the internal WhatsApp reply dashboard
// (src/pages/internal/whatsapp.astro). Lists conversations/messages
// persisted by whatsapp-webhook.mts and sends replies via Meta's Send
// Message API. See WHATSAPP.md for the full setup context.
//
// Gated by Google Sign-In plus the shared admin access model (issue #89):
// requireStaff (lib/staff-access.ts) verifies the ID token and checks the
// caller's role in the "whatsapp" module — `view` to read, `reply` to send,
// `manage` to block/unblock. This replaced the shared "Photo Pool Curators"
// Sheet allow-list (2026-10).
//
// Privacy: a contact's phone number never leaves this Function in full — replies and
// blocks look it up server-side by conversation id, and the conversation list carries
// only a masked form ("+91 •••••• 345", lib/staff-masking.ts) so an admin can tell an
// unnamed sender apart; search never matches on the number. Contact names are visible to roles that
// operate the inbox and masked for read-only roles (lib/staff-masking.ts); a
// contact with no name gets an opaque "Contact XXXX" label rather than their
// number. Message bodies are sent to anyone who can `view`, since that
// content is what the inbox is for.
import {
  listConversations,
  searchConversations,
  listMessages,
  getConversation,
  insertMessage,
  markConversationRead,
  setConversationBlocked,
  listOptedOutPhones,
  addOptOut,
  removeOptOut,
  getLatestInboundWaMessageId,
  getMessage,
  listRecentMessagesByConversation,
} from '../../scripts/lib/supabase.mjs';
import { loadGuestContext } from './lib/guest-context';
import { needsReply } from './lib/whatsapp-guest';
import { baseMime, mediaResponseHeaders, MAX_MEDIA_BYTES } from './lib/whatsapp-media';
import { requireStaff, logStaffAction, type StaffGrant } from './lib/staff-access';
import { canSeeNames, maskEmail, maskName, maskPhone } from './lib/staff-masking';
import { roleHasCapability, type Capability } from './lib/staff-registry';

const WHATSAPP_GRAPH_API_VERSION = 'v21.0';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Opaque stand-in label for a contact with no WhatsApp profile name — the
// first characters of the conversation id, never any part of the number.
function contactLabel(conversationId: string): string {
  return `Contact ${conversationId.slice(0, 4).toUpperCase()}`;
}

// Routine actions are logged after they succeed; a failed audit write is
// reported but doesn't undo a message Meta already delivered.
async function auditBestEffort(staff: StaffGrant, action: string, conversationId: string): Promise<void> {
  try {
    await logStaffAction({ actorId: staff.id, action, module: 'whatsapp', detail: { conversationId } });
  } catch (err) {
    console.error('Failed to write staff audit log', err);
  }
}

async function handleConversations(url: URL, staff: StaffGrant): Promise<Response> {
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
  const search = url.searchParams.get('search')?.trim();
  const namesVisible = canSeeNames(staff.role);

  try {
    const conversations = search
      ? await searchConversations(search, { ...(limit ? { limit } : {}), matchNames: namesVisible })
      : await listConversations(limit ? { limit } : {});
    // Which of these numbers asked us to stop WhatsApp messages (STOP reply, or
    // an admin opt-out below). Best-effort: if the list can't be read the inbox
    // still loads, it just can't show the state.
    let optedOut = new Set<string>();
    try {
      optedOut = await listOptedOutPhones(conversations.map((c: any) => c.wa_phone));
    } catch (err) {
      console.error('Failed to read the WhatsApp opt-out list', err);
    }
    // Which conversations still wait on a person to reply (the "Needs reply" filter).
    // If the lookup fails, fall back to the latest message's direction.
    let recent = new Map<string, Array<{ direction: 'inbound' | 'outbound'; body: string }>>();
    try {
      recent = await listRecentMessagesByConversation(conversations.map((c: any) => c.id));
    } catch (err) {
      console.error('Failed to read recent messages for the needs-reply filter', err);
    }
    return jsonResponse({
      // The admin's own name for the reply signature: the page prefills "Signing as" with it, so
      // nobody retypes it on a new browser or device. Only ever the caller's own name.
      signerDefault: staff.name || staff.googleName || null,
      capabilities: {
        reply: roleHasCapability('whatsapp', staff.role, 'reply'),
        manage: roleHasCapability('whatsapp', staff.role, 'manage'),
      },
      conversations: conversations.map((c: any) => {
        const lastMessage = c.whatsapp_messages?.[0];
        return {
          id: c.id,
          // Never the full phone number: phoneMasked is country code + last three digits.
          label: c.display_name ? (namesVisible ? c.display_name : maskName(c.display_name)) : contactLabel(c.id),
          phoneMasked: maskPhone(`+${c.wa_phone}`),
          lastMessageAt: c.last_message_at,
          // Global, not per-user — see the migration comment for why. A
          // conversation with no last_read_at has never been opened by anyone.
          unread: !c.last_read_at || new Date(c.last_message_at) > new Date(c.last_read_at),
          lastMessagePreview: lastMessage?.body ?? null,
          lastMessageDirection: lastMessage?.direction ?? null,
          isBlocked: c.is_blocked ?? false,
          optedOut: optedOut.has(c.wa_phone),
          needsReply: recent.has(c.id)
            ? needsReply(recent.get(c.id)!, c.is_blocked ?? false)
            : !(c.is_blocked ?? false) && lastMessage?.direction !== 'outbound',
          // Set when the chat started from a Click-to-WhatsApp ad or an
          // Instagram/Facebook post (Meta's `referral` object).
          referral: c.referral_source_type
            ? { type: c.referral_source_type, headline: c.referral_headline ?? null, url: c.referral_source_url ?? null }
            : null,
        };
      }),
    });
  } catch (err) {
    console.error('Failed to list conversations', err);
    return jsonResponse({ error: 'Failed to reach the message store' }, 502);
  }
}

async function handleMessages(url: URL): Promise<Response> {
  const conversationId = url.searchParams.get('conversationId');
  if (!conversationId) return jsonResponse({ error: 'conversationId is required' }, 400);

  try {
    const messages = await listMessages(conversationId);
    // Best-effort: opening a thread marks it read for every admin,
    // but a failure here shouldn't block the messages the caller asked for.
    markConversationRead(conversationId).catch((err) => console.error('Failed to mark conversation read', err));
    return jsonResponse({
      messages: messages.map((m: any) => ({
        id: m.id,
        direction: m.direction,
        body: m.body,
        status: m.status,
        errorMessage: m.error_message,
        createdAt: m.created_at,
        // The file itself is fetched on demand via /media, never inlined here.
        media: m.media_id ? { kind: m.media_kind, mime: baseMime(m.media_mime), filename: m.media_filename } : null,
      })),
    });
  } catch (err) {
    console.error('Failed to list messages', err);
    return jsonResponse({ error: 'Failed to reach the message store' }, 502);
  }
}

async function handleReply(req: Request, staff: StaffGrant): Promise<Response> {
  let payload: { conversationId?: string; body?: string; responderName?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const { conversationId, body, responderName } = payload;
  if (!conversationId || !body?.trim()) {
    return jsonResponse({ error: 'conversationId and body are required' }, 400);
  }

  // Multiple admins share one WhatsApp inbox — often signed into a single
  // shared Google account rather than each person's own, so the ID token's
  // name claim can't tell them apart. The page asks each person to type
  // their own name once (kept in localStorage), sent here as responderName.
  // The fallbacks below only apply if that's somehow missing (an old cached
  // page from before this existed, say): the name registered for the admin
  // member, then the name on their Google account, then a masked form of
  // their address — never the full email. The signature is part of the actual
  // text sent to the customer, not just internal metadata, so it's included
  // in what's stored too, to keep the thread showing exactly what was sent.
  const signerLabel = responderName?.trim() || staff.name || staff.googleName || maskEmail(staff.email);
  const signedBody = signerLabel ? `${body}\n\n- ${signerLabel}` : body;

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    console.error('Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  let conversation: { id: string; wa_phone: string } | null;
  try {
    conversation = await getConversation(conversationId);
  } catch (err) {
    console.error('Failed to look up conversation', err);
    return jsonResponse({ error: 'Failed to reach the message store' }, 502);
  }
  if (!conversation) return jsonResponse({ error: 'Conversation not found' }, 404);

  let metaRes: Response;
  let metaData: any;
  try {
    metaRes = await fetch(`https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: conversation.wa_phone,
        type: 'text',
        text: { body: signedBody },
      }),
    });
    metaData = await metaRes.json();
  } catch (err) {
    console.error('Failed to reach the WhatsApp Send Message API', err);
    return jsonResponse({ error: 'Failed to reach WhatsApp' }, 502);
  }

  if (!metaRes.ok) {
    // Most commonly the 24-hour customer-service-window rejection, since no
    // approved message templates exist yet — surface Meta's own message
    // rather than a generic failure, and still record the attempt so the
    // thread shows what was tried.
    const errorMessage: string = metaData?.error?.message ?? 'WhatsApp API error';
    console.error('[whatsapp-admin] Send failed', metaRes.status, metaData);
    try {
      await insertMessage({ conversationId, direction: 'outbound', body: signedBody, status: 'failed', errorMessage });
    } catch (err) {
      console.error('Failed to record failed send', err);
    }
    return jsonResponse({ error: errorMessage, metaCode: metaData?.error?.code }, 502);
  }

  const waMessageId = metaData?.messages?.[0]?.id;
  try {
    const saved = await insertMessage({ conversationId, direction: 'outbound', body: signedBody, waMessageId, status: 'sent' });
    await auditBestEffort(staff, 'whatsapp.reply', conversationId);
    return jsonResponse({ ok: true, message: saved });
  } catch (err) {
    // The WhatsApp send itself succeeded — Meta already delivered it — a
    // failure here only means our own copy wasn't recorded; still report
    // success to the caller since a "failed" state would be misleading.
    console.error('Send succeeded but failed to record the outbound message', err);
    await auditBestEffort(staff, 'whatsapp.reply', conversationId);
    return jsonResponse({ ok: true, message: null });
  }
}

// Blocks or unblocks a conversation's number with Meta directly (Cloud
// API's block_users endpoint — POST to block, DELETE to unblock — scoped to
// our phone number ID, same auth as handleReply). Once blocked, Meta drops
// future inbound messages from that number before they ever reach
// whatsapp-webhook.mts; no notification to the sender either way. The local
// is_blocked flag is just a mirror of this for the UI — Meta's own state is
// the source of truth, so a failed Supabase write after a successful Meta
// call still leaves the block in effect, just unreflected in the badge
// until the next successful toggle.
async function handleBlock(req: Request, staff: StaffGrant): Promise<Response> {
  let payload: { conversationId?: string; blocked?: boolean };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const { conversationId, blocked } = payload;
  if (!conversationId || typeof blocked !== 'boolean') {
    return jsonResponse({ error: 'conversationId and blocked are required' }, 400);
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    console.error('Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  let conversation: { id: string; wa_phone: string } | null;
  try {
    conversation = await getConversation(conversationId);
  } catch (err) {
    console.error('Failed to look up conversation', err);
    return jsonResponse({ error: 'Failed to reach the message store' }, 502);
  }
  if (!conversation) return jsonResponse({ error: 'Conversation not found' }, 404);

  // Blocking cuts a person off from the number, so it's logged *before* it
  // happens and refused if the log can't be written — unlike routine replies.
  try {
    await logStaffAction({
      actorId: staff.id,
      action: blocked ? 'whatsapp.block_requested' : 'whatsapp.unblock_requested',
      module: 'whatsapp',
      detail: { conversationId },
    });
  } catch (err) {
    console.error('Failed to write staff audit log; refusing to block/unblock', err);
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  let metaRes: Response;
  let metaData: any;
  try {
    metaRes = await fetch(`https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${phoneNumberId}/block_users`, {
      method: blocked ? 'POST' : 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        block_users: [{ user: conversation.wa_phone }],
      }),
    });
    metaData = await metaRes.json();
  } catch (err) {
    console.error('Failed to reach the WhatsApp Block Users API', err);
    return jsonResponse({ error: 'Failed to reach WhatsApp' }, 502);
  }

  if (!metaRes.ok) {
    const errorMessage: string = metaData?.error?.message ?? 'WhatsApp API error';
    console.error('[whatsapp-admin] Block/unblock failed', metaRes.status, metaData);
    return jsonResponse({ error: errorMessage, metaCode: metaData?.error?.code }, 502);
  }

  try {
    await setConversationBlocked(conversationId, blocked);
  } catch (err) {
    // Meta's block already took effect — a failure here only means the local
    // badge won't reflect it yet, so still report success (see comment above
    // the function for why this asymmetry is intentional).
    console.error('Block/unblock succeeded on Meta but failed to record locally', err);
  }

  return jsonResponse({ ok: true, isBlocked: blocked });
}

// Everything the inbox can say about the person on the other end, for the guest
// panel: their event bookings (Event Payments) and stays (Accommodation), matched
// on the WhatsApp number. The number itself, and every contact detail, stays on
// the server. Each section is gated by the viewer's role in THAT module (a
// whatsapp-only person is told it is limited rather than shown nothing), and names
// are masked for read-only roles like in the accommodation tool.
async function handleGuest(req: Request, url: URL): Promise<Response> {
  const conversationId = url.searchParams.get('conversationId');
  if (!conversationId) return jsonResponse({ error: 'conversationId is required' }, 400);

  let conversation: { id: string; wa_phone: string; created_at?: string } | null;
  try {
    conversation = await getConversation(conversationId);
  } catch (err) {
    console.error('Failed to look up conversation', err);
    return jsonResponse({ error: 'Failed to reach the message store' }, 502);
  }
  if (!conversation) return jsonResponse({ error: 'Conversation not found' }, 404);
  const e164 = `+${conversation.wa_phone}`;

  const [payments, accommodation] = await Promise.all([requireStaff(req, 'event-payments', 'view'), requireStaff(req, 'accommodation', 'view')]);

  const context = await loadGuestContext({
    e164,
    payments: payments.ok,
    accommodation: accommodation.ok ? { seeNames: canSeeNames(accommodation.staff.role) } : false,
  });
  return jsonResponse({ since: conversation.created_at ?? null, ...context });
}

// Streams a guest's photo / voice note / video / document to a signed-in admin
// member. The file lives at Meta (kept ~30 days): look up its media id from our
// own message row (never from the request), ask Graph for a short-lived URL,
// then fetch that URL with the access token and pass the bytes through. Capped
// at what a Netlify Function can return. Served with headers that stop a crafted
// file from running anything in this origin (see lib/whatsapp-media.ts).
async function handleMedia(url: URL): Promise<Response> {
  const messageId = url.searchParams.get('messageId');
  if (!messageId) return jsonResponse({ error: 'messageId is required' }, 400);

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('Missing WHATSAPP_ACCESS_TOKEN');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  let message: { media_id: string | null; media_mime: string | null; media_filename: string | null } | null;
  try {
    message = await getMessage(messageId);
  } catch (err) {
    console.error('Failed to look up message', err);
    return jsonResponse({ error: 'Failed to reach the message store' }, 502);
  }
  if (!message?.media_id) return jsonResponse({ error: 'No file on this message' }, 404);

  try {
    const metaRes = await fetch(`https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${encodeURIComponent(message.media_id)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (metaRes.status === 404 || metaRes.status === 410) {
      return jsonResponse({ error: 'This file has expired on WhatsApp (they keep media for about 30 days).' }, 410);
    }
    const info: any = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !info?.url) {
      // Meta also answers 400 with an error body for an expired / unknown id.
      const expired = metaRes.status === 400 && /does not exist|expired|unsupported get request/i.test(info?.error?.message ?? '');
      if (expired) return jsonResponse({ error: 'This file has expired on WhatsApp (they keep media for about 30 days).' }, 410);
      console.error('[whatsapp-admin] Media lookup failed', metaRes.status, info?.error ?? info);
      return jsonResponse({ error: 'Could not fetch the file from WhatsApp' }, 502);
    }
    if (Number(info.file_size) > MAX_MEDIA_BYTES) {
      return jsonResponse({ error: 'This file is too large to show here. Open it on the phone or WhatsApp Web.' }, 413);
    }

    const fileRes = await fetch(info.url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!fileRes.ok) {
      console.error('[whatsapp-admin] Media download failed', fileRes.status);
      return jsonResponse({ error: fileRes.status === 404 ? 'This file has expired on WhatsApp.' : 'Could not fetch the file from WhatsApp' }, fileRes.status === 404 ? 410 : 502);
    }
    const bytes = await fileRes.arrayBuffer();
    if (bytes.byteLength > MAX_MEDIA_BYTES) {
      return jsonResponse({ error: 'This file is too large to show here. Open it on the phone or WhatsApp Web.' }, 413);
    }
    // Our own recorded type wins over what the download says; both are guest-controlled.
    return new Response(bytes, { status: 200, headers: mediaResponseHeaders(message.media_mime ?? info.mime_type, message.media_filename) });
  } catch (err) {
    console.error('[whatsapp-admin] Media fetch threw', err);
    return jsonResponse({ error: 'Could not fetch the file from WhatsApp' }, 502);
  }
}

// Admins opt a number out of (or back into) guest WhatsApp template messages —
// the same whatsapp_opt_outs list a STOP reply writes to, which
// lib/whatsapp-send.ts checks before every template send. For a guest who
// asked another way (email, in person), or to undo a mistake. Nothing is sent
// to the guest. Logged BEFORE it happens and refused if the log can't be
// written, like blocking: switching someone's messages back on is only right
// if THEY asked.
async function handleOptOut(req: Request, staff: StaffGrant): Promise<Response> {
  let payload: { conversationId?: string; optedOut?: boolean };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }
  const { conversationId, optedOut } = payload;
  if (!conversationId || typeof optedOut !== 'boolean') {
    return jsonResponse({ error: 'conversationId and optedOut are required' }, 400);
  }

  let conversation: { id: string; wa_phone: string } | null;
  try {
    conversation = await getConversation(conversationId);
  } catch (err) {
    console.error('Failed to look up conversation', err);
    return jsonResponse({ error: 'Failed to reach the message store' }, 502);
  }
  if (!conversation) return jsonResponse({ error: 'Conversation not found' }, 404);

  try {
    await logStaffAction({
      actorId: staff.id,
      action: optedOut ? 'whatsapp.opt_out' : 'whatsapp.opt_in',
      module: 'whatsapp',
      detail: { conversationId },
    });
  } catch (err) {
    console.error('Failed to write staff audit log; refusing to change the opt-out list', err);
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  try {
    const phone = `+${conversation.wa_phone}`;
    if (optedOut) await addOptOut(phone, 'staff');
    else await removeOptOut(phone);
  } catch (err) {
    console.error('Failed to update the WhatsApp opt-out list', err);
    return jsonResponse({ error: 'Failed to reach the message store' }, 502);
  }
  return jsonResponse({ ok: true, optedOut });
}

// Marks the guest's latest message as read (blue ticks on their phone) and,
// when `typing` is set, shows "typing…" to them for up to ~25 seconds or until
// a reply is sent. Both are one Cloud API call against that message's id.
// Best-effort by design: the inbox page calls this opportunistically, and a
// failure (no inbound message, outside the 24h window, Meta hiccup) must never
// surface as an error to admins, so it always answers 200 with `ok`.
async function handleSeen(req: Request): Promise<Response> {
  let payload: { conversationId?: string; typing?: boolean };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }
  if (!payload.conversationId) return jsonResponse({ error: 'conversationId is required' }, 400);

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) return jsonResponse({ ok: false });

  try {
    const waMessageId = await getLatestInboundWaMessageId(payload.conversationId);
    if (!waMessageId) return jsonResponse({ ok: false });
    const res = await fetch(`https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: waMessageId,
        ...(payload.typing ? { typing_indicator: { type: 'text' } } : {}),
      }),
    });
    if (!res.ok) console.error('[whatsapp-admin] Mark-as-read failed', res.status, await res.text());
    return jsonResponse({ ok: res.ok });
  } catch (err) {
    console.error('[whatsapp-admin] Mark-as-read threw', err);
    return jsonResponse({ ok: false });
  }
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  // Pick the route first so each one is gated by the capability it needs:
  // reading is `view`, sending is `reply`, blocking is `manage`.
  type Route = { capability: Capability<'whatsapp'>; run: (staff: StaffGrant) => Promise<Response> };
  const route: Route | null =
    url.pathname === '/api/whatsapp-admin/conversations' && req.method === 'GET'
      ? { capability: 'view', run: (staff) => handleConversations(url, staff) }
      : url.pathname === '/api/whatsapp-admin/messages' && req.method === 'GET'
        ? { capability: 'view', run: () => handleMessages(url) }
        : url.pathname === '/api/whatsapp-admin/guest' && req.method === 'GET'
          ? { capability: 'view', run: () => handleGuest(req, url) }
          : url.pathname === '/api/whatsapp-admin/media' && req.method === 'GET'
          ? { capability: 'view', run: () => handleMedia(url) }
          : url.pathname === '/api/whatsapp-admin/reply' && req.method === 'POST'
          ? { capability: 'reply', run: (staff) => handleReply(req, staff) }
          : url.pathname === '/api/whatsapp-admin/block' && req.method === 'POST'
            ? { capability: 'manage', run: (staff) => handleBlock(req, staff) }
            : url.pathname === '/api/whatsapp-admin/opt-out' && req.method === 'POST'
              ? { capability: 'manage', run: (staff) => handleOptOut(req, staff) }
              : url.pathname === '/api/whatsapp-admin/seen' && req.method === 'POST'
                ? { capability: 'reply', run: () => handleSeen(req) }
                : null;
  if (!route) return jsonResponse({ error: 'Not found' }, 404);

  const auth = await requireStaff(req, 'whatsapp', route.capability);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  return route.run(auth.staff);
};

export const config = {
  path: [
    '/api/whatsapp-admin/conversations',
    '/api/whatsapp-admin/messages',
    '/api/whatsapp-admin/reply',
    '/api/whatsapp-admin/block',
    '/api/whatsapp-admin/opt-out',
    '/api/whatsapp-admin/seen',
    '/api/whatsapp-admin/media',
    '/api/whatsapp-admin/guest',
  ],
};
