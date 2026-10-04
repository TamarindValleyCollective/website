// Netlify Function (v2 API) backing the internal WhatsApp reply dashboard
// (src/pages/internal/whatsapp.astro). Lists conversations/messages
// persisted by whatsapp-webhook.mts and sends replies via Meta's Send
// Message API. See WHATSAPP.md for the full setup context.
//
// Gated by Google Sign-In plus the shared staff access model (issue #89):
// requireStaff (lib/staff-access.ts) verifies the ID token and checks the
// caller's role in the "whatsapp" module — `view` to read, `reply` to send,
// `manage` to block/unblock. This replaced the shared "Photo Pool Curators"
// Sheet allow-list (2026-10).
//
// Privacy: a contact's phone number never leaves this Function — replies and
// blocks look it up server-side by conversation id, but no response carries
// it, and search never matches on it. Contact names are visible to roles that
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
} from '../../scripts/lib/supabase.mjs';
import { requireStaff, logStaffAction, type StaffGrant } from './lib/staff-access';
import { canSeeNames, maskName } from './lib/staff-masking';
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
    return jsonResponse({
      capabilities: {
        reply: roleHasCapability('whatsapp', staff.role, 'reply'),
        manage: roleHasCapability('whatsapp', staff.role, 'manage'),
      },
      conversations: conversations.map((c: any) => {
        const lastMessage = c.whatsapp_messages?.[0];
        return {
          id: c.id,
          // Never the phone number. See contactLabel/maskName above.
          label: c.display_name ? (namesVisible ? c.display_name : maskName(c.display_name)) : contactLabel(c.id),
          lastMessageAt: c.last_message_at,
          // Global, not per-user — see the migration comment for why. A
          // conversation with no last_read_at has never been opened by anyone.
          unread: !c.last_read_at || new Date(c.last_message_at) > new Date(c.last_read_at),
          lastMessagePreview: lastMessage?.body ?? null,
          lastMessageDirection: lastMessage?.direction ?? null,
          isBlocked: c.is_blocked ?? false,
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
    // Best-effort: opening a thread marks it read for every staff member,
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

  // Multiple staff share one WhatsApp inbox — often signed into a single
  // shared Google account rather than each person's own, so the ID token's
  // name claim can't tell them apart. The page asks each person to type
  // their own name once (kept in localStorage), sent here as responderName;
  // fall back to the staff member's registered name only if that's somehow
  // missing (an old cached page from before this existed, say) — never their
  // email, which would otherwise be printed into the customer's chat. The
  // signature is part of the actual text sent to the customer, not just
  // internal metadata, so it's included in what's stored too, to keep the
  // thread showing exactly what was sent.
  const signerLabel = responderName?.trim() || staff.name || undefined;
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
        : url.pathname === '/api/whatsapp-admin/reply' && req.method === 'POST'
          ? { capability: 'reply', run: (staff) => handleReply(req, staff) }
          : url.pathname === '/api/whatsapp-admin/block' && req.method === 'POST'
            ? { capability: 'manage', run: (staff) => handleBlock(req, staff) }
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
  ],
};
