/**
 * Hand-written SQL migrations, embedded so the bundle is self-contained.
 * Rules (expand/contract, so `helm rollback` of the gateway is always safe):
 *  - never drop or rename a column in the same release that stops using it;
 *  - add columns as NULLable or with a DEFAULT;
 *  - never edit a migration that has shipped; add a new one.
 */
export const migrations: { id: string; sql: string }[] = [
  {
    id: '0001_init',
    sql: /* sql */ `
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  name          text NOT NULL DEFAULT '',
  role          text NOT NULL CHECK (role IN ('admin','member')),
  password_hash text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin','member')),
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz
);

CREATE TABLE sessions (
  id_hash    text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip         text,
  user_agent text
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE api_keys (
  id           text PRIMARY KEY,               -- public part of ugw_<id>_<secret>
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  secret_hmac  text NOT NULL,                  -- HMAC-SHA256(pepper, secret); the secret itself is never stored
  tool_mode    text NOT NULL DEFAULT 'full' CHECK (tool_mode IN ('full','search','auto')),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX api_keys_user ON api_keys(user_id);

CREATE TABLE upstreams (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{0,19}$' AND slug <> 'gateway'),
  display_name     text NOT NULL,
  description      text NOT NULL DEFAULT '',
  url              text NOT NULL,
  auth_type        text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none','bearer','header')),
  auth_header_name text,
  credential_ct    bytea,                      -- AES-256-GCM ciphertext||tag, AAD = id
  credential_iv    bytea,
  credential_kid   text,
  enabled          boolean NOT NULL DEFAULT true,
  managed_by       text,                       -- NULL (manual) | 'bootstrap' | 'store/<name>'
  timeout_ms       int NOT NULL DEFAULT 20000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  max_concurrency  int NOT NULL DEFAULT 16 CHECK (max_concurrency BETWEEN 1 AND 256),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','unreachable','disabled')),
  status_reason    text,
  status_detail    text,
  status_since     timestamptz NOT NULL DEFAULT now(),
  last_ok_at       timestamptz,
  last_checked_at  timestamptz,
  latency_ms       int,
  protocol_era     text,
  protocol_version text,
  server_name      text,
  server_version   text,
  discover_json    jsonb,
  tools_synced_at  timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE upstream_tools (
  upstream_id   uuid NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  name          text NOT NULL,
  exposed_name  text NOT NULL,
  title         text,
  description   text NOT NULL DEFAULT '',
  input_schema  jsonb NOT NULL,
  output_schema jsonb,
  annotations   jsonb,
  def_hash      text NOT NULL,
  approved_hash text,                          -- tool is usable only while approved_hash = def_hash
  previous_def  jsonb,                         -- last approved definition, for the "what changed" diff
  access        text NOT NULL DEFAULT 'write' CHECK (access IN ('read','write')),
  flags         text[] NOT NULL DEFAULT '{}',  -- description-hygiene findings
  present       boolean NOT NULL DEFAULT true, -- still advertised by the upstream
  enabled       boolean NOT NULL DEFAULT true, -- admin kill switch for one tool
  pinned        boolean NOT NULL DEFAULT false,-- always listed, even in search mode
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  changed_at    timestamptz,
  PRIMARY KEY (upstream_id, name),
  -- deferred: a re-sync may shuffle hash-suffixed names inside one transaction
  CONSTRAINT upstream_tools_exposed_unique UNIQUE (exposed_name) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE permissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('role','user')),
  subject      text NOT NULL,                  -- role name or user id
  server       text NOT NULL DEFAULT '*',      -- upstream slug or glob
  tool         text NOT NULL DEFAULT '*',      -- original tool name glob
  effect       text NOT NULL CHECK (effect IN ('allow','deny')),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  duration_ms   int,
  user_id       uuid,                          -- no FK: audit outlives users
  user_email    text,
  auth_method   text,                          -- api_key | oauth | delegation
  credential_id text,
  client_name   text,
  via           text,                          -- mcp | chat
  upstream_id   uuid,
  upstream_slug text,                          -- snapshot; survives server deletion
  tool_name     text,
  exposed_name  text,
  outcome       text NOT NULL,                 -- success | tool_error | timeout | unavailable | denied | invalid_args | auth_failed | error
  error_code    text,
  error_message text,
  args_bytes    int,
  result_bytes  int,
  trace_id      text
);
CREATE INDEX audit_ts ON audit_events(ts DESC);
CREATE INDEX audit_user_ts ON audit_events(user_id, ts DESC);
CREATE INDEX audit_upstream_ts ON audit_events(upstream_slug, ts DESC);

CREATE TABLE oauth_clients (
  client_id     text PRIMARY KEY,              -- https URL (CIMD) or random id (DCR)
  kind          text NOT NULL CHECK (kind IN ('cimd','dcr')),
  client_name   text,
  client_uri    text,
  logo_uri      text,
  redirect_uris text[] NOT NULL,
  metadata      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE TABLE oauth_requests (                  -- authorization requests waiting for login + consent
  id             text PRIMARY KEY,
  client_id      text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri   text NOT NULL,
  state          text,
  code_challenge text NOT NULL,
  scope          text NOT NULL,
  resource       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);

CREATE TABLE oauth_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id    text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scope        text NOT NULL,
  resource     text NOT NULL,
  tool_mode    text NOT NULL DEFAULT 'auto' CHECK (tool_mode IN ('full','search','auto')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE oauth_codes (
  code_hash      text PRIMARY KEY,
  grant_id       uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  scope          text NOT NULL,
  resource       text NOT NULL,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);

CREATE TABLE oauth_tokens (
  token_hash text PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('access','refresh','delegation')),
  grant_id   uuid REFERENCES oauth_grants(id) ON DELETE CASCADE,  -- NULL for delegation tokens
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id  uuid,                             -- refresh-token rotation family
  scope      text NOT NULL,
  resource   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,                      -- refresh tokens are single-use
  revoked_at timestamptz
);
CREATE INDEX oauth_tokens_family ON oauth_tokens(family_id);
CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);

-- Runtime role: full access to everything EXCEPT the audit log, which is append-only.
-- (The role is created by the Postgres init script; skip grants when running without it, e.g. in tests.)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'urumi_app') THEN
    GRANT USAGE ON SCHEMA public TO urumi_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO urumi_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM urumi_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO urumi_app;
  END IF;
END $$;
`,
  },
  {
    id: '0002_state_epoch',
    sql: `
-- Read-your-writes across gateway replicas (events/freshness.ts): every state-changing event bumps this,
-- and each /mcp request compares it with what its replica has applied.
CREATE SEQUENCE state_epoch;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'urumi_app') THEN
    GRANT USAGE, SELECT ON SEQUENCE state_epoch TO urumi_app;
  END IF;
END $$;
`,
  },
];
