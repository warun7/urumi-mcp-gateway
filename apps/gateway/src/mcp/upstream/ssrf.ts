import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * SSRF guard for anything the gateway fetches on a user's behalf (upstream MCP URLs, OAuth CIMD documents).
 *
 * Two layers:
 *  1. Registration time: scheme + hostname rules, and a DNS check of the current answer.
 *  2. Connection time: a custom DNS `lookup` on the HTTP agent re-checks EVERY resolved address
 *     right before connecting. That defeats DNS rebinding (resolve to a public IP at registration,
 *     to 169.254.169.254 later).
 * A third layer lives outside this file: the gateway's egress NetworkPolicy blocks private ranges too.
 */
const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32],
] as const) blocked.addSubnet(net, bits, 'ipv6');

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return blocked.check(ip, 'ipv4');
  if (v === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip); // IPv4-mapped IPv6
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

const INTERNAL_NAME = /(^localhost$)|(\.localhost$)|(\.local$)|(\.internal$)|(\.svc$)|(\.svc\.cluster\.local$)|(\.cluster\.local$)/i;

export const globToRegex = (glob: string) =>
  new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*') + '$', 'i');

export class SsrfError extends Error {
  readonly code = 'SSRF_BLOCKED';
}

export interface UrlPolicy {
  /** Hostname globs that may resolve to private addresses (cluster-internal MCP servers). */
  internalHosts: string[];
}

/** Classify a URL: 'internal' (allow-listed cluster host), 'public', or throw SsrfError. */
export function classifyUrl(raw: string, policy: UrlPolicy): { url: URL; kind: 'internal' | 'public' } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('Not a valid URL');
  }
  if (url.username || url.password) throw new SsrfError('Credentials in the URL are not allowed; use the credential field');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (policy.internalHosts.some((g) => globToRegex(g).test(host))) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError('Only http(s) URLs are allowed');
    return { url, kind: 'internal' };
  }
  if (url.protocol !== 'https:') throw new SsrfError('Remote MCP servers must use https');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new SsrfError(`Address ${host} is private or reserved`);
  } else if (INTERNAL_NAME.test(host)) {
    throw new SsrfError(`Host ${host} is an internal name`);
  }
  return { url, kind: 'public' };
}

/** Registration-time DNS check (best effort; connection-time check is the real guard). */
export async function assertResolvesPublic(host: string): Promise<void> {
  if (isIP(host)) return;
  const addrs = await new Promise<{ address: string }[]>((resolve, reject) =>
    dnsLookup(host, { all: true }, (err, a) => (err ? reject(err) : resolve(a))),
  );
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new SsrfError(`Host ${host} resolves to private address ${bad.address}`);
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/** DNS lookup that refuses private answers. Plugged into the HTTP agent: checked on every connect. */
function guardedLookup(hostname: string, options: { all?: boolean }, cb: LookupCb) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '');
    const list = addresses as { address: string; family: number }[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad) {
      const e = new SsrfError(`blocked connection to private address ${bad.address} (${hostname})`) as unknown as NodeJS.ErrnoException;
      e.code = 'SSRF_BLOCKED';
      return cb(e, '');
    }
    if (options.all) return cb(null, list);
    return cb(null, list[0]!.address, list[0]!.family);
  });
}

const publicAgent = new Agent({ connect: { lookup: guardedLookup as never, timeout: 5_000 }, keepAliveTimeout: 30_000 });
const internalAgent = new Agent({ connect: { timeout: 3_000 }, keepAliveTimeout: 30_000 });

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * fetch bound to one URL's classification. Redirects are refused (a 3xx could point anywhere),
 * and the target is re-classified on every request.
 */
export function guardedFetch(policy: UrlPolicy): FetchLike {
  return async (input, init) => {
    const { kind } = classifyUrl(String(input), policy);
    const res = await undiciFetch(String(input), {
      ...(init as object),
      redirect: 'manual',
      dispatcher: kind === 'internal' ? internalAgent : publicAgent,
    } as never);
    if (res.status >= 300 && res.status < 400) throw new SsrfError(`Upstream answered with a redirect (${res.status}); redirects are not followed`);
    return res as unknown as Response;
  };
}
