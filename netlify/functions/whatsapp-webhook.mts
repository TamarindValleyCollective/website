// Netlify Function (v2 API) — the WhatsApp Cloud API webhook endpoint. See
// WHATSAPP.md for the full setup checklist/context; this is Phase 4's first
// piece: receiving inbound events. Meta calls this endpoint two ways:
//
// 1. GET, once, when the webhook URL is registered/re-verified in the Meta
//    App Dashboard (WhatsApp → Configuration → Webhooks) — a handshake
//    proving we control this URL. Meta sends hub.mode/hub.verify_token/
//    hub.challenge as query params; we must echo back hub.challenge
//    verbatim (as plain text, not JSON) if hub.verify_token matches our own
//    WHATSAPP_VERIFY_TOKEN, an arbitrary string we chose ourselves (not a
//    Meta-issued secret) and entered in both places.
// 2. POST, on every subscribed event afterward — new messages, and message
//    template approval/rejection updates. Each POST carries an
//    X-Hub-Signature-256 header (HMAC-SHA256 over the *raw* request body,
//    using the Meta app's App Secret) that must be verified before trusting
//    the payload, since this URL is public and unauthenticated otherwise.
//
// Meta's Cloud API gives WhatsApp Business numbers no inbox of their own —
// confirmed by checking every tab in WhatsApp Manager and Meta's own docs,
// see WHATSAPP.md's Phase 4 notes. Without something surfacing incoming
// messages, they'd land here and go nowhere. Every inbound message is
// persisted to Supabase (see scripts/lib/supabase.mjs) so /internal/whatsapp
// (netlify/functions/whatsapp-admin.mts) can show and reply to it.
//
// This used to also email core-team@tvc.farm on every single message —
// removed 2026-08-20 in favor of whatsapp-stale-alert.mts's 60-minute
// unanswered-message digest, once per-message emails turned out to be more
// clutter than signal for a shared inbox multiple staff check.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { upsertConversation, insertMessage } from '../../scripts/lib/supabase.mjs';

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const provided = header.slice('sha256='.length);
  // Lengths can differ if the header is malformed/truncated — guard before
  // timingSafeEqual, which throws (rather than returning false) on a length
  // mismatch instead of comparing.
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}

interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
}

interface WhatsAppContact {
  profile?: { name?: string };
  wa_id: string;
}

async function persistIncomingMessage(message: WhatsAppMessage, contact: WhatsAppContact | undefined): Promise<void> {
  try {
    const bodyText = message.type === 'text' ? (message.text?.body ?? '') : `[${message.type} message — not shown here]`;
    const conversation = await upsertConversation({
      waPhone: message.from,
      displayName: contact?.profile?.name,
      lastMessageAt: new Date(Number(message.timestamp) * 1000).toISOString(),
    });
    await insertMessage({
      conversationId: conversation.id,
      direction: 'inbound',
      body: bodyText,
      waMessageId: message.id,
    });
  } catch (err) {
    console.error('[whatsapp-webhook] Failed to persist inbound message', err);
  }
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!verifyToken) {
      console.error('[whatsapp-webhook] WHATSAPP_VERIFY_TOKEN is not set');
      return textResponse('Server misconfigured', 500);
    }
    if (mode === 'subscribe' && token === verifyToken && challenge) {
      return textResponse(challenge);
    }
    return textResponse('Forbidden', 403);
  }

  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    console.error('[whatsapp-webhook] WHATSAPP_APP_SECRET is not set');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  // Read the raw body once, before any JSON parsing — the signature is an
  // HMAC over these exact bytes, so re-serializing a parsed object would
  // never match Meta's signature even for genuinely unmodified payloads.
  const rawBody = await req.text();
  if (!verifySignature(rawBody, req.headers.get('x-hub-signature-256'), appSecret)) {
    console.error('[whatsapp-webhook] Signature verification failed');
    return jsonResponse({ error: 'Invalid signature' }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  try {
    const entries = payload?.entry ?? [];
    for (const entry of entries) {
      const changes = entry?.changes ?? [];
      for (const change of changes) {
        const value = change?.value ?? {};
        if (change?.field === 'messages' && Array.isArray(value.messages)) {
          const contactsByWaId = new Map<string, WhatsAppContact>((value.contacts ?? []).map((c: WhatsAppContact) => [c.wa_id, c]));
          for (const message of value.messages as WhatsAppMessage[]) {
            const contact = contactsByWaId.get(message.from);
            await persistIncomingMessage(message, contact);
          }
        } else if (change?.field === 'message_template_status_update') {
          // Low-volume, infrequent — logged only for now rather than also
          // emailed; worth revisiting once templates are actually submitted.
          console.log('[whatsapp-webhook] Template status update:', JSON.stringify(value));
        }
      }
    }
  } catch (err) {
    // Meta retries on non-2xx, which would resend every message in this
    // batch again — but our own bug in notification-sending shouldn't
    // repeatedly re-deliver the same underlying WhatsApp message from
    // Meta's side. Log and still return 200; this is a visibility gap to
    // watch for in function logs, not a reason to trigger retries.
    console.error('[whatsapp-webhook] Error processing webhook payload', err);
  }

  return jsonResponse({ ok: true });
};

export const config = {
  path: '/api/whatsapp-webhook',
};
