/** Human explanations for the gateway's server status reasons. */
export const REASON_HINT: Record<string, string> = {
  DNS_FAILURE: "The hostname doesn't resolve. Check the URL.",
  CONNECTION_REFUSED: 'Nothing is accepting connections at that address. Is the server running, and is the port right?',
  TIMEOUT: "The server didn't answer within the timeout.",
  TLS_ERROR: 'The TLS handshake failed: an invalid certificate, or https used for an http server.',
  AUTH_REJECTED: 'The server rejected the credential (401/403). Update it with Edit.',
  NOT_MCP: 'Something answered, but not as an MCP endpoint. Check the path (often /mcp).',
  PROTOCOL_ERROR: "The server's response isn't valid MCP.",
  VERSION_MISMATCH: 'The server and gateway have no MCP protocol version in common.',
  SSRF_BLOCKED: "The URL points at a private or internal address that isn't on the allow-list.",
  CIRCUIT_OPEN: 'Too many recent failures, so calls are paused for a few seconds.',
  UPSTREAM_ERROR: 'The server returned an error.',
};
