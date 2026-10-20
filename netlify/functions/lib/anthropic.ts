// Shared Anthropic Messages API call: used by chat.mts and search-ai.mts (through
// site-retrieval.ts, which re-exports it) and by members-me.mts (story check).
import { recordUsage } from './usage-meter';

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

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
    // billing_error means the credits are gone - worth its own counter so the
    // usage dashboard can say so instead of burying it in generic errors.
    await recordUsage('anthropic', { errors: 1, billing_errors: errorType === 'billing_error' ? 1 : 0 });
    return { ok: false, status: res.status, errorType };
  }

  const data = await res.json();
  await recordUsage('anthropic', {
    requests: 1,
    input_tokens: data.usage?.input_tokens,
    output_tokens: data.usage?.output_tokens,
    cache_read_tokens: data.usage?.cache_read_input_tokens,
    cache_write_tokens: data.usage?.cache_creation_input_tokens,
  });
  const textBlock = data.content?.find((block: { type: string }) => block.type === 'text');
  return { ok: true, text: textBlock?.text ?? '' };
}
