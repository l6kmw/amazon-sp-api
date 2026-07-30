import type { Pool } from "pg";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "baseline_oauth_and_connected-account_accounts",
    sql: `
      CREATE TABLE IF NOT EXISTS amazon_sp_api.oauth_connection (
        selling_partner_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        authorized_at TIMESTAMPTZ NOT NULL,
        refresh_token JSONB,
        token_type TEXT NOT NULL,
        connected-account_attempt_id TEXT,
        credential_revision BIGINT NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK (status IN ('active', 'disconnected')),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      ALTER TABLE amazon_sp_api.oauth_connection
        ADD COLUMN IF NOT EXISTS credential_revision BIGINT NOT NULL DEFAULT 1;
      CREATE UNIQUE INDEX IF NOT EXISTS oauth_connection_connected-account_attempt_idx
        ON amazon_sp_api.oauth_connection (tenant_id, connected-account_attempt_id)
        WHERE connected-account_attempt_id IS NOT NULL AND status = 'active';

      CREATE TABLE IF NOT EXISTS amazon_sp_api.employee_registry (
        issuer TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        first_seen_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (issuer, employee_id)
      );
      CREATE TABLE IF NOT EXISTS amazon_sp_api.external_account_credential (
        account_id TEXT PRIMARY KEY,
        provider_key TEXT NOT NULL,
        external_account_id TEXT NOT NULL,
        owner_workspace_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'error')),
        authorized_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (provider_key, external_account_id, owner_workspace_id)
      );
      CREATE TABLE IF NOT EXISTS amazon_sp_api.connection_grant (
        issuer TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES amazon_sp_api.external_account_credential(account_id),
        owner_employee_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disconnected')),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (issuer, connection_id),
        UNIQUE (issuer, account_id, owner_employee_id)
      );
      CREATE TABLE IF NOT EXISTS amazon_sp_api.employee_account_binding (
        issuer TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'unbound')),
        remark TEXT,
        bound_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (issuer, employee_id, connection_id),
        FOREIGN KEY (issuer, connection_id)
          REFERENCES amazon_sp_api.connection_grant(issuer, connection_id)
      );
      CREATE TABLE IF NOT EXISTS amazon_sp_api.authorization_attempt (
        issuer TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'failed', 'expired')),
        connection_id TEXT,
        error_code TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        PRIMARY KEY (issuer, employee_id, attempt_id)
      );
      CREATE INDEX IF NOT EXISTS employee_binding_connection_idx
        ON amazon_sp_api.employee_account_binding(issuer, connection_id, status);
    `,
  },
  {
    version: 2,
    name: "expand_control_plane_and_account_lifecycle",
    sql: `
      CREATE TABLE amazon_sp_api.app_user (
        id TEXT PRIMARY KEY CHECK (id = 'tenant-1'),
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'admin' CHECK (role = 'admin'),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE amazon_sp_api.app_agent (
        id TEXT PRIMARY KEY CHECK (LENGTH(id) > 0),
        user_id TEXT NOT NULL REFERENCES amazon_sp_api.app_user(id) ON DELETE RESTRICT
          CHECK (user_id = 'tenant-1'),
        agent_id TEXT NOT NULL CHECK (LENGTH(agent_id) BETWEEN 1 AND 128),
        name TEXT NOT NULL CHECK (LENGTH(name) BETWEEN 1 AND 64),
        purpose TEXT NOT NULL DEFAULT '' CHECK (LENGTH(purpose) <= 200),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        api_token_hash TEXT CHECK (api_token_hash IS NULL OR LENGTH(api_token_hash) = 64),
        api_token_hint TEXT NOT NULL DEFAULT '',
        api_token_created_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, agent_id),
        CHECK (
          (api_token_hash IS NULL AND api_token_created_at IS NULL)
          OR (api_token_hash IS NOT NULL AND api_token_created_at IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX app_agent_api_token_hash_idx
        ON amazon_sp_api.app_agent(api_token_hash)
        WHERE api_token_hash IS NOT NULL;
      CREATE INDEX app_agent_user_status_idx
        ON amazon_sp_api.app_agent(user_id, status, created_at DESC);

      CREATE TABLE amazon_sp_api.audit_log (
        id BIGSERIAL PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES amazon_sp_api.app_user(id) ON DELETE RESTRICT,
        actor_type TEXT NOT NULL
          CHECK (actor_type IN ('browser_session', 'agent_token', 'employee_jwt', 'system')),
        actor_id TEXT NOT NULL CHECK (LENGTH(actor_id) > 0),
        agent_record_id TEXT REFERENCES amazon_sp_api.app_agent(id) ON DELETE SET NULL,
        action TEXT NOT NULL CHECK (LENGTH(action) > 0),
        resource_type TEXT NOT NULL CHECK (LENGTH(resource_type) > 0),
        resource_id TEXT NOT NULL CHECK (LENGTH(resource_id) > 0),
        result TEXT NOT NULL CHECK (result IN ('success', 'denied', 'failed')),
        error_code TEXT,
        request_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX audit_log_tenant_created_idx
        ON amazon_sp_api.audit_log(tenant_id, created_at DESC, id DESC);
      CREATE INDEX audit_log_resource_created_idx
        ON amazon_sp_api.audit_log(tenant_id, resource_type, resource_id, created_at DESC);

      CREATE TABLE amazon_sp_api.amazon_account (
        account_id TEXT PRIMARY KEY,
        provider_key TEXT NOT NULL DEFAULT 'amazon-sp-api'
          CHECK (provider_key = 'amazon-sp-api'),
        issuer_scope TEXT NOT NULL CHECK (LENGTH(issuer_scope) > 0),
        selling_partner_id TEXT NOT NULL CHECK (LENGTH(selling_partner_id) > 0),
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'error')),
        marketplace_ids TEXT[] NOT NULL DEFAULT '{}',
        region TEXT,
        authorized_at TIMESTAMPTZ NOT NULL,
        last_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (provider_key, issuer_scope, selling_partner_id)
      );
      CREATE INDEX amazon_account_scope_status_idx
        ON amazon_sp_api.amazon_account(issuer_scope, status, updated_at DESC);

      CREATE TABLE amazon_sp_api.amazon_credential (
        credential_id TEXT PRIMARY KEY CHECK (LENGTH(credential_id) > 0),
        account_id TEXT NOT NULL REFERENCES amazon_sp_api.amazon_account(account_id) ON DELETE RESTRICT,
        credential_owner_id TEXT NOT NULL CHECK (LENGTH(credential_owner_id) > 0),
        encrypted_refresh_token JSONB,
        refresh_token_revision BIGINT NOT NULL DEFAULT 1 CHECK (refresh_token_revision > 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'error')),
        authorized_at TIMESTAMPTZ NOT NULL,
        last_refresh_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (account_id, credential_owner_id),
        CHECK (status <> 'active' OR encrypted_refresh_token IS NOT NULL)
      );
      CREATE INDEX amazon_credential_account_status_idx
        ON amazon_sp_api.amazon_credential(account_id, status, updated_at DESC);

      ALTER TABLE amazon_sp_api.connection_grant
        ADD COLUMN credential_id TEXT,
        ADD COLUMN authorized_by_type TEXT,
        ADD COLUMN authorized_by_id TEXT;
      ALTER TABLE amazon_sp_api.connection_grant
        ADD CONSTRAINT connection_grant_credential_fk
          FOREIGN KEY (credential_id) REFERENCES amazon_sp_api.amazon_credential(credential_id)
          ON DELETE RESTRICT NOT VALID,
        ADD CONSTRAINT connection_grant_authorizer_type_check
          CHECK (authorized_by_type IS NULL OR authorized_by_type IN ('admin', 'employee')) NOT VALID;
      CREATE INDEX connection_grant_account_status_idx
        ON amazon_sp_api.connection_grant(issuer, account_id, status);
      CREATE INDEX connection_grant_credential_idx
        ON amazon_sp_api.connection_grant(credential_id)
        WHERE credential_id IS NOT NULL;

      ALTER TABLE amazon_sp_api.employee_account_binding
        ADD COLUMN workspace_tenant_id TEXT,
        ADD COLUMN account_id TEXT,
        ADD COLUMN unbound_at TIMESTAMPTZ;
      ALTER TABLE amazon_sp_api.employee_account_binding
        ADD CONSTRAINT employee_account_binding_account_fk
          FOREIGN KEY (account_id) REFERENCES amazon_sp_api.amazon_account(account_id)
          ON DELETE RESTRICT NOT VALID;
      CREATE INDEX employee_binding_employee_status_idx
        ON amazon_sp_api.employee_account_binding(issuer, employee_id, status, updated_at DESC);
      CREATE INDEX employee_binding_account_status_idx
        ON amazon_sp_api.employee_account_binding(issuer, account_id, status)
        WHERE account_id IS NOT NULL;

      ALTER TABLE amazon_sp_api.authorization_attempt
        ADD COLUMN started_by_type TEXT,
        ADD COLUMN started_by_id TEXT,
        ADD COLUMN issuer_scope TEXT,
        ADD COLUMN account_id TEXT,
        ADD COLUMN completed_at TIMESTAMPTZ,
        ADD COLUMN updated_at TIMESTAMPTZ;
      ALTER TABLE amazon_sp_api.authorization_attempt
        ADD CONSTRAINT authorization_attempt_starter_type_check
          CHECK (started_by_type IS NULL OR started_by_type IN ('admin', 'employee')) NOT VALID,
        ADD CONSTRAINT authorization_attempt_account_fk
          FOREIGN KEY (account_id) REFERENCES amazon_sp_api.amazon_account(account_id)
          ON DELETE SET NULL NOT VALID;
      CREATE INDEX authorization_attempt_starter_status_idx
        ON amazon_sp_api.authorization_attempt(started_by_type, started_by_id, status, created_at DESC);
      CREATE INDEX authorization_attempt_scope_status_idx
        ON amazon_sp_api.authorization_attempt(issuer_scope, status, created_at DESC)
        WHERE issuer_scope IS NOT NULL;

      CREATE TABLE amazon_sp_api.data_backfill (
        name TEXT PRIMARY KEY,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        details JSONB NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: "allow_independent_seller_credentials",
    sql: `
      ALTER TABLE amazon_sp_api.oauth_connection
        DROP CONSTRAINT oauth_connection_pkey,
        ADD PRIMARY KEY (selling_partner_id, tenant_id);
      CREATE INDEX oauth_connection_seller_status_idx
        ON amazon_sp_api.oauth_connection(selling_partner_id, status);
    `,
  },
];

export const POSTGRES_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export async function migratePostgres(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      SELECT pg_advisory_xact_lock(
        hashtext('amazon_sp_api'),
        hashtext('schema_migration')
      )
    `);
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS amazon_sp_api;
      CREATE TABLE IF NOT EXISTS amazon_sp_api.schema_migration (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const applied = await client.query<{ version: number; name: string }>(`
      SELECT version, name FROM amazon_sp_api.schema_migration ORDER BY version
    `);
    for (const [index, migration] of applied.rows.entries()) {
      const expected = MIGRATIONS[index];
      if (migration.version !== expected?.version || migration.name !== expected.name) {
        throw new Error(`database migration history diverges at version ${migration.version}`);
      }
    }

    for (const migration of MIGRATIONS.slice(applied.rows.length)) {
      await client.query(migration.sql);
      await client.query(`
        INSERT INTO amazon_sp_api.schema_migration (version, name)
        VALUES ($1, $2)
      `, [migration.version, migration.name]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
