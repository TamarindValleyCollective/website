// Netlify Function (v2 API) backing the internal WhatsApp reply dashboard
// (src/pages/internal/whatsapp.astro). Lists conversations/messages
// persisted by whatsapp-webhook.mts and sends replies via Meta's Send
// Message API. See WHATSAPP.md for the full setup context.
//
// Gated by Google Sign-In, same pattern as photo-pool.mts: a staff member
// authenticates with their own Google account (client-side via Google
// Identity Services), and this Function verifies the resulting ID token
// itself (google-id-token.mjs) before checking the verified email against
// the same curator allow-list photo-pool.mts uses (PHOTO_POOL_ALLOWED_
// EMAILS_SHEET_ID) — reused rather than standing up a second Sheet, since
// it's the same "core team" staff; point this at a different Sheet ID later
// if that ever needs to diverge.
import { listConversations, listMessages, getConversation, insertMessage } from '../../scripts/lib/supabase.mjs';
import { getAllowedEmails } from '../../scripts/lib/google-drive.mjs';
import { verifyGoogleIdToken } from '../../scripts/lib/google-id-token.mjs';

const WHATSAPP_GRAPH_API_VERSION = 'v21.0';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type AuthResult = { ok: true; email: string; name?: string } | { ok: false; status: 401 | 403 | 500; error: string };

// Same short cache rationale as photo-pool.mts: an admin adding a row to the
// allow-list Sheet takes effect almost immediately, without hitting the
// Sheets API on every poll of an active reply session.
const ALLOWED_EMAILS_TTL_MS = 2 * 60 * 1000;
let cachedAllowedEmails: { emails: string[]; expiresAt: number } | null = null;

async function getCachedAllowedEmails(): Promise<string[]> {
  if (cachedAllowedEmails && cachedAllowedEmails.expiresAt > Date.now()) {
    return cachedAllowedEmails.emails;
  }
  const sheetId = process.env.PHOTO_POOL_ALLOWED_EMAILS_SHEET_ID;
  if (!sheetId) throw new Error('Missing PHOTO_POOL_ALLOWED_EMAILS_SHEET_ID');
  const emails = await getAllowedEmails(sheetId);
  cachedAllowedEmails = { emails, expiresAt: Date.now() + ALLOWED_EMAILS_TTL_MS };
  return emails;
}

async function authenticate(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: 'Sign-in required' };

  const clientId = process.env.PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) {
    console.error('Missing PUBLIC_GOOGLE_CLIENT_ID');
    return { ok: false, status: 500, error: 'Server misconfigured' };
  }

  let email: string;
  let name: string | undefined;
  try {
    const payload = await verifyGoogleIdToken(token, { audience: clientId });
    email = String(payload.email).toLowerCase();
    name = typeof payload.name === 'string' ? payload.name : undefined;
  } catch (err) {
    console.error('ID token verification failed', err);
    return { ok: false, status: 401, error: 'Invalid or expired session' };
  }

  try {
    const allowed = await getCachedAllowedEmails();
    if (!allowed.includes(email)) {
      return { ok: false, status: 403, error: 'This Google account is not authorized to use the WhatsApp inbox' };
    }
  } catch (err) {
    console.error('Failed to check the staff allow-list', err);
    return { ok: false, status: 500, error: 'Server misconfigured' };
  }

  return { ok: true, email, name };
}

async function handleConversations(): Promise<Response> {
  try {
    const conversations = await listConversations();
    return jsonResponse({
      conversations: conversations.map((c: any) => ({
        id: c.id,
        waPhone: c.wa_phone,
        displayName: c.display_name,
        lastMessageAt: c.last_message_at,
      })),
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

async function handleReply(req: Request, responderLabel?: string): Promise<Response> {
  let payload: { conversationId?: string; body?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const { conversationId, body } = payload;
  if (!conversationId || !body?.trim()) {
    return jsonResponse({ error: 'conversationId and body are required' }, 400);
  }

  // Multiple staff share one WhatsApp inbox, so sign every outbound message
  // with whoever sent it — pulled from their Google account, no extra typing
  // needed. The signature is part of the actual text sent to the customer
  // (not just internal metadata), so it's included in what's stored too, to
  // keep the thread showing exactly what was sent.
  const signedBody = responderLabel ? `${body}\n\n- ${responderLabel}` : body;

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
    return jsonResponse({ ok: true, message: saved });
  } catch (err) {
    // The WhatsApp send itself succeeded — Meta already delivered it — a
    // failure here only means our own copy wasn't recorded; still report
    // success to the caller since a "failed" state would be misleading.
    console.error('Send succeeded but failed to record the outbound message', err);
    return jsonResponse({ ok: true, message: null });
  }
}

export default async (req: Request): Promise<Response> => {
  const auth = await authenticate(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const url = new URL(req.url);

  if (url.pathname === '/api/whatsapp-admin/conversations' && req.method === 'GET') return handleConversations();
  if (url.pathname === '/api/whatsapp-admin/messages' && req.method === 'GET') return handleMessages(url);
  if (url.pathname === '/api/whatsapp-admin/reply' && req.method === 'POST') return handleReply(req, auth.name ?? auth.email);

  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = {
  path: ['/api/whatsapp-admin/conversations', '/api/whatsapp-admin/messages', '/api/whatsapp-admin/reply'],
};
