import { SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { SsrfError } from './ssrf.js';

/** Machine-readable reasons shown as a badge in the dashboard, plus a human sentence. */
export type StatusReason =
  | 'DNS_FAILURE' | 'CONNECTION_REFUSED' | 'TIMEOUT' | 'TLS_ERROR' | 'AUTH_REJECTED' | 'NOT_MCP'
  | 'PROTOCOL_ERROR' | 'VERSION_MISMATCH' | 'SSRF_BLOCKED' | 'CIRCUIT_OPEN' | 'UPSTREAM_ERROR';

export interface Classified {
  reason: StatusReason;
  detail: string;
}

const causeChain = (err: unknown): unknown[] => {
  const out: unknown[] = [];
  let e: unknown = err;
  for (let i = 0; e && i < 6; i++) {
    out.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
};

export function classify(err: unknown): Classified {
  const chain = causeChain(err);
  for (const e of chain) {
    if (e instanceof SsrfError) return { reason: 'SSRF_BLOCKED', detail: e.message };
    const code = (e as { code?: unknown }).code;
    if (code === 'SSRF_BLOCKED') return { reason: 'SSRF_BLOCKED', detail: String((e as Error).message) };
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { reason: 'DNS_FAILURE', detail: `DNS lookup failed (${code})` };
    if (code === 'ECONNREFUSED') return { reason: 'CONNECTION_REFUSED', detail: 'Connection refused (is the server running?)' };
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return { reason: 'CONNECTION_REFUSED', detail: 'Connection reset by the server' };
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return { reason: 'CONNECTION_REFUSED', detail: `Network unreachable (${code})` };
    if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return { reason: 'TIMEOUT', detail: 'Connection timed out' };
    if (typeof code === 'string' && (code.startsWith('ERR_TLS') || code.includes('CERT') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'))
      return { reason: 'TLS_ERROR', detail: `TLS error (${code})` };
    if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError') return { reason: 'TIMEOUT', detail: 'Timed out' };
  }
  if (err instanceof SdkHttpError) {
    const status = (err as { data?: { status?: number } }).data?.status;
    if (err.code === SdkErrorCode.ClientHttpAuthentication || err.code === SdkErrorCode.ClientHttpForbidden || status === 401 || status === 403)
      return { reason: 'AUTH_REJECTED', detail: `Server rejected the credential (HTTP ${status ?? '401/403'})` };
    if (status === 404 || status === 405) return { reason: 'NOT_MCP', detail: `HTTP ${status}: no MCP endpoint at this URL` };
    return { reason: 'PROTOCOL_ERROR', detail: err.message.slice(0, 300) };
  }
  if (err instanceof SdkError) {
    if (err.code === SdkErrorCode.EraNegotiationFailed) return { reason: 'VERSION_MISMATCH', detail: err.message.slice(0, 300) };
    if (String(err.code).toLowerCase().includes('timeout')) return { reason: 'TIMEOUT', detail: err.message.slice(0, 300) };
    const m = err.message;
    if (/401|unauthori[sz]ed/i.test(m)) return { reason: 'AUTH_REJECTED', detail: m.slice(0, 300) };
    if (/40[45]|text\/html|content-type/i.test(m)) return { reason: 'NOT_MCP', detail: m.slice(0, 300) };
    return { reason: 'PROTOCOL_ERROR', detail: m.slice(0, 300) };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed? ?out/i.test(msg)) return { reason: 'TIMEOUT', detail: msg.slice(0, 300) };
  if (/fetch failed/i.test(msg)) return { reason: 'CONNECTION_REFUSED', detail: msg.slice(0, 300) };
  return { reason: 'UPSTREAM_ERROR', detail: msg.slice(0, 300) };
}
