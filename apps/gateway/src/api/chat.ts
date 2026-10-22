import { Hono } from 'hono';
import { z } from 'zod';
import { mintDelegationToken } from '../auth/oauth/tokens.js';
import type { ApiEnv } from '../auth/sessions.js';
import { body, HttpError, type Deps } from './deps.js';

const Message = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string().max(100_000).nullable().optional(),
  tool_calls: z.array(z.any()).max(20).optional(),
  tool_call_id: z.string().max(200).optional(),
  name: z.string().max(100).optional(),
});

/**
 * The browser talks only to the gateway. The gateway mints a short-lived delegation token for the
 * logged-in user and calls the agent service with it; the agent then calls /mcp with that token,
 * so the chat goes through exactly the same permission + audit path as any other MCP client.
 */
export function chatApi(d: Deps) {
  const app = new Hono<ApiEnv>();

  app.post('/', async (c) => {
    const b = await body(c, z.object({
      messages: z.array(Message).min(1).max(200),
      approvals: z.record(z.string(), z.boolean()).optional(), // tool_call_id -> approved? (write-tool confirmation)
    }));
    const user = c.get('user');
    const token = await mintDelegationToken(d.sql, d.hasher, d.cfg, user.id);
    let res: Response;
    try {
      res = await fetch(`${d.cfg.AGENT_URL}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-delegation-token': token },
        body: JSON.stringify({ messages: b.messages, approvals: b.approvals ?? {}, user: { name: user.name, role: user.role } }),
        signal: c.req.raw.signal,
      });
    } catch (err) {
      d.log.warn({ err: (err as Error).message }, 'agent unreachable');
      throw new HttpError(502, 'the chat agent is not reachable right now');
    }
    if (!res.ok || !res.body) throw new HttpError(502, `the chat agent failed (HTTP ${res.status})`);
    // Stream the agent's SSE straight through.
    return new Response(res.body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' },
    });
  });

  /** Which model the agent runs (shown in the chat header), or unavailable. */
  app.get('/info', async (c) => {
    try {
      const r = await fetch(`${d.cfg.AGENT_URL}/readyz`, { signal: AbortSignal.timeout(2_000) });
      const j = (await r.json()) as { provider?: string; model?: string };
      return c.json({ available: r.ok, provider: j.provider ?? null, model: j.model ?? null });
    } catch {
      return c.json({ available: false, provider: null, model: null });
    }
  });

  return app;
}
