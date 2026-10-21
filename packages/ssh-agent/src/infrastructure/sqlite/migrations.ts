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
	{
		version: 16,
		sql: `
			CREATE TABLE chat_prompt_snapshots (
				session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
				system_prompt TEXT NOT NULL,
				version INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			) STRICT;
			CREATE TRIGGER chat_prompt_snapshot_immutable BEFORE UPDATE ON chat_prompt_snapshots
			BEGIN SELECT RAISE(ABORT, 'Chat prompt snapshots are immutable'); END;

			CREATE TRIGGER chat_prompt_initial_mode AFTER INSERT ON chat_prompt_snapshots
			BEGIN
				INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, message_json, created_at)
				SELECT 'initial-mode:' || NEW.session_id, NEW.session_id, NULL,
					COALESCE(MAX(sequence), 0) + 1, 'system',
					json_object('role', 'system', 'runtimeMode', CASE WHEN EXISTS (SELECT 1 FROM terminal_sessions WHERE session_id = NEW.session_id AND status = 'active') THEN 'terminal' ELSE 'command' END,
						'runtimeEventId', 'initial-mode:' || NEW.session_id,
						'content', json_array(json_object('type', 'text', 'text',
							CASE WHEN EXISTS (SELECT 1 FROM terminal_sessions WHERE session_id = NEW.session_id AND status = 'active') THEN '<terminal-model-on>' ELSE '<terminal-model-off>' END)),
						'timestamp', NEW.created_at), NEW.created_at
				FROM chat_messages WHERE session_id = NEW.session_id
				HAVING NOT EXISTS (SELECT 1 FROM chat_messages WHERE session_id = NEW.session_id AND message_type = 'system');
			END;

			-- A mode event and the terminal transition either both commit or both fail.
			-- Updates while active (resize, ownership, activity) do not emit messages.
			CREATE TRIGGER chat_terminal_mode_transition AFTER UPDATE OF status ON terminal_sessions
			WHEN (OLD.status = 'active') != (NEW.status = 'active')
			BEGIN
				INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, message_json, created_at)
				SELECT 'terminal-mode:' || NEW.id || ':' || NEW.revision, NEW.session_id, NULL,
					COALESCE(MAX(sequence), 0) + 1, 'system',
					json_object('role', 'system', 'runtimeEventId', 'terminal-mode:' || NEW.id || ':' || NEW.revision, 'runtimeMode', CASE NEW.status WHEN 'active' THEN 'terminal' ELSE 'command' END,
						'content', json_array(json_object('type', 'text', 'text',
							CASE NEW.status WHEN 'active' THEN '<terminal-model-on>' ELSE '<terminal-model-off>' END)),
						'timestamp', NEW.updated_at), NEW.updated_at
				FROM chat_messages WHERE session_id = NEW.session_id;
			END;
		`,
	},
	{
		version: 17,
		sql: `
			-- Converge both shipped v16 layouts without rebuilding immutable prompt content.
			DROP TRIGGER IF EXISTS chat_prompt_snapshot_immutable;
			DROP TRIGGER IF EXISTS chat_prompt_initial_mode;
			DROP TRIGGER IF EXISTS chat_terminal_mode_transition;
			CREATE TABLE chat_prompt_snapshots_v17 (
				session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
				system_prompt TEXT NOT NULL,
				version INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			) STRICT;
			INSERT INTO chat_prompt_snapshots_v17 SELECT session_id, system_prompt, version, created_at FROM chat_prompt_snapshots;
			DROP TABLE chat_prompt_snapshots;
			ALTER TABLE chat_prompt_snapshots_v17 RENAME TO chat_prompt_snapshots;
			CREATE TRIGGER chat_prompt_snapshot_immutable BEFORE UPDATE ON chat_prompt_snapshots
			BEGIN SELECT RAISE(ABORT, 'Chat prompt snapshots are immutable'); END;

			CREATE TRIGGER chat_prompt_initial_mode AFTER INSERT ON chat_prompt_snapshots
			BEGIN
				INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, message_json, created_at)
				SELECT 'initial-mode:' || NEW.session_id, NEW.session_id, NULL,
					COALESCE(MAX(sequence), 0) + 1, 'system',
					json_object('role', 'system', 'runtimeMode', CASE WHEN EXISTS (SELECT 1 FROM terminal_sessions WHERE session_id = NEW.session_id AND status = 'active') THEN 'terminal' ELSE 'command' END,
						'runtimeEventId', 'initial-mode:' || NEW.session_id,
						'content', json_array(json_object('type', 'text', 'text',
							CASE WHEN EXISTS (SELECT 1 FROM terminal_sessions WHERE session_id = NEW.session_id AND status = 'active') THEN '<terminal-model-on>' ELSE '<terminal-model-off>' END)),
						'timestamp', NEW.created_at), NEW.created_at
				FROM chat_messages WHERE session_id = NEW.session_id
				HAVING NOT EXISTS (SELECT 1 FROM chat_messages WHERE session_id = NEW.session_id AND message_type = 'system');
			END;

			-- A mode event and the terminal transition either both commit or both fail.
			-- Updates while active (resize, ownership, activity) do not emit messages.
			CREATE TRIGGER chat_terminal_mode_transition AFTER UPDATE OF status ON terminal_sessions
			WHEN (OLD.status = 'active') != (NEW.status = 'active')
			BEGIN
				INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, message_json, created_at)
				SELECT 'terminal-mode:' || NEW.id || ':' || NEW.revision, NEW.session_id, NULL,
					COALESCE(MAX(sequence), 0) + 1, 'system',
					json_object('role', 'system', 'runtimeEventId', 'terminal-mode:' || NEW.id || ':' || NEW.revision, 'runtimeMode', CASE NEW.status WHEN 'active' THEN 'terminal' ELSE 'command' END,
						'content', json_array(json_object('type', 'text', 'text',
							CASE NEW.status WHEN 'active' THEN '<terminal-model-on>' ELSE '<terminal-model-off>' END)),
						'timestamp', NEW.updated_at), NEW.updated_at
				FROM chat_messages WHERE session_id = NEW.session_id;
			END;

			-- Only repair generated mode events; retain their original identity and ordering.
			UPDATE chat_messages SET message_json = json_set(message_json, '$.runtimeEventId', id)
			WHERE message_type = 'system'
				AND (id = 'initial-mode:' || session_id OR id GLOB 'terminal-mode:*')
				AND json_extract(message_json, '$.role') = 'system'
				AND json_extract(message_json, '$.runtimeEventId') IS NULL
				AND ((json_extract(message_json, '$.runtimeMode') = 'terminal'
					AND json_extract(message_json, '$.content[0].text') = '<terminal-model-on>')
					OR (json_extract(message_json, '$.runtimeMode') = 'command'
					AND json_extract(message_json, '$.content[0].text') = '<terminal-model-off>'));
		`,
	},
	{
		version: 18,
		sql: `ALTER TABLE workspaces ADD COLUMN remote_default_cwd TEXT NOT NULL DEFAULT '/';`,
	},
	{
		version: 19,
		sql: `
			ALTER TABLE workspaces ADD COLUMN remote_sandbox_root TEXT;
			ALTER TABLE command_operations ADD COLUMN agent_run_id TEXT;
			ALTER TABLE command_operations ADD COLUMN sandbox_json TEXT;
			ALTER TABLE command_operations ADD COLUMN sandbox_justification TEXT;
		`,
	},
	{
		version: 20,
		sql: `
			ALTER TABLE terminal_sessions ADD COLUMN requested_sandbox_mode TEXT
				CHECK (requested_sandbox_mode IN ('workspace_write', 'full_access'));
			ALTER TABLE terminal_sessions ADD COLUMN sandbox_json TEXT;
		`,
	},
	{
		version: 21,
		sql: `
			-- Preserve the old write boundary when merging the two remote directories.
			UPDATE workspaces SET remote_default_cwd = remote_sandbox_root
			WHERE remote_sandbox_root IS NOT NULL;
			ALTER TABLE workspaces DROP COLUMN remote_sandbox_root;
		`,
	},
	{
		version: 22,
		sql: `
			CREATE TABLE chat_user_decisions (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
				tool_call_id TEXT NOT NULL,
				questions_json TEXT NOT NULL CHECK (json_valid(questions_json)),
				answers_json TEXT CHECK (answers_json IS NULL OR json_valid(answers_json)),
				status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled', 'interrupted')),
				created_at INTEGER NOT NULL,
				resolved_at INTEGER,
				UNIQUE (run_id, tool_call_id)
			) STRICT;
			CREATE INDEX chat_user_decisions_pending_idx
				ON chat_user_decisions(session_id, created_at) WHERE status = 'pending';
		`,
	},
	{
		version: 23,
		sql: `
			CREATE TABLE deployment_runs (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
				status TEXT NOT NULL CHECK (status IN ('preparing', 'running', 'success', 'failed', 'cancelled')),
				snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;
			CREATE INDEX deployment_runs_session_idx ON deployment_runs(session_id, created_at DESC);
		`,
	},
	{
		version: 24,
		sql: `
			CREATE UNIQUE INDEX deployment_runs_planning_agent_idx
				ON deployment_runs(session_id, json_extract(snapshot_json, '$.planningAgentRunId'))
				WHERE json_extract(snapshot_json, '$.planningAgentRunId') IS NOT NULL;
		`,
	},
	{
		version: 25,
		sql: `
			CREATE TABLE deployment_discussions (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
				status TEXT NOT NULL CHECK (status IN ('discussing', 'proposed', 'cancelled')),
				revision INTEGER NOT NULL CHECK (revision > 0),
				snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;
			CREATE UNIQUE INDEX deployment_discussions_active_session_idx
				ON deployment_discussions(session_id) WHERE status = 'discussing';
			CREATE TABLE deployment_discussion_runs (
				discussion_id TEXT NOT NULL REFERENCES deployment_discussions(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				agent_run_id TEXT NOT NULL,
				revision INTEGER NOT NULL CHECK (revision > 0),
				PRIMARY KEY (session_id, agent_run_id)
			) STRICT;
			CREATE INDEX deployment_discussion_runs_discussion_idx ON deployment_discussion_runs(discussion_id, revision);
		`,
	},
	{
		version: 26,
		sql: `
			CREATE TABLE deployment_runs_v26 (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
				status TEXT NOT NULL CHECK (status IN ('preparing', 'running', 'recovering', 'success', 'failed', 'cancelled')),
				snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;
			INSERT INTO deployment_runs_v26 SELECT * FROM deployment_runs;
			DROP TABLE deployment_runs;
			ALTER TABLE deployment_runs_v26 RENAME TO deployment_runs;
			CREATE INDEX deployment_runs_session_idx ON deployment_runs(session_id, created_at DESC);
			CREATE UNIQUE INDEX deployment_runs_planning_agent_idx
				ON deployment_runs(session_id, json_extract(snapshot_json, '$.planningAgentRunId'))
				WHERE json_extract(snapshot_json, '$.planningAgentRunId') IS NOT NULL;
		`,
	},
	{
		version: 27,
		sql: `ALTER TABLE sessions ADD COLUMN sandbox_enabled INTEGER NOT NULL DEFAULT 1
			CHECK (sandbox_enabled IN (0, 1));`,
	},
	{
		version: 28,
		sql: `
			ALTER TABLE workspaces ADD COLUMN sandbox_writable_roots_json TEXT
				CHECK (sandbox_writable_roots_json IS NULL OR (json_valid(sandbox_writable_roots_json) AND json_type(sandbox_writable_roots_json) = 'array'));
			ALTER TABLE sessions ADD COLUMN sandbox_writable_roots_json TEXT
				CHECK (sandbox_writable_roots_json IS NULL OR (json_valid(sandbox_writable_roots_json) AND json_type(sandbox_writable_roots_json) = 'array'));
			UPDATE workspaces SET sandbox_writable_roots_json = CASE
				WHEN remote_default_cwd = '/' THEN '[]' ELSE json_array(remote_default_cwd) END;
			UPDATE sessions SET sandbox_writable_roots_json = (
				SELECT sandbox_writable_roots_json FROM workspaces WHERE workspaces.id = sessions.workspace_id
			);
		`,
	},
	{
		version: 29,
		sql: `
			CREATE INDEX statistics_messages_created_idx ON chat_messages(created_at)
				WHERE message_type IN ('assistant', 'compact');
			CREATE INDEX statistics_messages_run_idx ON chat_messages(run_id)
				WHERE message_type IN ('assistant', 'compact');
			CREATE INDEX statistics_runs_created_idx ON chat_runs(created_at DESC, id DESC);
			CREATE INDEX statistics_runs_workspace_created_idx ON chat_runs(workspace_id, created_at DESC, id DESC);
			CREATE INDEX statistics_runs_started_idx ON chat_runs(started_at) WHERE started_at IS NOT NULL;
		`,
	},
	{
		version: 30,
		sql: `
			CREATE TABLE deployment_sessions (
				id TEXT PRIMARY KEY REFERENCES deployment_discussions(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
				title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
				created_at INTEGER NOT NULL CHECK (created_at >= 0),
				outcome TEXT CHECK (outcome IN ('success', 'failed', 'cancelled')),
				reason TEXT,
				finished_at INTEGER,
				CHECK ((outcome IS NULL AND finished_at IS NULL) OR (outcome IS NOT NULL AND finished_at IS NOT NULL AND finished_at >= created_at))
			) STRICT;
			CREATE UNIQUE INDEX deployment_sessions_active_idx ON deployment_sessions(session_id) WHERE outcome IS NULL;
			CREATE TRIGGER deployment_history_message AFTER INSERT ON deployment_sessions
			BEGIN
				INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, message_json, created_at)
				SELECT 'deployment:' || NEW.id, NEW.session_id, NULL, COALESCE(MAX(sequence), 0) + 1, 'deployment',
					json_object('role', 'custom', 'customType', 'deployment', 'display', json('true'),
						'content', NEW.title, 'details', json_object('deploymentId', NEW.id, 'title', NEW.title),
						'timestamp', NEW.created_at), NEW.created_at
				FROM chat_messages WHERE session_id = NEW.session_id;
			END;
		`,
	},
	{
		version: 31,
		sql: `
			CREATE TABLE deployment_stage_executions (
				id TEXT PRIMARY KEY,
				deployment_run_id TEXT NOT NULL REFERENCES deployment_runs(id) ON DELETE CASCADE,
				request_id TEXT NOT NULL,
				agent_run_id TEXT NOT NULL,
				stage TEXT NOT NULL CHECK (stage IN ('build', 'upload', 'restart', 'verify')),
				plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
				status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped', 'interrupted')),
				started_at INTEGER NOT NULL,
				finished_at INTEGER,
				result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
				UNIQUE (deployment_run_id, request_id)
			) STRICT;
			CREATE TABLE deployment_logs (
				deployment_run_id TEXT NOT NULL REFERENCES deployment_runs(id) ON DELETE CASCADE,
				sequence INTEGER NOT NULL CHECK (sequence > 0),
				execution_id TEXT NOT NULL REFERENCES deployment_stage_executions(id) ON DELETE CASCADE,
				stage TEXT NOT NULL CHECK (stage IN ('build', 'upload', 'restart', 'verify')),
				timestamp INTEGER NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('boundary', 'output', 'result')),
				text TEXT NOT NULL,
				PRIMARY KEY (deployment_run_id, sequence)
			) STRICT;
			CREATE INDEX deployment_logs_stage_idx ON deployment_logs(deployment_run_id, stage, sequence);
			CREATE UNIQUE INDEX deployment_stage_executions_running_idx ON deployment_stage_executions(deployment_run_id) WHERE status = 'running';
		`,
	},
	{
		version: 32,
		sql: `ALTER TABLE workspaces DROP COLUMN remote_default_cwd;`,
	},
	{
		version: 33,
		sql: `
			-- Historical UI entries keep their sequence; the client positions them by finish time.
			UPDATE chat_messages SET message_json = json_set(message_json,
				'$.details.position', 'legacy_finished',
				'$.details.startedAt', (SELECT created_at FROM deployment_sessions WHERE 'deployment:' || id = chat_messages.id),
				'$.details.outcome', (SELECT outcome FROM deployment_sessions WHERE 'deployment:' || id = chat_messages.id),
				'$.details.finishedAt', (SELECT finished_at FROM deployment_sessions WHERE 'deployment:' || id = chat_messages.id),
				'$.details.reason', (SELECT reason FROM deployment_sessions WHERE 'deployment:' || id = chat_messages.id))
			WHERE message_type = 'deployment' AND id IN (SELECT 'deployment:' || id FROM deployment_sessions WHERE outcome IS NOT NULL);

			-- One stable UI message moves to the actual finish boundary, including pre-plan exits.
			CREATE TRIGGER deployment_history_finished AFTER UPDATE OF outcome ON deployment_sessions
			WHEN OLD.outcome IS NULL AND NEW.outcome IS NOT NULL
			BEGIN
				UPDATE chat_messages SET
					sequence = (SELECT COALESCE(MAX(sequence), 0) + 1 FROM chat_messages WHERE session_id = NEW.session_id),
					created_at = NEW.finished_at,
					message_json = json_set(message_json, '$.timestamp', NEW.finished_at,
						'$.details.position', 'finished', '$.details.startedAt', NEW.created_at, '$.details.outcome', NEW.outcome,
						'$.details.finishedAt', NEW.finished_at, '$.details.reason', NEW.reason)
				WHERE session_id = NEW.session_id AND id = 'deployment:' || NEW.id AND message_type = 'deployment';
			END;
		`,
	},
	{
		version: 34,
		sql: `ALTER TABLE sessions ADD COLUMN sandbox_read_only INTEGER NOT NULL DEFAULT 0
			CHECK (sandbox_read_only IN (0, 1) AND (sandbox_read_only = 0 OR sandbox_enabled = 1));`,
	},
	{
		version: 35,
		sql: `
			CREATE TABLE diagnose_tasks (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
				request_id TEXT NOT NULL,
				title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
				status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
				revision INTEGER NOT NULL CHECK (revision > 0),
				current_sequence INTEGER NOT NULL DEFAULT 0 CHECK (current_sequence >= 0),
				conclusion_markdown TEXT,
				conclusion_request_json TEXT CHECK (conclusion_request_json IS NULL OR json_valid(conclusion_request_json)),
				created_at INTEGER NOT NULL CHECK (created_at >= 0),
				updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
				finished_at INTEGER,
				UNIQUE (session_id, request_id),
				CHECK ((status = 'active' AND finished_at IS NULL AND conclusion_markdown IS NULL)
					OR (status = 'cancelled' AND finished_at IS NOT NULL AND finished_at >= created_at AND conclusion_markdown IS NULL)
					OR (status = 'completed' AND finished_at IS NOT NULL AND finished_at >= created_at AND conclusion_markdown IS NOT NULL AND length(trim(conclusion_markdown)) > 0))
			) STRICT;
			CREATE UNIQUE INDEX diagnose_active_session_idx ON diagnose_tasks(session_id) WHERE status = 'active';
			CREATE TABLE diagnose_nodes (
				task_id TEXT NOT NULL REFERENCES diagnose_tasks(id) ON DELETE CASCADE,
				sequence INTEGER NOT NULL CHECK (sequence > 0),
				direction TEXT NOT NULL CHECK (length(direction) BETWEEN 1 AND 500),
				status TEXT NOT NULL CHECK (status IN ('diagnosing', 'confirmed', 'unconfirmed')),
				explanation TEXT NOT NULL,
				revision INTEGER NOT NULL CHECK (revision > 0),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
				PRIMARY KEY (task_id, sequence),
				CHECK (status = 'diagnosing' OR length(trim(explanation)) > 0)
			) STRICT;
			CREATE TRIGGER diagnose_task_immutable BEFORE UPDATE ON diagnose_tasks
			WHEN OLD.status != 'active' OR NEW.id != OLD.id OR NEW.session_id != OLD.session_id
				OR NEW.workspace_id != OLD.workspace_id OR NEW.request_id != OLD.request_id OR NEW.created_at != OLD.created_at
				OR NEW.current_sequence < OLD.current_sequence OR NEW.current_sequence > OLD.current_sequence + 1
				OR (NEW.current_sequence > OLD.current_sequence AND NOT EXISTS (SELECT 1 FROM diagnose_nodes WHERE task_id = OLD.id AND sequence = NEW.current_sequence))
			BEGIN SELECT RAISE(ABORT, 'Ended diagnosis tasks are immutable'); END;
			CREATE TRIGGER diagnose_node_current_only BEFORE UPDATE ON diagnose_nodes
			WHEN NEW.task_id != OLD.task_id OR NEW.sequence != OLD.sequence OR NEW.created_at != OLD.created_at
				OR NOT EXISTS (SELECT 1 FROM diagnose_tasks WHERE id = OLD.task_id AND status = 'active' AND current_sequence = OLD.sequence)
			BEGIN SELECT RAISE(ABORT, 'Only the active current diagnosis record can change'); END;
			CREATE TRIGGER diagnose_node_append_only BEFORE INSERT ON diagnose_nodes
			WHEN NOT EXISTS (SELECT 1 FROM diagnose_tasks WHERE id = NEW.task_id AND status = 'active' AND current_sequence + 1 = NEW.sequence)
				OR EXISTS (SELECT 1 FROM diagnose_nodes WHERE task_id = NEW.task_id AND sequence = NEW.sequence - 1
					AND (status = 'diagnosing' OR length(trim(explanation)) = 0))
			BEGIN SELECT RAISE(ABORT, 'Finish the current diagnosis record before appending'); END;
			CREATE TABLE diagnose_tool_calls (
				task_id TEXT NOT NULL REFERENCES diagnose_tasks(id) ON DELETE CASCADE,
				run_id TEXT NOT NULL,
				tool_call_id TEXT NOT NULL,
				request_json TEXT NOT NULL CHECK (json_valid(request_json)),
				result_json TEXT NOT NULL CHECK (json_valid(result_json)),
				PRIMARY KEY (task_id, run_id, tool_call_id)
			) STRICT;
			CREATE TABLE diagnose_chat_runs (
				run_id TEXT PRIMARY KEY REFERENCES chat_runs(id) ON DELETE CASCADE,
				task_id TEXT NOT NULL REFERENCES diagnose_tasks(id) ON DELETE CASCADE
			) STRICT;
			CREATE TABLE diagnose_requests (
				task_id TEXT NOT NULL REFERENCES diagnose_tasks(id) ON DELETE CASCADE,
				request_id TEXT NOT NULL,
				run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
				queue_item_id TEXT REFERENCES chat_queue_items(id) ON DELETE CASCADE,
				PRIMARY KEY (task_id, request_id)
			) STRICT;
			CREATE TRIGGER diagnose_history_created AFTER INSERT ON diagnose_tasks
			BEGIN
				INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, message_json, created_at)
				SELECT 'diagnose:' || NEW.id, NEW.session_id, NULL, COALESCE(MAX(sequence), 0) + 1, 'diagnose',
					json_object('role', 'custom', 'customType', 'diagnose', 'display', json('true'), 'content', NEW.title,
						'details', json_object('taskId', NEW.id, 'title', NEW.title, 'status', NEW.status, 'revision', NEW.revision),
						'timestamp', NEW.created_at), NEW.created_at
				FROM chat_messages WHERE session_id = NEW.session_id;
			END;
			CREATE TRIGGER diagnose_history_updated AFTER UPDATE ON diagnose_tasks
			BEGIN
				UPDATE chat_messages SET
					sequence = CASE WHEN OLD.status = 'active' AND NEW.status != 'active'
						THEN (SELECT COALESCE(MAX(sequence), 0) + 1 FROM chat_messages WHERE session_id = NEW.session_id) ELSE sequence END,
					created_at = COALESCE(NEW.finished_at, NEW.created_at),
					message_json = json_set(message_json, '$.content', NEW.title, '$.details.title', NEW.title,
						'$.details.status', NEW.status, '$.details.revision', NEW.revision, '$.timestamp', COALESCE(NEW.finished_at, NEW.created_at))
				WHERE session_id = NEW.session_id AND id = 'diagnose:' || NEW.id;
			END;
		`,
	},
	{
		version: 36,
		sql: `
			CREATE TABLE chat_runtime_context_heads (
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				channel TEXT NOT NULL,
				revision INTEGER NOT NULL CHECK (revision > 0),
				content_hash TEXT NOT NULL,
				message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
				PRIMARY KEY (session_id, channel)
			) STRICT;
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
