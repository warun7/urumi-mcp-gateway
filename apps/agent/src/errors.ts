/** A non-2xx answer from the model provider, with the provider's own message when it sent one. */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`LLM HTTP ${status}: ${detail}`);
  }
}

/** OpenAI-compatible providers answer errors as {"error":{"message":"..."}}; fall back to the raw body. */
export function providerMessage(body: string): string {
  try {
    const m = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof m === 'string' && m) return m.slice(0, 200);
  } catch {
    /* not JSON */
  }
  return body.slice(0, 200);
}

/** What the chat shows when a turn fails. Model-provider errors come first: their 401 is not the user's session. */
export function friendly(err: unknown): string {
  if (err instanceof LlmHttpError) {
    // Auth errors echo part of the key (OpenAI and DeepSeek print its last characters), so they stay in the logs only.
    if (err.status === 401 || err.status === 403) return 'The language model rejected its API key. An admin needs to set a valid one.';
    const said = err.detail ? ` The provider said: "${err.detail}".` : '';
    if (err.status === 402) return `The language model account is out of credit. An admin needs to top it up.${said}`;
    if (err.status === 429) return `The language model is rate-limiting requests. Wait a moment and try again.${said}`;
    if (err.status >= 500) return `The language model provider is having trouble (HTTP ${err.status}). Try again shortly.`;
    return `The language model returned an error (HTTP ${err.status}).${said}`;
  }
  const msg = (err as Error)?.message ?? String(err);
  if (/\b401\b|unauthorized|invalid_token/i.test(msg)) return 'Your chat session expired. Please send the message again.';
  if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(msg)) return 'The assistant could not reach the MCP gateway or the language model. Try again shortly.';
  if (/abort|timeout/i.test(msg)) return 'The request timed out. Try a narrower question.';
  return 'Something went wrong while answering. Try again.';
}
