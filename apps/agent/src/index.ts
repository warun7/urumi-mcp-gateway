import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import pino from 'pino';
import { z } from 'zod';
import { runAgent, type AgentEvent } from './agent.js';
import { loadConfig } from './config.js';
import { friendly } from './errors.js';
import { connectGateway, type ToolHost } from './gateway.js';
import { OpenAiCompatible, ScriptedLlm, type Llm } from './llm.js';

const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL, base: { svc: 'agent' }, redact: ['token', 'headers.authorization', 'headers["x-delegation-token"]'] });

const MODEL = cfg.LLM_PROVIDER === 'openai' ? cfg.LLM_MODEL : 'scripted';
const llm: Llm = cfg.LLM_PROVIDER === 'openai'
  ? new OpenAiCompatible({ baseUrl: cfg.LLM_BASE_URL, apiKey: cfg.LLM_API_KEY, model: cfg.LLM_MODEL, timeoutMs: cfg.LLM_TIMEOUT_MS })
  : new ScriptedLlm();
if (cfg.LLM_PROVIDER === 'openai' && !cfg.LLM_API_KEY) log.warn({ baseUrl: cfg.LLM_BASE_URL }, 'LLM_API_KEY is empty (fine for Ollama, not for hosted APIs)');

const ToolCall = z.object({ id: z.string().max(200), type: z.literal('function'), function: z.object({ name: z.string().max(200), arguments: z.string().max(100_000) }) });
const Body = z.object({
  // No "system" role: the system prompt is the agent's, not the browser's.
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'tool']),
    content: z.string().max(100_000).nullable().optional(),
    tool_calls: z.array(ToolCall).max(20).optional(),
    tool_call_id: z.string().max(200).optional(),
    name: z.string().max(100).optional(),
  })).min(1).max(200),
  approvals: z.record(z.string(), z.boolean()).default({}),
  user: z.object({ name: z.string().max(200), role: z.string().max(20) }),
});

const app = new Hono();
app.get('/healthz', (c) => c.json({ ok: true }));
app.get('/readyz', (c) => c.json({ ok: true, provider: cfg.LLM_PROVIDER, model: MODEL }));

/**
 * Called only by the gateway (NetworkPolicy), with a short-lived delegation token for the user.
 * The agent holds no credentials of its own; the token is the only authority it has.
 */
app.post('/chat', async (c) => {
  const token = c.req.header('x-delegation-token');
  if (!token) return c.json({ error: 'missing delegation token' }, 401);
  const parsed = Body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid request', detail: parsed.error.issues.slice(0, 3) }, 400);
  const input = parsed.data;
  const signal = c.req.raw.signal;

  return streamSSE(c, async (stream) => {
    const started = Date.now();
    let toolCalls = 0;
    let outcome = 'answered';
    // SSE writes are queued so events go out in order without awaiting each one in the loop.
    let chain: Promise<unknown> = Promise.resolve();
    const emit = (e: AgentEvent) => {
      if (e.type === 'tool_call') toolCalls++;
      if (e.type === 'done') outcome = e.reason;
      chain = chain.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })).catch(() => {});
    };
    // Model time and tokens for this turn, so "slow chat" splits into model time vs tool time in the logs.
    const usage = { llmCalls: 0, llmMs: 0, inputTokens: undefined as number | undefined, outputTokens: undefined as number | undefined };
    const metered: Llm = {
      chat: async (...args) => {
        const t0 = Date.now();
        try {
          const turn = await llm.chat(...args);
          log.info({ model: MODEL, ms: Date.now() - t0, firstTokenMs: turn.firstTokenMs, ...turn.usage, toolCalls: turn.toolCalls.length }, 'llm call');
          if (turn.usage) {
            usage.inputTokens = (usage.inputTokens ?? 0) + turn.usage.inputTokens;
            usage.outputTokens = (usage.outputTokens ?? 0) + turn.usage.outputTokens;
          }
          return turn;
        } finally {
          usage.llmCalls++;
          usage.llmMs += Date.now() - t0;
        }
      },
    };
    let host: ToolHost | undefined;
    try {
      host = await connectGateway(cfg.GATEWAY_MCP_URL, token);
      await runAgent(input, { llm: metered, host, maxSteps: cfg.MAX_STEPS, maxResultChars: cfg.MAX_TOOL_RESULT_CHARS }, emit, signal);
    } catch (err) {
      outcome = 'error';
      if (!signal.aborted) {
        log.warn({ err: (err as Error).message }, 'chat turn failed');
        emit({ type: 'error', message: friendly(err) });
        emit({ type: 'done', reason: 'answered' });
      }
    } finally {
      await host?.close();
      await chain;
      log.info({ role: input.user.role, toolCalls, outcome, ms: Date.now() - started, provider: cfg.LLM_PROVIDER, model: MODEL, ...usage }, 'chat turn');
    }
  });
});

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (i) => log.info({ port: i.port, provider: cfg.LLM_PROVIDER }, 'agent listening'));
const shutdown = () => {
  log.info('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
