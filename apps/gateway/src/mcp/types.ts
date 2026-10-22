import type { DiscoverResult } from '@modelcontextprotocol/client';

export type UpstreamStatus = 'pending' | 'connected' | 'unreachable' | 'disabled';

export interface UpstreamRow {
  id: string;
  slug: string;
  display_name: string;
  description: string;
  url: string;
  auth_type: 'none' | 'bearer' | 'header';
  auth_header_name: string | null;
  credential_ct: Buffer | null;
  credential_iv: Buffer | null;
  credential_kid: string | null;
  enabled: boolean;
  managed_by: string | null;
  timeout_ms: number;
  max_concurrency: number;
  status: UpstreamStatus;
  status_reason: string | null;
  status_detail: string | null;
  status_since: Date;
  last_ok_at: Date | null;
  last_checked_at: Date | null;
  latency_ms: number | null;
  protocol_era: 'modern' | 'legacy' | null;
  protocol_version: string | null;
  server_name: string | null;
  server_version: string | null;
  discover_json: DiscoverResult | null;
  tools_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ToolRow {
  upstream_id: string;
  name: string;
  exposed_name: string;
  title: string | null;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown> | null;
  annotations: Record<string, unknown> | null;
  def_hash: string;
  approved_hash: string | null;
  previous_def: Record<string, unknown> | null;
  access: 'read' | 'write';
  flags: string[];
  present: boolean;
  enabled: boolean;
  pinned: boolean;
  first_seen_at: Date;
  last_seen_at: Date;
  changed_at: Date | null;
}

/** A tool as the gateway exposes it downstream. */
export interface CatalogTool {
  exposedName: string;
  upstreamId: string;
  slug: string;
  serverName: string;
  name: string; // original upstream name, used when calling the upstream
  title?: string;
  description: string; // provenance-prefixed
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  access: 'read' | 'write';
  pinned: boolean;
  defHash: string;
}

export type ToolState = 'active' | 'pending_new' | 'pending_changed' | 'disabled' | 'gone';

export function toolState(t: Pick<ToolRow, 'present' | 'enabled' | 'approved_hash' | 'def_hash'>): ToolState {
  if (!t.present) return 'gone';
  if (!t.enabled) return 'disabled';
  if (t.approved_hash === t.def_hash) return 'active';
  return t.approved_hash ? 'pending_changed' : 'pending_new';
}
