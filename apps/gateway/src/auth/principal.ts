export type Role = 'admin' | 'member';
export type ToolMode = 'full' | 'search' | 'auto';

/**
 * Who is calling, however they authenticated. API keys, OAuth access tokens and the chat agent's
 * delegation tokens all resolve to this same shape, so permissions, audit and rate limits are identical
 * for every client (Claude Code, Cursor, Inspector, the built-in chat).
 */
export interface Principal {
  userId: string;
  email: string;
  name: string;
  role: Role;
  authMethod: 'api_key' | 'oauth' | 'delegation';
  /** api key id, oauth grant id, or delegation token id prefix. Shown in audit, never secret. */
  credentialId: string;
  clientName?: string;
  /** 'chat' only for delegation tokens, derived server-side from the token type: can't be forged by a client. */
  via: 'mcp' | 'chat';
  toolMode: ToolMode;
  scopes: string[];
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
}
