import { LlmHttpError, providerMessage } from './errors.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface LlmTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}
export interface LlmTurn {
  content: string;
  toolCalls: ToolCall[];
  /** Real providers only: when the first token arrived, and token counts when the provider reports them. */
  firstTokenMs?: number;
  usage?: LlmUsage;
}
export interface Llm {
  chat(messages: ChatMessage[], tools: LlmTool[], onText: (delta: string) => void, signal: AbortSignal): Promise<LlmTurn>;
}

/**
 * OpenAI-compatible Chat Completions with streaming, written against the wire format directly
 * (no SDK): it works with OpenAI, Gemini's OpenAI endpoint, Groq, OpenRouter, Ollama, vLLM...
 */
export class OpenAiCompatible implements Llm {
  /** Streaming responses carry token counts only on request. Turned off if a server rejects the option. */
  private askUsage = true;

  constructor(private readonly o: { baseUrl: string; apiKey: string; model: string; timeoutMs: number }) {}

  private post(messages: ChatMessage[], tools: LlmTool[], signal: AbortSignal) {
    return fetch(`${this.o.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
      body: JSON.stringify({
        model: this.o.model,
        messages,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        stream: true,
        ...(this.askUsage ? { stream_options: { include_usage: true } } : {}),
        temperature: 0.2,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.o.timeoutMs)]),
    });
  }

  async chat(messages: ChatMessage[], tools: LlmTool[], onText: (d: string) => void, signal: AbortSignal): Promise<LlmTurn> {
    const started = Date.now();
    let res = await this.post(messages, tools, signal);
    if (res.status === 400 && this.askUsage) {
      const body = await res.text();
      if (!/stream_options/i.test(body)) throw new LlmHttpError(400, providerMessage(body));
      this.askUsage = false; // an older server: carry on without token counts
      res = await this.post(messages, tools, signal);
    }
    if (!res.ok || !res.body) throw new LlmHttpError(res.status, providerMessage(await res.text()));
    let firstTokenMs: number | undefined;
    let usage: LlmUsage | undefined;

    let content = '';
    const calls: { id: string; name: string; args: string }[] = [];
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j: {
          choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
        };
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        // The usage chunk comes last, with no choices. DeepSeek and OpenAI name cached input tokens differently.
        if (j.usage) {
          const cached = j.usage.prompt_cache_hit_tokens ?? j.usage.prompt_tokens_details?.cached_tokens;
          usage = { inputTokens: j.usage.prompt_tokens ?? 0, outputTokens: j.usage.completion_tokens ?? 0, ...(cached != null ? { cachedTokens: cached } : {}) };
        }
        const delta = j.choices?.[0]?.delta;
        if (firstTokenMs === undefined && (delta?.content || delta?.tool_calls?.length)) firstTokenMs = Date.now() - started;
        if (delta?.content) {
          content += delta.content;
          onText(delta.content);
        }
        // Tool calls stream in fragments keyed by index: name first, arguments in pieces.
        for (const tc of delta?.tool_calls ?? []) {
          const c = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
        }
      }
    }
    return {
      content,
      toolCalls: calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${i}_${Date.now()}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
      ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}

/**
 * A deterministic stand-in for an LLM: maps a few phrasings to tool calls, then summarises results.
 * Used by the automated e2e test (no API key, no flakiness) and as a no-key demo mode.
 * It only ever calls tools the gateway listed for the user, so permissions still apply.
 */
export class ScriptedLlm implements Llm {
  async chat(messages: ChatMessage[], tools: LlmTool[], onText: (d: string) => void): Promise<LlmTurn> {
    const lastUserRaw = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const lastUser = lastUserRaw.toLowerCase();
    // When several servers have the same tool (e.g. two stores), prefer one named in the message, then a store.
    const rank = (name: string) => (lastUser.includes(name.split('__')[0]!) ? 0 : /^(woo|store)/.test(name) ? 1 : 2);
    const has = (n: string) => tools.map((t) => t.function.name).filter((t) => t === n || t.endsWith(`__${n}`)).sort((a, b) => rank(a) - rank(b))[0];
    const all = (suffix: string) => tools.filter((t) => t.function.name.endsWith(`__${suffix}`)).map((t) => t.function.name);
    const lastIdx = messages.map((m) => m.role).lastIndexOf('user');
    const toolResults = messages.slice(lastIdx).filter((m) => m.role === 'tool');
    const say = (text: string): LlmTurn => {
      for (const word of text.split(/(?<= )/)) onText(word);
      return { content: text, toolCalls: [] };
    };
    const call = (name: string, args: Record<string, unknown>, i = 0): ToolCall => ({ id: `scripted_${Date.now()}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

    // Which tool calls the user's words map to, given the tools currently offered.
    const intent = (): ToolCall[] | 'cannot_create' | null => {
      if (/compare|across|every store|all stores/.test(lastUser) && all('sales_summary').length) {
        const period = /yesterday/.test(lastUser) ? 'yesterday' : 'today';
        return all('sales_summary').map((n, i) => call(n, { period }, i));
      }
      const create = /(create|add) (a )?(new )?product (called |named )?["“]?([^"”]+?)["”]? (for|at|priced at|price) (?:rs\.?|inr|₹)?\s*([\d.]+)/i.exec(lastUserRaw);
      if (create && has('create_product')) return [call(has('create_product')!, { name: create[5]!.trim(), regular_price: Number(create[7]).toFixed(2) })];
      if (/(create|add) .*product/.test(lastUser)) return has('gateway__search_tools') && !searched ? null : 'cannot_create';
      if (/order/.test(lastUser) && has('list_orders')) return [call(has('list_orders')!, { period: /yesterday/.test(lastUser) ? 'yesterday' : 'today' })];
      if (/(sales|revenue)/.test(lastUser) && has('sales_summary')) return [call(has('sales_summary')!, { period: 'today' })];
      if (/product/.test(lastUser) && has('list_products')) return [call(has('list_products')!, {})];
      if (/fetch|http/.test(lastUser)) {
        const url = /(https?:\/\/\S+)/.exec(lastUserRaw)?.[1];
        const f = has('fetch_markdown') ?? has('fetch');
        if (url && f) return [call(f, { url })];
      }
      return null;
    };
    const calledThisTurn = new Set(messages.slice(lastIdx).flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name));
    const searched = calledThisTurn.has('gateway__search_tools');
    const want = intent();

    if (want === 'cannot_create') return say("I can't create products for you: that tool isn't available to your role (or I couldn't parse the name and price).");
    // In search mode the first pass finds the tool; the found tool is then offered directly, so call it.
    if (want && !want.some((c) => calledThisTurn.has(c.function.name))) return { content: '', toolCalls: want };
    if (toolResults.length) {
      const names = new Map(messages.flatMap((m) => m.tool_calls ?? []).map((c) => [c.id, c.function.name]));
      const real = toolResults.filter((r) => names.get(r.tool_call_id ?? '') !== 'gateway__search_tools');
      const lines = (real.length ? real : toolResults).map((r) => `- **${names.get(r.tool_call_id ?? '') ?? 'tool'}**: ${summarise(r.content ?? '')}`);
      return say(`Here is what I found (scripted demo model):\n${lines.join('\n')}`);
    }
    if (has('gateway__search_tools') && !searched) return { content: '', toolCalls: [call('gateway__search_tools', { query: lastUser.slice(0, 200) })] };
    return say('This is the scripted demo model. Configure LLM_PROVIDER=openai with an API key for real conversations.');
  }
}

function summarise(content: string): string {
  if (content.startsWith('The user declined')) return 'you declined it, so nothing was changed.';
  try {
    const j = JSON.parse(content);
    if (j.order_count !== undefined) return `${j.store ?? ''}: ${j.order_count} orders, revenue ${j.revenue} ${j.currency ?? ''} (${j.period})`;
    if (Array.isArray(j.orders)) return `${j.total ?? j.orders.length} orders (${j.range?.period ?? ''}): ${j.orders.slice(0, 5).map((o: { number: string; total: string; status: string }) => `#${o.number} ${o.total} ${o.status}`).join(', ')}`;
    if (j.product) return `${j.created ? 'created' : 'exists'}: ${j.product.name} (${j.product.price}) ${j.product.permalink}`;
    if (Array.isArray(j.products)) return j.products.map((p: { name: string; price: string }) => `${p.name} ${p.price}`).join(', ');
    if (Array.isArray(j.results)) return `search results: ${j.results.map((r: { name: string }) => r.name).join(', ')}`;
    return content.slice(0, 300);
  } catch {
    return content.slice(0, 300);
  }
}
