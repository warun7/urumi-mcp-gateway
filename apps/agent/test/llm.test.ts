import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmHttpError } from '../src/errors.js';
import { OpenAiCompatible } from '../src/llm.js';

const sse = (...chunks: unknown[]) => new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join(''), { status: 200 });
const client = () => new OpenAiCompatible({ baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', timeoutMs: 5_000 });
const sentBody = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;

afterEach(() => vi.unstubAllGlobals());

describe('OpenAiCompatible', () => {
  it('asks for token counts and reads them from the final chunk (DeepSeek field names)', async () => {
    const fetch = vi.fn(async () => sse(
      { choices: [{ delta: { content: 'Hi' } }] },
      { choices: [{ delta: { content: ' there' } }] },
      { choices: [], usage: { prompt_tokens: 812, completion_tokens: 9, prompt_cache_hit_tokens: 768 } },
    ));
    vi.stubGlobal('fetch', fetch);
    const turn = await client().chat([{ role: 'user', content: 'hi' }], [], () => {}, new AbortController().signal);
    expect(sentBody(fetch.mock.calls[0]!).stream_options).toEqual({ include_usage: true });
    expect(turn.content).toBe('Hi there');
    expect(turn.usage).toEqual({ inputTokens: 812, outputTokens: 9, cachedTokens: 768 });
    expect(turn.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it('reads OpenAI-style cached tokens, and leaves usage out when the provider sends none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } })));
    expect((await client().chat([], [], () => {}, new AbortController().signal)).usage).toEqual({ inputTokens: 50, outputTokens: 5, cachedTokens: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => sse({ choices: [{ delta: { content: 'ok' } }] })));
    expect((await client().chat([], [], () => {}, new AbortController().signal)).usage).toBeUndefined();
  });

  it('falls back to no token counts on a server that rejects stream_options, and remembers', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"Unrecognized request argument supplied: stream_options"}}', { status: 400 }))
      .mockImplementation(async () => sse({ choices: [{ delta: { content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetch);
    const c = client();
    expect((await c.chat([], [], () => {}, new AbortController().signal)).content).toBe('ok');
    await c.chat([], [], () => {}, new AbortController().signal);
    expect(fetch.mock.calls.map((call) => 'stream_options' in sentBody(call))).toEqual([true, false, false]);
  });

  it('reports any other 400 as a provider error without retrying', async () => {
    const fetch = vi.fn(async () => new Response('{"error":{"message":"model not found"}}', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    await expect(client().chat([], [], () => {}, new AbortController().signal)).rejects.toEqual(new LlmHttpError(400, 'model not found'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
