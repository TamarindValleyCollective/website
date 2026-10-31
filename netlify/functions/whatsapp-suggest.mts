// Netlify Function (v2 API) behind the WhatsApp inbox's "Suggest reply" button
// (src/pages/internal/whatsapp.astro). Given a conversation, drafts a reply for a
// admin to read, edit and send. It never sends anything itself.
//
// Grounded the same way as the site's chat widget: the draft may only use the
// site's own pages (lib/site-retrieval.ts), so it can't invent prices, dates or
// policies. Anything it can't answer, or that touches a booking, cancellation or
// refund, comes back flagged "needs staff" with a plain-language reason.
//
// Privacy: the model sees only the text of the recent conversation labelled "Guest"
// and "TVC": no names, no phone numbers, no admin signatures (lib/whatsapp-suggest.ts).
// Which AI service reads it is WHATSAPP_SUGGEST_PROVIDER: "anthropic" (default) or
// "gemini" (Google first, Anthropic if Google fails, as search-ai.mts does).
// Google's FREE tier lets Google use submitted content to improve its products and
// have people review it, which is why this is opt-in rather than the default for
// guests' private messages; see WHATSAPP.md before switching it.
//
// Gated like the rest of the inbox: Google sign-in + the `reply` capability of the
// `whatsapp` module. Per-staff and daily limits cap the spend.
import { listMessages, getConversation } from '../../scripts/lib/supabase.mjs';
import { logStaffAction } from './lib/staff-access';
import { authorizeInbox, canReach } from './lib/whatsapp-scope';
import { selectRelevantPages, formatPages, callAnthropic, type SitePage } from './lib/site-retrieval';
import { checkIpRateLimit, checkDailyCap } from './lib/rate-limit';
import { recordUsage } from './lib/usage-meter';
import { SUGGEST_INSTRUCTIONS, buildTranscript, parseSuggestion, sanitizeDraft, callGemini, type TranscriptMessage } from './lib/whatsapp-suggest';

const ANTHROPIC_MODEL = 'claude-sonnet-5';
const MAX_OUTPUT_TOKENS = 600;

// An admin tool, so limits are about runaway spend rather than abuse: one person
// can't loop it, and a daily ceiling bounds the worst case. A request costs about
// as much as a chat message (the retrieved site pages are most of the prompt).
const RATE_LIMIT_STORE = 'whatsapp-suggest-rate-limit';
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 15;
const DAILY_CAP = 80;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// A Blobs outage shouldn't lock admins out of a drafting aid: fail open and log.
async function allowed(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch (err) {
    console.error('[whatsapp-suggest] Rate limiter unavailable, allowing request', err);
    return true;
  }
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  // Same scope rules as the inbox it serves (?scope=, lib/whatsapp-scope.ts).
  const auth = await authorizeInbox(req, new URL(req.url).searchParams.get('scope'), 'reply');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const staff = auth.access.staff;

  let payload: { conversationId?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }
  if (!payload.conversationId) return jsonResponse({ error: 'conversationId is required' }, 400);
  if (auth.access.phones) {
    const conversation = await getConversation(payload.conversationId).catch(() => null);
    if (!conversation || !canReach(auth.access, conversation.wa_phone)) return jsonResponse({ error: 'Conversation not found' }, 404);
  }

  if (!(await allowed(() => checkIpRateLimit(RATE_LIMIT_STORE, staff.id, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS)))) {
    return jsonResponse({ error: 'Too many suggestions in a short time. Try again in a few minutes.' }, 429);
  }
  if (!(await allowed(() => checkDailyCap(RATE_LIMIT_STORE, 'daily', DAILY_CAP)))) {
    console.warn('[whatsapp-suggest] Daily cap reached');
    return jsonResponse({ error: "Today's limit for suggested replies has been reached. Please reply by hand." }, 429);
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiFirst = (process.env.WHATSAPP_SUGGEST_PROVIDER ?? 'anthropic').trim().toLowerCase() === 'gemini';
  if (!anthropicKey && !(geminiFirst && geminiKey)) {
    console.error('[whatsapp-suggest] No AI key configured for the chosen provider');
    return jsonResponse({ error: 'Suggested replies are not set up yet.' }, 500);
  }

  let rows: any[];
  try {
    rows = await listMessages(payload.conversationId, { limit: 60 });
  } catch (err) {
    console.error('[whatsapp-suggest] Failed to read the conversation', err);
    return jsonResponse({ error: 'Failed to reach the message store' }, 502);
  }
  const messages: TranscriptMessage[] = rows.map((m) => ({ direction: m.direction, body: String(m.body ?? '') }));
  const guestMessages = messages.filter((m) => m.direction === 'inbound');
  if (guestMessages.length === 0) return jsonResponse({ error: 'There is no message from the guest to reply to yet.' }, 400);

  // What the guest has been asking about picks which site pages ground the draft.
  const query = guestMessages.slice(-3).map((m) => m.body).join(' ');
  const pages = selectRelevantPages(query);
  const systemContent = `--- WEBSITE CONTENT START ---\n${formatPages(pages)}\n--- WEBSITE CONTENT END ---`;
  const userText = `<conversation>\n${buildTranscript(messages)}\n</conversation>\n\nWrite the next reply from TVC as the JSON object described in your instructions.`;

  let raw: string | null = null;
  let provider: 'gemini' | 'anthropic' = 'anthropic';

  if (geminiFirst && geminiKey) {
    raw = await callGemini(geminiKey, `${SUGGEST_INSTRUCTIONS}\n\n${systemContent}`, userText, MAX_OUTPUT_TOKENS);
    if (raw) provider = 'gemini';
    else await recordUsage('gemini', { fallbacks_to_anthropic: anthropicKey ? 1 : 0 });
  }

  if (!raw) {
    if (!anthropicKey) return jsonResponse({ error: 'Could not draft a reply right now. Please reply by hand.' }, 502);
    try {
      const result = await callAnthropic({
        apiKey: anthropicKey,
        model: ANTHROPIC_MODEL,
        maxTokens: MAX_OUTPUT_TOKENS,
        system: [
          { type: 'text', text: SUGGEST_INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: systemContent },
        ],
        messages: [{ role: 'user', content: userText }],
      });
      if (!result.ok) {
        console.error('[whatsapp-suggest] Anthropic error', result.status, result.errorType);
        return jsonResponse(
          { error: result.errorType === 'billing_error' ? 'The AI service is out of credit. Please reply by hand.' : 'Could not draft a reply right now. Please reply by hand.' },
          502,
        );
      }
      raw = result.text;
      provider = 'anthropic';
    } catch (err) {
      console.error('[whatsapp-suggest] Unexpected error', err);
      return jsonResponse({ error: 'Could not draft a reply right now. Please reply by hand.' }, 502);
    }
  }

  const suggestion = parseSuggestion(raw);
  if (!suggestion) return jsonResponse({ error: "Couldn't come up with a draft for this one. Please reply by hand." }, 502);
  const { draft, removedLink } = sanitizeDraft(suggestion.draft);
  if (!draft) return jsonResponse({ error: "Couldn't come up with a draft for this one. Please reply by hand." }, 502);

  // Sources the admin can check the draft against: only pages that were
  // actually given to the model (a made-up path is dropped).
  const given = new Map<string, SitePage>(pages.map((p) => [p.url, p]));
  const sources = suggestion.pages
    .map((p) => given.get(p.replace(/^https?:\/\/(www\.)?tvc\.farm/i, '').split(/[?#]/)[0] || '/'))
    .filter((p): p is SitePage => Boolean(p))
    .filter((p, i, all) => all.indexOf(p) === i)
    .slice(0, 3)
    .map((p) => ({ title: p.title, url: p.url }));

  // Routine and best-effort: who asked, never what was said or drafted.
  logStaffAction({ actorId: staff.id, action: 'whatsapp.suggest_reply', module: 'whatsapp', detail: { conversationId: payload.conversationId } }).catch((err: unknown) =>
    console.error('[whatsapp-suggest] Failed to write staff audit log', err),
  );

  return jsonResponse({
    draft,
    needsStaff: suggestion.needsStaff || removedLink,
    reason: removedLink ? `${suggestion.reason ? `${suggestion.reason} ` : ''}A link to another site was removed from the draft.`.trim() : suggestion.reason,
    sources,
    provider,
  });
};

export const config = {
  path: '/api/whatsapp-suggest',
};
