// Netlify Function (v2 API) backing SiteSearch.astro's "Ask AI" answer.
// Same grounded-retrieval approach as chat.mts (see lib/site-retrieval.ts),
// but single-shot (no conversation history) and answers from Google's
// Gemini API free tier first, falling back to the same Anthropic API
// chat.mts uses only if Gemini is unset, rate-limited, or erroring - so a
// free-tier hiccup degrades to a paid-but-working answer instead of an
// outright failure.
import {
  selectRelevantPages,
  formatPages,
  matchMembers,
  formatMembers,
  buildLanguageInstruction,
  callAnthropic,
  type SitePage,
} from './lib/site-retrieval';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// Overridable via env var so a future model rename/deprecation doesn't need
// a code change - just a new value in Netlify's env var settings.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const ANTHROPIC_FALLBACK_MODEL = 'claude-sonnet-5';

// A search answer is meant to be a quick, skimmable summary, not a
// conversation - much shorter than the chat widget's 1024, so the free-tier
// Gemini call also finishes well within this function's ~10s Netlify
// execution timeout even before an Anthropic fallback attempt.
const MAX_OUTPUT_TOKENS = 400;
// Search queries are short by nature - capped well below chat's 2000 chars
// to reject anything that's clearly not a search box query (e.g. pasted
// prose), which would otherwise burn retrieval + LLM cost for no benefit.
const MAX_QUERY_LENGTH = 300;
// Gemini's free tier can occasionally hang rather than error outright, and
// this function only has one Anthropic fallback attempt's worth of time
// budget left after it - abandon the Gemini attempt well before that
// budget runs out instead of risking both calls timing out.
const GEMINI_TIMEOUT_MS = 6_000;

const SEARCH_INSTRUCTIONS = `You are answering a single search query typed into the site search box on the Tamarind Valley Collective (TVC) website (tvc.farm), a 100-acre permaculture farm community near Kanakapura, India.

Answer ONLY using the WEBSITE CONTENT provided below. Do not use any outside knowledge, and do not guess or make up details that aren't in this content. If the content doesn't answer the query, say plainly that you don't have that information on the site rather than guessing.

Keep the answer short and direct - 1 to 3 sentences, not a conversation. Mention which page the information came from when helpful.`;

interface AiSearchSource {
  title: string;
  url: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function toSources(pages: SitePage[]): AiSearchSource[] {
  return pages.slice(0, 3).map((p) => ({ title: p.title, url: p.url }));
}

// Returns the answer text, or null on any failure (missing key, network
// error, non-2xx response, or a safety/other block with no candidate) - the
// caller treats null as "try the Anthropic fallback instead," so this never
// throws.
async function callGemini(apiKey: string, systemText: string, query: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(`${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts: [{ text: query }] }],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn('[search-ai] Gemini API error', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    if (data.promptFeedback?.blockReason) {
      console.warn('[search-ai] Gemini blocked the request', data.promptFeedback.blockReason);
      return null;
    }

    const parts = data.candidates?.[0]?.content?.parts as { text?: string }[] | undefined;
    const text = parts?.map((p) => p.text ?? '').join('') ?? '';
    return text.trim() || null;
  } catch (err) {
    console.warn('[search-ai] Gemini call failed', err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let payload: { query?: string; lang?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const query = (payload.query ?? '').trim();
  if (!query) {
    return jsonResponse({ error: 'query is required' }, 400);
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return jsonResponse({ error: 'Query is too long.' }, 400);
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !anthropicKey) {
    console.error('[search-ai] Neither GEMINI_API_KEY nor ANTHROPIC_API_KEY is set');
    return jsonResponse({ error: 'AI search is not configured yet.' }, 500);
  }

  const relevantPages = selectRelevantPages(query);
  const memberBlock = formatMembers(matchMembers(query));
  const dynamicContent = [
    `--- WEBSITE CONTENT START ---\n${formatPages(relevantPages)}\n--- WEBSITE CONTENT END ---`,
    memberBlock,
  ]
    .filter(Boolean)
    .join('\n\n');
  const languageInstruction = buildLanguageInstruction(payload.lang ?? 'en');
  const sources = toSources(relevantPages);

  if (geminiKey) {
    const systemText = [SEARCH_INSTRUCTIONS, dynamicContent, languageInstruction].join('\n\n');
    const reply = await callGemini(geminiKey, systemText, query);
    if (reply) {
      return jsonResponse({ reply, sources, provider: 'gemini' });
    }
  }

  if (!anthropicKey) {
    // Gemini was the only option and it just failed.
    return jsonResponse({ error: 'AI search is having trouble right now. Please try again shortly.' }, 502);
  }

  try {
    const result = await callAnthropic({
      apiKey: anthropicKey,
      model: ANTHROPIC_FALLBACK_MODEL,
      maxTokens: MAX_OUTPUT_TOKENS,
      system: [
        { type: 'text', text: SEARCH_INSTRUCTIONS },
        { type: 'text', text: dynamicContent },
        { type: 'text', text: languageInstruction },
      ],
      messages: [{ role: 'user', content: query }],
    });

    if (!result.ok) {
      console.error('[search-ai] Anthropic fallback error', result.status, result.errorType);
      return jsonResponse({ error: 'AI search is having trouble right now. Please try again shortly.' }, 502);
    }

    if (!result.text) {
      return jsonResponse({ error: "Couldn't come up with an answer to that." }, 502);
    }

    return jsonResponse({ reply: result.text, sources, provider: 'anthropic' });
  } catch (err) {
    console.error('[search-ai] Unexpected error', err);
    return jsonResponse({ error: 'Something went wrong. Please try again.' }, 500);
  }
};

export const config = {
  path: '/api/search-ai',
};
