// Shared retrieval + Anthropic-call plumbing for both AI-backed endpoints
// that ground themselves in the site's own content: chat.mts (the chat
// widget) and search-ai.mts (the site search's "Ask AI" answer). Kept in one
// place so the keyword-retrieval scoring and the Claude response-parsing
// quirk (see callAnthropic below) can't drift between the two call sites.
import siteContent from '../site-content.json' with { type: 'json' };
import { members, type Member } from '../../../src/data/members';

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export interface SitePage {
  url: string;
  title: string;
  text: string;
}

export const LANGUAGE_NAMES: Record<string, string> = { en: 'English', kn: 'Kannada', ta: 'Tamil' };

// Always included regardless of query match, so generic/greeting questions
// still have some grounding even when nothing in particular scores well
// against the user's own words.
const CORE_PAGE_URLS = ['/', '/about', '/visit', '/people'];

// Caps how many non-core pages get pulled in, and a hard character budget
// across the whole selection (a couple of the longer event writeups run
// 7-10k chars each, so even a few unlucky matches plus the core set could
// still add up) - keeps every request's prompt small regardless of how
// much content the site accumulates.
const MAX_RETRIEVED_PAGES = 5;
const MAX_CORPUS_CHARS = 45_000;

// Common English function words - without filtering these, a query like
// "What is the refund policy for camping?" scores almost entirely on "the"/
// "for"/"what"/"about", which favors whichever page happens to be longest
// over whichever page is actually relevant (verified: that exact query
// pulled in a 7k-char event writeup instead of /refund-policy or
// /visit/camping before this filter existed).
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'that',
  'this', 'from', 'have', 'has', 'had', 'was', 'were', 'will', 'can',
  'about', 'what', 'when', 'where', 'why', 'how', 'who', 'which', 'does',
  'did', 'doing', 'there', 'their', 'they', 'them', 'his', 'her', 'its',
  'our', 'out', 'into', 'than', 'then', 'also', 'just', 'like', 'get',
  'got', 'one', 'all', 'any', 'some', 'more', 'most', 'been', 'being',
  'here', 'tell', 'know', 'want', 'need', 'please', 'thanks', 'hello', 'hey',
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

// Crude keyword-overlap scoring, not real search - fine at this site's
// scale (~50 pages, none very long). A query word appearing in the page's
// own title is a much stronger relevance signal than one appearing
// somewhere in a long page of prose, hence the heavier title weight.
function scorePage(page: SitePage, queryWords: string[]): number {
  const titleWords = tokenize(page.title);
  const bodyLower = page.text.toLowerCase();
  let score = 0;
  for (const word of queryWords) {
    if (titleWords.includes(word)) score += 5;
    score += bodyLower.split(word).length - 1;
  }
  return score;
}

export function selectRelevantPages(query: string): SitePage[] {
  const pages: SitePage[] = siteContent.pages;
  const core = pages.filter((p) => CORE_PAGE_URLS.includes(p.url));
  const queryWords = tokenize(query);

  const ranked = pages
    .filter((p) => !CORE_PAGE_URLS.includes(p.url))
    .map((page) => ({ page, score: scorePage(page, queryWords) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RETRIEVED_PAGES)
    .map(({ page }) => page);

  // Core pages are never dropped for budget - only ranked matches are, and
  // lowest-ranked first, so a couple of long pages can't silently push out
  // the baseline every question relies on.
  let total = core.reduce((sum, p) => sum + p.text.length, 0);
  const selected = [...core];
  for (const page of ranked) {
    if (total + page.text.length > MAX_CORPUS_CHARS) continue;
    selected.push(page);
    total += page.text.length;
  }
  return selected;
}

export function formatPages(pages: SitePage[]): string {
  return pages.map((p) => `## ${p.title} (${p.url})\n${p.text}`).join('\n\n');
}

// Member cards' family/why-TVC/social fields only ever render client-side
// from a JSON blob the popup fills in on click (see MembersView.astro) -
// they're never present as static text on the page, so
// build-chat-context.mjs's HTML scrape (which only sees rendered markup)
// never picks them up, no matter how selectRelevantPages() above is tuned.
// Matching directly against this same member data (the source the site's
// own search-jump-to-card lookup also reads, see SiteSearch.astro's
// searchMembers()) fills that gap without needing the corpus to somehow
// contain content that's never actually static HTML.
export function matchMembers(query: string): Member[] {
  const q = query.toLowerCase();
  return members
    .filter((m) => {
      if (q.includes(m.name.toLowerCase())) return true;
      const firstNames = m.name.split('&').map((p) => p.trim().split(/\s+/)[0]);
      return firstNames.some((n) => n.length >= 3 && new RegExp(`\\b${n.toLowerCase()}\\b`).test(q));
    })
    .slice(0, 3);
}

export function formatMembers(matched: Member[]): string {
  if (!matched.length) return '';
  const blocks = matched.map((m) => {
    const lines = [`## Member: ${m.name}`];
    if (m.bio) lines.push(`What they do: ${m.bio}`);
    if (m.family) lines.push(`Family: ${m.family}`);
    const quotes = Array.isArray(m.whyTVC) ? m.whyTVC : m.whyTVC ? [m.whyTVC] : [];
    if (quotes.length) lines.push(`Why they're part of TVC: ${quotes.join(' / ')}`);
    if (m.social?.length) lines.push(`Social: ${m.social.join(', ')}`);
    return lines.join('\n');
  });
  return `--- MATCHED MEMBER PROFILES (from the Members page's full data, including fields only shown in its popup) ---\n${blocks.join('\n\n')}`;
}

// The site itself is in the middle of being translated into Kannada/Tamil
// (see src/i18n/) - the corpus stays English-only (it's generated from the
// site's English content), but the model is perfectly capable of answering
// in another language while grounding itself in that same English source,
// so there's no need to wait for the corpus itself to be translated.
export function buildLanguageInstruction(lang: string): string {
  const languageName = LANGUAGE_NAMES[lang] ?? 'English';
  return `Respond in ${languageName}, regardless of the language the WEBSITE CONTENT above happens to be written in.`;
}

export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AnthropicCallResult =
  | { ok: true; text: string }
  | { ok: false; status: number; errorType?: string };

// Centralizes the Anthropic request/response shape so both call sites parse
// the reply the same way. Not always content[0] - Claude Sonnet 5 sometimes
// leads with a `thinking` block (even on requests that never ask for
// extended thinking) before the actual `text` block, more often on
// follow-up messages than the first one. Only checking index 0 previously
// meant a real answer sitting at content[1] got silently discarded -
// confirmed via a raw API call reproducing exactly this shape.
export async function callAnthropic(params: {
  apiKey: string;
  model: string;
  maxTokens: number;
  system: AnthropicSystemBlock[];
  messages: AnthropicMessage[];
}): Promise<AnthropicCallResult> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': params.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    let errorType: string | undefined;
    try {
      errorType = JSON.parse(errText)?.error?.type;
    } catch {
      // not JSON - errorType stays undefined, caller falls back to a generic message
    }
    return { ok: false, status: res.status, errorType };
  }

  const data = await res.json();
  const textBlock = data.content?.find((block: { type: string }) => block.type === 'text');
  return { ok: true, text: textBlock?.text ?? '' };
}
