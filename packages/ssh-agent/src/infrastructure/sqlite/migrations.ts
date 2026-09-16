import type { DatabaseSync } from "node:sqlite";

const MIGRATIONS = [
	{
		version: 1,
		sql: `
			CREATE TABLE credentials (
				id TEXT PRIMARY KEY,
				display_name TEXT NOT NULL,
				type TEXT NOT NULL CHECK (type IN ('private_key', 'password')),
				remote_user TEXT NOT NULL,
				public_key_fingerprint TEXT,
				has_passphrase INTEGER NOT NULL DEFAULT 0 CHECK (has_passphrase IN (0, 1)),
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

			CREATE TABLE workspaces (
				id TEXT PRIMARY KEY,
				display_name TEXT NOT NULL,
				environment TEXT NOT NULL CHECK (environment IN ('production', 'staging', 'development', 'other')),
				hostname TEXT NOT NULL,
				port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
				host_key_algorithm TEXT NOT NULL,
				host_key_fingerprint TEXT NOT NULL,
				host_key_verified_at INTEGER NOT NULL,
				credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE RESTRICT,
				default_cwd TEXT NOT NULL,
				connect_timeout_ms INTEGER NOT NULL CHECK (connect_timeout_ms >= 0),
				keepalive_interval_ms INTEGER NOT NULL CHECK (keepalive_interval_ms >= 0),
				keepalive_max_count INTEGER NOT NULL CHECK (keepalive_max_count >= 0),
				revision INTEGER NOT NULL CHECK (revision > 0),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;
			CREATE INDEX workspaces_credential_id_idx ON workspaces(credential_id);

			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
				display_name TEXT NOT NULL,
				terminal_context_cursor INTEGER NOT NULL DEFAULT 0 CHECK (terminal_context_cursor >= 0),
				revision INTEGER NOT NULL CHECK (revision > 0),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;
			CREATE INDEX sessions_workspace_id_idx ON sessions(workspace_id);

			CREATE TABLE guards (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
				enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
				rules_json TEXT NOT NULL,
				revision INTEGER NOT NULL CHECK (revision > 0),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;
		`,
	},
	{
		version: 2,
		requiresEmptyManagementData: true,
		sql: `
			DROP TABLE guards;
			DROP TABLE sessions;
			DROP TABLE workspaces;
			DROP TABLE credential_secrets;
			DROP TABLE credentials;

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
			CREATE INDEX credentials_workspace_id_idx ON credentials(workspace_id);
			CREATE UNIQUE INDEX credentials_one_active_per_workspace_idx
				ON credentials(workspace_id) WHERE is_active = 1;

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
			CREATE INDEX sessions_workspace_id_idx ON sessions(workspace_id);

			CREATE TABLE guards (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
				enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
				rules_json TEXT NOT NULL,
				revision INTEGER NOT NULL CHECK (revision > 0),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;
		`,
	},
	{
		version: 3,
		sql: `
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
		`,
	},
	{
		version: 4,
		sql: `
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
			CREATE INDEX command_operations_session_id_idx ON command_operations(session_id, created_at);
			CREATE INDEX command_operations_workspace_id_idx ON command_operations(workspace_id, created_at);
			CREATE INDEX command_operations_status_idx ON command_operations(status, created_at);

			CREATE TABLE command_operation_events (
				operation_id TEXT NOT NULL REFERENCES command_operations(id) ON DELETE CASCADE,
				sequence INTEGER NOT NULL CHECK (sequence > 0),
				timestamp INTEGER NOT NULL,
				type TEXT NOT NULL CHECK (type IN ('status', 'stdout', 'stderr', 'exit', 'output_truncated')),
				data_json TEXT NOT NULL,
				PRIMARY KEY (operation_id, sequence)
			) STRICT;
		`,
	},
	{
		version: 5,
		sql: `
			CREATE TABLE workspace_host_trusts (
				workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
				algorithm TEXT NOT NULL CHECK (length(algorithm) > 0),
				fingerprint TEXT NOT NULL CHECK (length(fingerprint) > 0),
				verified_at INTEGER NOT NULL CHECK (verified_at >= 0)
			) STRICT;

			INSERT INTO workspace_host_trusts (workspace_id, algorithm, fingerprint, verified_at)
			SELECT id, host_key_algorithm, host_key_fingerprint, host_key_verified_at
			FROM workspaces;

			ALTER TABLE workspaces DROP COLUMN host_key_algorithm;
			ALTER TABLE workspaces DROP COLUMN host_key_fingerprint;
			ALTER TABLE workspaces DROP COLUMN host_key_verified_at;
		`,
	},
	{
		version: 6,
		sql: `
			CREATE TABLE file_transfers (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
				direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
				remote_path TEXT NOT NULL,
				file_name TEXT NOT NULL,
				total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
				bytes_transferred INTEGER NOT NULL DEFAULT 0 CHECK (bytes_transferred >= 0),
				overwrite INTEGER NOT NULL DEFAULT 0 CHECK (overwrite IN (0, 1)),
				status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'uncertain')),
				target_json TEXT NOT NULL,
				failure_json TEXT,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER,
				updated_at INTEGER NOT NULL
			) STRICT;
			CREATE INDEX file_transfers_workspace_id_idx ON file_transfers(workspace_id, created_at DESC);
			CREATE INDEX file_transfers_status_idx ON file_transfers(status, created_at);
		`,
	},
	{
		version: 7,
		sql: `
			ALTER TABLE sessions ADD COLUMN work_dir TEXT;
			ALTER TABLE sessions ADD COLUMN auto_audit INTEGER NOT NULL DEFAULT 0
				CHECK (auto_audit IN (0, 1));

			CREATE TABLE chat_runs (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
				request_id TEXT NOT NULL,
				provider_id TEXT NOT NULL,
				model_id TEXT NOT NULL,
				thinking_level TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
				failure_json TEXT,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER,
				updated_at INTEGER NOT NULL,
				UNIQUE(session_id, request_id)
			) STRICT;
			CREATE UNIQUE INDEX chat_runs_one_active_session_idx
				ON chat_runs(session_id) WHERE status IN ('pending', 'running');

			CREATE TABLE chat_messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				run_id TEXT REFERENCES chat_runs(id) ON DELETE SET NULL,
				sequence INTEGER NOT NULL,
				message_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				UNIQUE(session_id, sequence)
			) STRICT;

			CREATE TABLE chat_queue_items (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
				request_id TEXT NOT NULL,
				behavior TEXT NOT NULL CHECK (behavior IN ('steer', 'follow_up')),
				message_json TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'cancelled')),
				created_at INTEGER NOT NULL,
				resolved_at INTEGER,
				UNIQUE(session_id, request_id)
			) STRICT;

			CREATE TABLE chat_tool_approvals (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
				assistant_message_id TEXT NOT NULL,
				tool_call_id TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
				source TEXT CHECK (source IN ('user', 'auto')),
				rejection_reason TEXT CHECK (rejection_reason IN ('user_rejected', 'timeout', 'run_cancelled', 'server_restarted')),
				created_at INTEGER NOT NULL,
				resolved_at INTEGER,
				UNIQUE(run_id, tool_call_id)
			) STRICT;

			CREATE TABLE agent_session_entries (
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				entry_json TEXT NOT NULL,
				PRIMARY KEY(session_id, id),
				UNIQUE(session_id, sequence)
			) STRICT;
			CREATE TABLE agent_session_records (
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				record_json TEXT NOT NULL,
				PRIMARY KEY(session_id, id),
				UNIQUE(session_id, sequence)
			) STRICT;
			CREATE TABLE agent_session_lanes (
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				lane TEXT NOT NULL,
				leaf_id TEXT,
				PRIMARY KEY(session_id, lane)
			) STRICT;
			CREATE TABLE agent_session_facts (
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				fact_key TEXT NOT NULL,
				fact_value_json TEXT,
				PRIMARY KEY(session_id, fact_key)
			) STRICT;
		`,
	},
	{
		version: 8,
		sql: `
			ALTER TABLE chat_tool_approvals
			ADD COLUMN description TEXT NOT NULL DEFAULT '';
		`,
	},
	{
		version: 9,
		sql: `
			CREATE TABLE llm_provider_model_catalogs (
				provider_id TEXT PRIMARY KEY,
				models_json TEXT NOT NULL,
				checked_at INTEGER NOT NULL CHECK (checked_at >= 0),
				etag TEXT
			) STRICT;
		`,
	},
	{
		version: 10,
		sql: `
			CREATE TABLE terminal_sessions (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
				open_request_id TEXT NOT NULL,
				close_request_id TEXT,
				status TEXT NOT NULL CHECK (status IN ('opening', 'active', 'closing', 'closed', 'failed', 'lost')),
				revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
				connection_generation INTEGER,
				term TEXT NOT NULL CHECK (term = 'xterm-256color'),
				rows INTEGER NOT NULL CHECK (rows > 0),
				cols INTEGER NOT NULL CHECK (cols > 0),
				last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
				ownership_epoch INTEGER NOT NULL DEFAULT 0 CHECK (ownership_epoch >= 0),
				last_consumer_activity_at INTEGER NOT NULL,
				idle_deadline_at INTEGER,
				close_reason TEXT CHECK (close_reason IN ('user_requested', 'idle_timeout', 'session_deleted', 'shell_exited', 'connection_lost', 'backend_shutdown', 'backend_restarted', 'open_failed')),
				activated_at INTEGER,
				closing_at INTEGER,
				closed_at INTEGER,
				failure_code TEXT,
				failure_message TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE (session_id, open_request_id)
			) STRICT;
			CREATE UNIQUE INDEX terminal_sessions_one_live_per_session_idx
				ON terminal_sessions(session_id) WHERE status IN ('opening', 'active', 'closing');
			CREATE INDEX terminal_sessions_status_idle_idx ON terminal_sessions(status, idle_deadline_at);

			ALTER TABLE chat_runs
				ADD COLUMN server_interaction_mode TEXT NOT NULL DEFAULT 'command'
				CHECK (server_interaction_mode IN ('command', 'terminal'));
			ALTER TABLE chat_runs
				ADD COLUMN terminal_session_id TEXT REFERENCES terminal_sessions(id);

			CREATE TABLE terminal_interactions (
				id TEXT PRIMARY KEY,
				terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				agent_run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
				tool_call_id TEXT NOT NULL,
				action_json TEXT NOT NULL,
				expectation TEXT NOT NULL CHECK (expectation IN ('finite', 'interactive', 'streaming')),
				status TEXT NOT NULL CHECK (status IN ('prepared', 'awaiting_approval', 'approved', 'writing', 'observing', 'completed', 'rejected', 'cancelled', 'failed', 'write_uncertain')),
				input_sequence INTEGER,
				observation_id TEXT,
				guard_decision_json TEXT,
				approval_required INTEGER NOT NULL CHECK (approval_required IN (0, 1)),
				failure_json TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				UNIQUE (agent_run_id, tool_call_id)
			) STRICT;
			CREATE INDEX terminal_interactions_terminal_status_idx
				ON terminal_interactions(terminal_session_id, status, created_at);

			CREATE TABLE terminal_inputs (
				id TEXT PRIMARY KEY,
				interaction_id TEXT NOT NULL UNIQUE REFERENCES terminal_interactions(id) ON DELETE CASCADE,
				terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
				display_text TEXT NOT NULL,
				input_kind TEXT NOT NULL CHECK (input_kind IN ('submit', 'semantic_key')),
				encoded_bytes BLOB NOT NULL,
				byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
				status TEXT NOT NULL CHECK (status IN ('prepared', 'written', 'uncertain', 'blocked')),
				terminal_sequence INTEGER,
				guard_revision INTEGER,
				matched_guard_rule_id TEXT,
				created_at INTEGER NOT NULL,
				written_at INTEGER
			) STRICT;

			CREATE TABLE terminal_observations (
				id TEXT PRIMARY KEY,
				interaction_id TEXT NOT NULL UNIQUE REFERENCES terminal_interactions(id) ON DELETE CASCADE,
				terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
				start_sequence INTEGER NOT NULL CHECK (start_sequence >= 0),
				end_sequence INTEGER NOT NULL CHECK (end_sequence >= start_sequence),
				kind TEXT NOT NULL CHECK (kind IN ('transcript', 'screen')),
				rows INTEGER NOT NULL CHECK (rows > 0),
				cols INTEGER NOT NULL CHECK (cols > 0),
				boundary_reason TEXT NOT NULL CHECK (boundary_reason IN ('channel_closed', 'output_limit', 'prompt', 'snapshot', 'quiet', 'timeout')),
				agent_view_text TEXT NOT NULL,
				raw_byte_count INTEGER NOT NULL CHECK (raw_byte_count >= 0),
				truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
				captured_at INTEGER NOT NULL,
				delivered_at INTEGER,
				processing_at INTEGER,
				finished_at INTEGER
			) STRICT;

			CREATE TABLE terminal_timeline_events (
				id TEXT PRIMARY KEY,
				terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				timeline_sequence INTEGER NOT NULL CHECK (timeline_sequence > 0),
				terminal_event_sequence INTEGER,
				type TEXT NOT NULL CHECK (type IN ('terminal.opening', 'terminal.active', 'terminal.closing', 'terminal.closed', 'terminal.failed', 'terminal.lost', 'terminal.input', 'observation.captured', 'observation.delivered', 'observation.processing', 'observation.finished')),
				interaction_id TEXT,
				observation_id TEXT,
				agent_run_id TEXT,
				data_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				UNIQUE (terminal_session_id, timeline_sequence)
			) STRICT;
			CREATE INDEX terminal_timeline_session_sequence_idx
				ON terminal_timeline_events(session_id, created_at DESC, id DESC);
		`,
	},
	{
		version: 11,
		sql: `
			CREATE TABLE llm_custom_providers (
				id TEXT PRIMARY KEY CHECK (id GLOB 'custom-*'),
				name TEXT NOT NULL CHECK (length(name) > 0),
				base_url TEXT NOT NULL CHECK (length(base_url) > 0),
				api TEXT NOT NULL CHECK (api IN ('openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai')),
				auth_mode TEXT NOT NULL CHECK (auth_mode IN ('api_key', 'none')),
				compat_json TEXT NOT NULL,
				models_json TEXT NOT NULL,
				revision INTEGER NOT NULL CHECK (revision > 0),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;
		`,
	},
	{
		version: 12,
		sql: `
			CREATE TABLE chat_messages_v12 (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				run_id TEXT REFERENCES chat_runs(id) ON DELETE SET NULL,
				sequence INTEGER NOT NULL,
				message_type TEXT NOT NULL CHECK (length(message_type) > 0),
				provider TEXT,
				usage_json TEXT,
				message_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				UNIQUE(session_id, sequence)
			) STRICT;

			INSERT INTO chat_messages_v12 (
				id, session_id, run_id, sequence, message_type, provider, usage_json, message_json, created_at
			)
			SELECT
				id,
				session_id,
				run_id,
				sequence,
				CASE json_extract(message_json, '$.role')
					WHEN 'user' THEN 'user'
					WHEN 'assistant' THEN 'assistant'
					WHEN 'toolResult' THEN 'tool'
					WHEN 'compactionSummary' THEN 'compact'
					WHEN 'bashExecution' THEN 'bash_execution'
					WHEN 'branchSummary' THEN 'branch_summary'
					WHEN 'custom' THEN 'custom'
					ELSE COALESCE(json_extract(message_json, '$.role'), 'custom')
				END,
				CASE WHEN json_extract(message_json, '$.role') = 'assistant'
					THEN json_extract(message_json, '$.provider') ELSE NULL END,
				CASE WHEN json_type(message_json, '$.usage') = 'object'
					THEN json_extract(message_json, '$.usage') ELSE NULL END,
				message_json,
				created_at
			FROM chat_messages;

			DROP TABLE chat_messages;
			ALTER TABLE chat_messages_v12 RENAME TO chat_messages;
			DROP TABLE agent_session_entries;

			CREATE TABLE chat_compaction_settings (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				trigger_percent INTEGER NOT NULL CHECK (trigger_percent BETWEEN 1 AND 99),
				provider_id TEXT,
				model_id TEXT,
				revision INTEGER NOT NULL CHECK (revision > 0),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				CHECK ((provider_id IS NULL) = (model_id IS NULL))
			) STRICT;

			INSERT INTO chat_compaction_settings (
				id, trigger_percent, provider_id, model_id, revision, created_at, updated_at
			) VALUES (
				1, 80, NULL, NULL, 1,
				CAST(strftime('%s', 'now') AS INTEGER) * 1000,
				CAST(strftime('%s', 'now') AS INTEGER) * 1000
			);
		`,
	},
	{
		version: 13,
		sql: `
			ALTER TABLE chat_tool_approvals ADD COLUMN description_message_key TEXT;
			ALTER TABLE chat_tool_approvals ADD COLUMN description_values_json TEXT;
			ALTER TABLE terminal_sessions ADD COLUMN failure_message_key TEXT;
			ALTER TABLE terminal_sessions ADD COLUMN failure_message_values_json TEXT;
		`,
	},
	{
		version: 14,
		sql: `
			CREATE TABLE attachments (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				name TEXT NOT NULL CHECK (length(name) > 0),
				mime_type TEXT NOT NULL CHECK (length(mime_type) > 0),
				size INTEGER NOT NULL CHECK (size >= 0),
				storage_path TEXT NOT NULL UNIQUE CHECK (length(storage_path) > 0),
				created_at INTEGER NOT NULL,
				UNIQUE(session_id, name)
			) STRICT;
			CREATE INDEX attachments_session_created_idx
				ON attachments(session_id, created_at DESC, id DESC);
		`,
	},
	{
		version: 15,
		sql: `
			CREATE TABLE chat_message_attachments (
				message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
				attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
				ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
				PRIMARY KEY (message_id, attachment_id),
				UNIQUE (message_id, ordinal)
			) STRICT;
			CREATE INDEX chat_message_attachments_attachment_idx
				ON chat_message_attachments(attachment_id);
		`,
	},
] as const;

export function applyMigrations(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS ssh_agent_schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at INTEGER NOT NULL
		) STRICT;
	`);
	const hasMigration = database.prepare("SELECT 1 FROM ssh_agent_schema_migrations WHERE version = ?");
	const recordMigration = database.prepare(
		"INSERT INTO ssh_agent_schema_migrations (version, applied_at) VALUES (?, ?)",
	);
	for (const migration of MIGRATIONS) {
		if (hasMigration.get(migration.version)) continue;
		if ("requiresEmptyManagementData" in migration && migration.requiresEmptyManagementData) {
			requireEmptyManagementData(database, migration.version);
		}
		database.exec("BEGIN IMMEDIATE");
		try {
			database.exec(migration.sql);
			recordMigration.run(migration.version, Date.now());
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	}
}

function requireEmptyManagementData(database: DatabaseSync, targetVersion: number): void {
	for (const table of ["credentials", "workspaces", "sessions", "guards"] as const) {
		if (database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined) {
			throw new Error(
				`SSH Agent database contains schema v1 management data and requires a development rebuild before schema v${targetVersion}. Back up and remove the database file, then restart.`,
			);
		}
	}
}
