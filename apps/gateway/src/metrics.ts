import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const toolCalls = new Counter({
  name: 'mcp_tool_calls_total',
  help: 'Tool calls through the gateway',
  labelNames: ['server', 'outcome', 'via'] as const,
  registers: [registry],
});
export const toolCallDuration = new Histogram({
  name: 'mcp_tool_call_duration_seconds',
  help: 'Tool call latency (gateway in to gateway out)',
  labelNames: ['server'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 60],
  registers: [registry],
});
export const upstreamUp = new Gauge({
  name: 'mcp_upstream_up',
  help: '1 if the upstream is connected',
  labelNames: ['server'] as const,
  registers: [registry],
});
export const authFailures = new Counter({
  name: 'gateway_auth_failures_total',
  help: 'Rejected /mcp requests',
  labelNames: ['reason'] as const,
  registers: [registry],
});
