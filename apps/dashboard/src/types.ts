export type Role = 'admin' | 'member';
export type ToolMode = 'full' | 'search' | 'auto';

export interface Me {
  user: { id: string; email: string; name: string; role: Role };
  mcpUrl: string;
  publicBaseUrl: string;
  storesEnabled: boolean;
}

export type ServerStatus = 'connected' | 'pending' | 'unreachable' | 'disabled';
export interface Server {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  url: string;
  authType: 'none' | 'bearer' | 'header';
  authHeaderName: string | null;
  credentialSet: boolean;
  enabled: boolean;
  managedBy: string | null;
  timeoutMs: number;
  maxConcurrency: number;
  status: ServerStatus;
  statusReason: string | null;
  statusDetail: string | null;
  statusSince: string | null;
  lastOkAt: string | null;
  lastCheckedAt: string | null;
  latencyMs: number | null;
  protocolEra: 'modern' | 'legacy' | null;
  protocolVersion: string | null;
  serverName: string | null;
  serverVersion: string | null;
  toolsSyncedAt: string | null;
  tools?: { active: number; pending: number; total: number };
  createdAt: string;
}

export type ToolState = 'active' | 'pending_new' | 'pending_changed' | 'disabled' | 'gone';
export interface ToolDef {
  name: string;
  exposedName: string;
  title: string | null;
  description: string;
  inputSchema: unknown;
  annotations: Record<string, unknown> | null;
  state: ToolState;
  access: 'read' | 'write';
  suggestedAccess: 'read' | 'write';
  pinned: boolean;
  flags: string[];
  previous: { description?: string; input_schema?: unknown; title?: string | null } | null;
  firstSeenAt: string;
  changedAt: string | null;
}

export interface Member {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  created_at: string;
  last_login_at: string | null;
  keys: number;
}
export interface Invite {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}
export interface ApiKey {
  id: string;
  prefix: string;
  name: string;
  userId: string;
  userEmail: string;
  createdBy: string | null;
  toolMode: ToolMode;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'revoked' | 'expired';
}
export interface Grant {
  id: string;
  user: string;
  clientName: string;
  clientId: string;
  host: string | null;
  verified: boolean;
  scopes: string[];
  toolMode: ToolMode;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export type Outcome = 'success' | 'tool_error' | 'timeout' | 'unavailable' | 'denied' | 'invalid_args' | 'auth_failed' | 'rate_limited' | 'cancelled' | 'error';
export interface AuditEvent {
  id: number;
  ts: string;
  durationMs: number | null;
  userId: string | null;
  userEmail: string | null;
  authMethod: string | null;
  credentialId: string | null;
  client: string | null;
  via: string | null;
  server: string | null;
  tool: string | null;
  exposedName: string | null;
  outcome: Outcome;
  errorCode: string | null;
  errorMessage: string | null;
  argsBytes: number | null;
  resultBytes: number | null;
  traceId: string | null;
}
export interface Rule {
  id: string;
  subject_type: 'role' | 'user';
  subject: string;
  subject_email: string | null;
  server: string;
  tool: string;
  effect: 'allow' | 'deny';
  created_at: string;
}
export interface EffectiveTool {
  name: string;
  server: string;
  access: 'read' | 'write';
  allowed: boolean;
  reason: string;
}
export interface MyTool {
  name: string;
  server: string;
  serverName: string;
  title: string | null;
  description: string;
  access: 'read' | 'write';
}

export type StorePhase = 'Pending' | 'Provisioning' | 'Ready' | 'Failed' | 'Deleting';
export interface StoreCondition {
  type: 'Namespace' | 'Access' | 'Guardrails' | 'Secrets' | 'Release' | 'Workloads' | 'Registered';
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime: string;
}
export interface StoreInfo {
  name: string;
  displayName: string;
  ownerId: string;
  ownerEmail: string | null;
  createdAt: string | null;
  deleting: boolean;
  phase: StorePhase;
  url: string | null;
  adminUrl: string | null;
  namespace: string | null;
  reason: string | null;
  message: string | null;
  startedAt: string | null;
  readyAt: string | null;
  attempts: number;
  conditions: StoreCondition[];
  canManage: boolean;
}
export interface StoresResponse {
  stores: StoreInfo[];
  limits: { mine: number; perUser: number; total: number; maxTotal: number };
  domain: string;
}
