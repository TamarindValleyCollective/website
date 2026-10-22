// Jev (TypeSafe System One) reads of inbound WhatsApp messages: the questions,
// how a conversation becomes Jev's state, and how its answers become a row for
// whatsapp_message_assessments (migration 0057). Pure apart from askJev(), so
// the rest is unit-tested (whatsapp-assess.test.mjs).
//
// SHADOW MODE: the result is only stored. Nothing an admin sees and nothing a
// guest receives depends on it; see WHATSAPP.md ("Jev message reads").

const API_URL = 'https://api.typesafe.ai/v1/systemone';

// A versioned id, never the jev-latest alias: an alias moves when TypeSafe
// ships a release, which would silently change the reads we are evaluating.
// Override with TYPESAFE_MODEL when deliberately trying a newer version.
export const DEFAULT_MODEL = 'jev-1.14.0';

// Bump when any question's wording or option list changes, so reads made with
// different questions are never compared as if they were the same.
export const QUESTION_VERSION = 1;

// Message types that carry something a guest typed or tapped. Photos, voice
// notes and stickers read as "[image message]" in the inbox, which Jev cannot
// judge, so they are not assessed.
const ASSESSABLE_TYPES = new Set(['text', 'button', 'interactive']);

export const INTENTS = {
  visiting: 'Asks about visiting the farm for the day: directions, parking, timings, what to bring, whether it is open, or how to arrange a visit.',
  stay: 'Asks about staying overnight (rooms, huts, tents, camping), availability, or a booking they have made for a stay.',
  event: 'Asks about an event, workshop, festival or programme, or a ticket or registration for one.',
  membership: 'Asks about the community: becoming a member, buying or visiting land, or something about their own membership.',
  payment: 'Raises a payment, refund, receipt, invoice or UPI problem.',
  complaint: 'Is unhappy about something that happened, or reports a problem.',
  volunteering_or_work: 'Asks about volunteering, internships, farm work, selling produce or a business collaboration.',
  thanks_or_acknowledgement: 'Only thanks us, confirms, says okay or sends a greeting or emoji, with nothing left to answer.',
  other: 'Anything else, or too unclear to place.',
};

export const LANGUAGES = {
  english: 'Mostly English.',
  kannada: 'Mostly Kannada, in Kannada script or written in Roman letters.',
  tamil: 'Mostly Tamil, in Tamil script or written in Roman letters.',
  hindi: 'Mostly Hindi, in Devanagari or written in Roman letters.',
  other: 'Another language, or only emoji, numbers or a name.',
};

const URGENCY_LEVELS = [
  'Can wait until the next working day: a general question or an idle chat.',
  'Should be answered within a few hours: the guest is planning something soon or is waiting on an answer.',
  'Needs a person right now: a guest who is on the way or at the farm, a payment that has gone wrong, or someone upset, unwell or in difficulty.',
];

export function buildQuestions() {
  return {
    intent: {
      type: 'choice',
      instructions: "What is the main thing the guest wants in `latest_guest_message`? Use `conversation` only to understand it (for example a bare 'yes' answers TVC's last question).",
      criteria: INTENTS,
    },
    language: {
      type: 'choice',
      instructions: 'Which language is `latest_guest_message` written in?',
      criteria: LANGUAGES,
    },
    urgency: {
      type: 'score',
      instructions: 'How soon does a person at TVC need to answer `latest_guest_message`?',
      criteria: URGENCY_LEVELS,
    },
    needs_reply: {
      type: 'noul',
      instructions:
        "Does `latest_guest_message` contain a question, a request or a problem that a person at TVC still needs to respond to? A complaint or a report that something went wrong needs a response even when it asks nothing. A message that only says thanks, okay or goodbye, or only answers a question TVC already asked in `conversation` and asks for nothing more, does not.",
    },
  };
}

// State for Jev: named fields, because the conversation and the one message
// being judged play different roles. `transcript` is one line per message,
// "Guest: ..." or "TVC: ...", oldest first (buildTranscript in
// netlify/functions/lib/whatsapp-suggest.ts strips names and signatures).
export function buildState(transcript, latestGuestMessage) {
  return {
    about:
      'A WhatsApp chat between a guest and the team at Tamarind Valley Collective (TVC), a permaculture farm community with day visits, overnight stays, events and a land-owning membership.',
    conversation: transcript,
    latest_guest_message: latestGuestMessage,
  };
}

export function isAssessable(messageType, body) {
  return ASSESSABLE_TYPES.has(messageType) && typeof body === 'string' && body.trim().length > 0;
}

const isFraction = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

// Jev's response -> the columns of whatsapp_message_assessments, or null when
// anything is missing or out of range. Typed output guarantees the shape, not
// that this account's response matches what we asked; rejecting here keeps one
// odd response from storing a misleading row.
export function parseAnswers(response) {
  const a = response?.answers;
  if (!a || typeof response.model !== 'string') return null;

  const intent = a.intent?.choice;
  const language = a.language?.choice;
  const urgency = a.urgency?.score;
  const needsReply = a.needs_reply?.noul;

  if (!Object.hasOwn(INTENTS, intent) || !Object.hasOwn(LANGUAGES, language)) return null;
  if (typeof urgency !== 'number' || !Number.isFinite(urgency) || urgency < 0 || urgency > URGENCY_LEVELS.length - 1) return null;
  if (!isFraction(needsReply)) return null;

  return {
    model: response.model,
    question_version: QUESTION_VERSION,
    intent,
    intent_confidence: isFraction(a.intent.confidence) ? a.intent.confidence : null,
    intent_probabilities: a.intent.probabilities ?? null,
    language,
    language_confidence: isFraction(a.language.confidence) ? a.language.confidence : null,
    urgency,
    urgency_confidence: isFraction(a.urgency.confidence) ? a.urgency.confidence : null,
    needs_reply: needsReply,
    input_tokens: Number.isInteger(response.usage?.input_tokens) ? response.usage.input_tokens : null,
  };
}

// One call to Jev. Never throws: a timeout, a network error or a non-200 comes
// back as { ok: false, reason } so the caller can count it and move on.
export async function askJev({ apiKey, model = DEFAULT_MODEL, state, questions, timeoutMs = 3000, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    return { ok: true, response: await res.json() };
  } catch (err) {
    return { ok: false, reason: err?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}
