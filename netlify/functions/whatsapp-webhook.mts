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
import { upsertConversation, insertMessage, updateTemplateSendStatus, templateSendExists, claimAutoAck } from '../../scripts/lib/supabase.mjs';
import { getPaymentById } from '../../scripts/lib/event-payments-db.mjs';
import { sendStaffAlert, escapeHtml } from './lib/refund-alert';
import { sendWhatsAppText } from './lib/whatsapp-send';
import { autoAckText, isOutsideHours, shouldAutoAck } from './lib/whatsapp-autoack';

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
  // Tap on a template's quick-reply button.
  button?: { text?: string; payload?: string };
  // Tap on a reply button / list row of an interactive message we sent.
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  location?: { name?: string; address?: string };
  // Present when the conversation started from a Click-to-WhatsApp ad or an
  // Instagram/Facebook entry point.
  referral?: { source_type?: string; source_id?: string; source_url?: string; headline?: string };
}

interface WhatsAppContact {
  profile?: { name?: string };
  wa_id: string;
}

// Deliberately does not catch its own errors — a persistence failure here
// must propagate so the handler below can return a non-2xx status and let
// Meta retry the delivery. insertMessage() dedupes on wa_message_id (see
// scripts/lib/supabase.mjs), so re-processing an already-persisted message
// on retry is a safe no-op rather than a duplicate.
async function persistIncomingMessage(message: WhatsAppMessage, contact: WhatsAppContact | undefined): Promise<{ id: string }> {
  const conversation = await upsertConversation({
    waPhone: message.from,
    displayName: contact?.profile?.name,
    lastMessageAt: new Date(Number(message.timestamp) * 1000).toISOString(),
    referral: message.referral
      ? {
          sourceType: message.referral.source_type,
          sourceId: message.referral.source_id,
          sourceUrl: message.referral.source_url,
          headline: message.referral.headline,
        }
      : null,
  });
  await insertMessage({
    conversationId: conversation.id,
    direction: 'inbound',
    body: describeMessage(message),
    waMessageId: message.id,
  });
  return conversation;
}

// What the inbox shows for an inbound message. Taps on our template/
// interactive buttons are real answers ("I need help"), so they read as text
// rather than an opaque "[button message]".
function describeMessage(message: WhatsAppMessage): string {
  switch (message.type) {
    case 'text':
      return message.text?.body ?? '';
    case 'button':
      return `[Tapped button] ${message.button?.text ?? message.button?.payload ?? ''}`.trim();
    case 'interactive': {
      const title = message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;
      return title ? `[Selected] ${title}` : '[interactive reply — not shown here]';
    }
    case 'location':
      return `[Shared a location] ${[message.location?.name, message.location?.address].filter(Boolean).join(', ')}`.trim();
    default:
      return `[${message.type} message — not shown here]`;
  }
}

// Replies to the guest outside staffed hours (WHATSAPP_AUTOACK_ENABLED=true,
// hours in WHATSAPP_AUTOACK_HOURS, IST). At most one per conversation per 12
// hours, claimed atomically in the DB so Meta's duplicate deliveries can't
// send two. Never throws: an auto-reply is a courtesy, and a failure here
// must not make Meta retry the whole batch.
async function maybeAutoAck(message: WhatsAppMessage, conversation: { id: string }): Promise<void> {
  try {
    if (process.env.WHATSAPP_AUTOACK_ENABLED !== 'true') return;
    if (!shouldAutoAck(message.type)) return;
    // A delayed retry of an old message shouldn't trigger a reply now.
    if (Date.now() - Number(message.timestamp) * 1000 > 10 * 60_000) return;
    if (!isOutsideHours(new Date(), process.env.WHATSAPP_AUTOACK_HOURS)) return;
    if (!(await claimAutoAck(conversation.id))) return;

    const body = autoAckText(process.env.WHATSAPP_AUTOACK_HOURS);
    const sent = await sendWhatsAppText(message.from, body);
    await insertMessage({
      conversationId: conversation.id,
      direction: 'outbound',
      body: `[Auto-reply] ${body}`,
      waMessageId: sent.ok ? (sent.waMessageId ?? undefined) : undefined,
      status: sent.ok ? 'sent' : 'failed',
      errorMessage: sent.ok ? undefined : sent.error,
    });
  } catch (err) {
    console.error('[whatsapp-webhook] Auto-reply failed', err);
  }
}

// A delivery receipt for a template message. Records the new status; when it
// is a FAILURE for a guest-facing template (typically: the number isn't on
// WhatsApp), emails staff — the guest then only has the email, and nothing
// else would tell anyone. The alert for a test-mode booking goes to the test
// inbox only, like every other test-booking email.
async function handleDeliveryStatus(status: any): Promise<void> {
  const waMessageId: string | undefined = status?.id;
  const state: string | undefined = status?.status;
  if (!waMessageId || !['sent', 'delivered', 'read', 'failed'].includes(state ?? '')) return;
  const error = Array.isArray(status.errors) ? status.errors[0] : undefined;
  const update = async () =>
    (await updateTemplateSendStatus({
      waMessageId,
      status: state as 'sent' | 'delivered' | 'read' | 'failed',
      errorCode: error?.code != null ? String(error.code) : null,
      errorMessage: error ? [error.title, error.message, error.error_data?.details].filter(Boolean).join(' — ') : null,
      statusAt: status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : null,
    })) as Record<string, any> | null;
  let updated = await update();
  // The receipt can arrive before whatsapp-send.ts has recorded the wamid it
  // just got back from Meta. If the row isn't there yet, give that insert a
  // moment and try once more, so an early failure isn't silently lost. Only
  // for failures: other statuses are just display, and replies sent from the
  // inbox also produce receipts that will never have a row.
  if (!updated && state === 'failed' && !(await templateSendExists(waMessageId))) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    updated = await update();
  }
  if (!updated || state !== 'failed' || !updated.event_payment_id) return;

  const booking = (await getPaymentById(updated.event_payment_id)) as Record<string, any> | null;
  const isTest = booking?.mode === 'test';
  await sendStaffAlert(
    `⚠️ WhatsApp message not delivered — ${booking?.event_title ?? updated.template}`,
    `<p>The WhatsApp message <code>${escapeHtml(String(updated.template).replace(/_v2$/, ''))}</code> to <strong>${escapeHtml(booking?.payer_name ?? 'a guest')}</strong> (number ending ${escapeHtml(updated.recipient_last4 ?? '?')}) was <strong>not delivered</strong>.</p>
  <p style="color:#8a2f1f;">${escapeHtml(updated.error_message ?? 'WhatsApp reported the message as failed.')}</p>
  <p>They will have received the email only. Check the number on <a href="https://tvc.farm/internal/event-payments">the Event Payments dashboard</a> and contact them another way if it matters.</p>`,
    isTest,
  );
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
            const conversation = await persistIncomingMessage(message, contact);
            await maybeAutoAck(message, conversation);
          }
        } else if (change?.field === 'messages' && Array.isArray(value.statuses)) {
          // Delivery receipts for messages WE sent (sent → delivered → read,
          // or failed). Only template messages are tracked (see
          // whatsapp_template_sends); a status for anything else matches no
          // row and is ignored. Errors here are logged, not thrown — a
          // tracking hiccup must not make Meta retry the whole batch.
          for (const status of value.statuses) {
            await handleDeliveryStatus(status).catch((err) => console.error('[whatsapp-webhook] Failed to record delivery status', err));
          }
        } else if (change?.field === 'message_template_status_update') {
          // Low-volume, infrequent — logged only for now rather than also
          // emailed; worth revisiting once templates are actually submitted.
          console.log('[whatsapp-webhook] Template status update:', JSON.stringify(value));
        }
      }
    }
  } catch (err) {
    // A failure anywhere in this loop — today, that's exclusively a
    // persistence failure in persistIncomingMessage() — must not be
    // acknowledged as delivered: return non-2xx so Meta retries. Safe to
    // retry the whole batch since insertMessage() ignores duplicates by
    // wa_message_id, so messages that already persisted successfully in
    // this batch won't be double-written.
    console.error('[whatsapp-webhook] Error processing webhook payload', err);
    return jsonResponse({ error: 'Failed to process webhook payload' }, 500);
  }

  return jsonResponse({ ok: true });
};

export const config = {
  path: '/api/whatsapp-webhook',
};
