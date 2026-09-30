-- Frozen schema v4 fixture for migration compatibility.
CREATE TABLE ssh_agent_schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at INTEGER NOT NULL
		) STRICT;

CREATE TABLE workspaces (
				id TEXT PRIMARY KEY,
				display_name TEXT NOT NULL,
				environment TEXT NOT NULL CHECK (environment IN ('production', 'staging', 'development', 'other')),
				hostname TEXT NOT NULL,
				port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
				host_key_algorithm TEXT NOT NULL,
				host_key_fingerprint TEXT NOT NULL,
				host_key_verified_at INTEGER NOT NULL,
				default_cwd TEXT NOT NULL,
				connect_timeout_ms INTEGER NOT NULL CHECK (connect_timeout_ms >= 0),
				keepalive_interval_ms INTEGER NOT NULL CHECK (keepalive_interval_ms >= 0),
				keepalive_max_count INTEGER NOT NULL CHECK (keepalive_max_count >= 0),
				revision INTEGER NOT NULL CHECK (revision > 0),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;

CREATE TABLE credentials (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
				display_name TEXT NOT NULL,
				type TEXT NOT NULL CHECK (type IN ('private_key', 'password')),
				remote_user TEXT NOT NULL,
				public_key_fingerprint TEXT,
				has_passphrase INTEGER NOT NULL DEFAULT 0 CHECK (has_passphrase IN (0, 1)),
				is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
				auth_version INTEGER NOT NULL CHECK (auth_version > 0),
				revision INTEGER NOT NULL CHECK (revision > 0),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;

CREATE TABLE credential_secrets (
				credential_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
				auth_version INTEGER NOT NULL CHECK (auth_version > 0),
				secret_type TEXT NOT NULL CHECK (secret_type IN ('private_key', 'password')),
				nonce BLOB NOT NULL,
				ciphertext BLOB NOT NULL,
				auth_tag BLOB NOT NULL
			) STRICT;

CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
				display_name TEXT NOT NULL,
				terminal_context_cursor INTEGER NOT NULL DEFAULT 0 CHECK (terminal_context_cursor >= 0),
				revision INTEGER NOT NULL CHECK (revision > 0),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;

CREATE TABLE guards (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
				enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
				rules_json TEXT NOT NULL,
				revision INTEGER NOT NULL CHECK (revision > 0),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;

CREATE TABLE llm_provider_credentials (
				provider_id TEXT PRIMARY KEY,
				credential_type TEXT NOT NULL CHECK (credential_type IN ('api_key', 'oauth')),
				revision INTEGER NOT NULL CHECK (revision > 0),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;

CREATE TABLE llm_provider_credential_secrets (
				provider_id TEXT PRIMARY KEY REFERENCES llm_provider_credentials(provider_id) ON DELETE CASCADE,
				revision INTEGER NOT NULL CHECK (revision > 0),
				nonce BLOB NOT NULL,
				ciphertext BLOB NOT NULL,
				auth_tag BLOB NOT NULL
			) STRICT;

CREATE TABLE command_operations (
				id TEXT PRIMARY KEY,
				tool_call_id TEXT NOT NULL,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
				command_text TEXT NOT NULL,
				requested_cwd TEXT,
				resolved_cwd TEXT,
				timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
				status TEXT NOT NULL CHECK (status IN ('created', 'queued', 'dispatching', 'running', 'completed', 'failed', 'cancelled', 'blocked', 'uncertain')),
				queue_deadline_at INTEGER NOT NULL,
				execution_context_json TEXT,
				guard_revision INTEGER,
				matched_guard_rule_id TEXT,
				exit_code INTEGER,
				exit_signal TEXT,
				failure_json TEXT,
				output_bytes INTEGER NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
				output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0, 1)),
				created_at INTEGER NOT NULL,
				enqueued_at INTEGER,
				claimed_at INTEGER,
				started_at INTEGER,
				finished_at INTEGER
			) STRICT;

CREATE TABLE command_operation_events (
				operation_id TEXT NOT NULL REFERENCES command_operations(id) ON DELETE CASCADE,
				sequence INTEGER NOT NULL CHECK (sequence > 0),
				timestamp INTEGER NOT NULL,
				type TEXT NOT NULL CHECK (type IN ('status', 'stdout', 'stderr', 'exit', 'output_truncated')),
				data_json TEXT NOT NULL,
				PRIMARY KEY (operation_id, sequence)
			) STRICT;

CREATE INDEX credentials_workspace_id_idx ON credentials(workspace_id);

CREATE UNIQUE INDEX credentials_one_active_per_workspace_idx
				ON credentials(workspace_id) WHERE is_active = 1;

CREATE INDEX sessions_workspace_id_idx ON sessions(workspace_id);

CREATE INDEX command_operations_session_id_idx ON command_operations(session_id, created_at);

CREATE INDEX command_operations_workspace_id_idx ON command_operations(workspace_id, created_at);

CREATE INDEX command_operations_status_idx ON command_operations(status, created_at);
INSERT INTO ssh_agent_schema_migrations (version,applied_at) VALUES (1,1),(2,1),(3,1),(4,1);
