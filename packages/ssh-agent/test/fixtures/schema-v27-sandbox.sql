-- Frozen full v27 schema, built from the frozen v11 schema and historical migrations 12-27.
-- Independent of current migrations; includes chat/deploy dependencies needed by later schema validation.
PRAGMA foreign_keys = ON;
CREATE TABLE ssh_agent_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;

CREATE TABLE workspaces (
	id TEXT PRIMARY KEY,
	display_name TEXT NOT NULL,
	environment TEXT NOT NULL CHECK (environment IN ('production', 'staging', 'development', 'other')),
	hostname TEXT NOT NULL,
	port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
	default_cwd TEXT NOT NULL,
	connect_timeout_ms INTEGER NOT NULL CHECK (connect_timeout_ms >= 0),
	keepalive_interval_ms INTEGER NOT NULL CHECK (keepalive_interval_ms >= 0),
	keepalive_max_count INTEGER NOT NULL CHECK (keepalive_max_count >= 0),
	revision INTEGER NOT NULL CHECK (revision > 0),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
, remote_default_cwd TEXT NOT NULL DEFAULT '/') STRICT;

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
, work_dir TEXT, auto_audit INTEGER NOT NULL DEFAULT 0
	CHECK (auto_audit IN (0, 1)), sandbox_enabled INTEGER NOT NULL DEFAULT 1
			CHECK (sandbox_enabled IN (0, 1))) STRICT;

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
, agent_run_id TEXT, sandbox_json TEXT, sandbox_justification TEXT) STRICT;

CREATE TABLE command_operation_events (
	operation_id TEXT NOT NULL REFERENCES command_operations(id) ON DELETE CASCADE,
	sequence INTEGER NOT NULL CHECK (sequence > 0),
	timestamp INTEGER NOT NULL,
	type TEXT NOT NULL CHECK (type IN ('status', 'stdout', 'stderr', 'exit', 'output_truncated')),
	data_json TEXT NOT NULL,
	PRIMARY KEY (operation_id, sequence)
) STRICT;

CREATE TABLE workspace_host_trusts (
	workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
	algorithm TEXT NOT NULL CHECK (length(algorithm) > 0),
	fingerprint TEXT NOT NULL CHECK (length(fingerprint) > 0),
	verified_at INTEGER NOT NULL CHECK (verified_at >= 0)
) STRICT;

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
	updated_at INTEGER NOT NULL, server_interaction_mode TEXT NOT NULL DEFAULT 'command'
	CHECK (server_interaction_mode IN ('command', 'terminal')), terminal_session_id TEXT REFERENCES terminal_sessions(id),
	UNIQUE(session_id, request_id)
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
	resolved_at INTEGER, description TEXT NOT NULL DEFAULT '', description_message_key TEXT, description_values_json TEXT,
	UNIQUE(run_id, tool_call_id)
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

CREATE TABLE llm_provider_model_catalogs (
	provider_id TEXT PRIMARY KEY,
	models_json TEXT NOT NULL,
	checked_at INTEGER NOT NULL CHECK (checked_at >= 0),
	etag TEXT
) STRICT;

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
	updated_at INTEGER NOT NULL, failure_message_key TEXT, failure_message_values_json TEXT, requested_sandbox_mode TEXT
				CHECK (requested_sandbox_mode IN ('workspace_write', 'full_access')), sandbox_json TEXT,
	UNIQUE (session_id, open_request_id)
) STRICT;

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

CREATE TABLE "chat_messages" (
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

CREATE TABLE chat_message_attachments (
				message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
				attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
				ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
				PRIMARY KEY (message_id, attachment_id),
				UNIQUE (message_id, ordinal)
			) STRICT;

CREATE TABLE "chat_prompt_snapshots" (
				session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
				system_prompt TEXT NOT NULL,
				version INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			) STRICT;

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

CREATE TABLE deployment_discussion_runs (
				discussion_id TEXT NOT NULL REFERENCES deployment_discussions(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				agent_run_id TEXT NOT NULL,
				revision INTEGER NOT NULL CHECK (revision > 0),
				PRIMARY KEY (session_id, agent_run_id)
			) STRICT;

CREATE TABLE "deployment_runs" (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
				status TEXT NOT NULL CHECK (status IN ('preparing', 'running', 'recovering', 'success', 'failed', 'cancelled')),
				snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;

CREATE INDEX credentials_workspace_id_idx ON credentials(workspace_id);

CREATE UNIQUE INDEX credentials_one_active_per_workspace_idx
	ON credentials(workspace_id) WHERE is_active = 1;

CREATE INDEX sessions_workspace_id_idx ON sessions(workspace_id);

CREATE INDEX command_operations_session_id_idx ON command_operations(session_id, created_at);

CREATE INDEX command_operations_workspace_id_idx ON command_operations(workspace_id, created_at);

CREATE INDEX command_operations_status_idx ON command_operations(status, created_at);

CREATE INDEX file_transfers_workspace_id_idx ON file_transfers(workspace_id, created_at DESC);

CREATE INDEX file_transfers_status_idx ON file_transfers(status, created_at);

CREATE UNIQUE INDEX chat_runs_one_active_session_idx
	ON chat_runs(session_id) WHERE status IN ('pending', 'running');

CREATE UNIQUE INDEX terminal_sessions_one_live_per_session_idx
	ON terminal_sessions(session_id) WHERE status IN ('opening', 'active', 'closing');

CREATE INDEX terminal_sessions_status_idle_idx ON terminal_sessions(status, idle_deadline_at);

CREATE INDEX terminal_interactions_terminal_status_idx
	ON terminal_interactions(terminal_session_id, status, created_at);

CREATE INDEX terminal_timeline_session_sequence_idx
	ON terminal_timeline_events(session_id, created_at DESC, id DESC);

CREATE INDEX attachments_session_created_idx
				ON attachments(session_id, created_at DESC, id DESC);

CREATE INDEX chat_message_attachments_attachment_idx
				ON chat_message_attachments(attachment_id);

CREATE INDEX chat_user_decisions_pending_idx
				ON chat_user_decisions(session_id, created_at) WHERE status = 'pending';

CREATE UNIQUE INDEX deployment_discussions_active_session_idx
				ON deployment_discussions(session_id) WHERE status = 'discussing';

CREATE INDEX deployment_discussion_runs_discussion_idx ON deployment_discussion_runs(discussion_id, revision);

CREATE INDEX deployment_runs_session_idx ON deployment_runs(session_id, created_at DESC);

CREATE UNIQUE INDEX deployment_runs_planning_agent_idx
				ON deployment_runs(session_id, json_extract(snapshot_json, '$.planningAgentRunId'))
				WHERE json_extract(snapshot_json, '$.planningAgentRunId') IS NOT NULL;

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

WITH RECURSIVE versions(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM versions WHERE n<27)
INSERT INTO ssh_agent_schema_migrations SELECT n, 1 FROM versions;
INSERT INTO workspaces (id,display_name,environment,hostname,port,default_cwd,connect_timeout_ms,keepalive_interval_ms,keepalive_max_count,revision,created_at,updated_at,remote_default_cwd) VALUES
 ('w-app','app','development','fixture.invalid',22,'/local',1000,1000,3,7,1,2,'/srv/link/../app '),
 ('w-root','root','development','fixture.invalid',22,'/local',1000,1000,3,3,1,2,'/');
INSERT INTO sessions (id,workspace_id,display_name,revision,created_at,updated_at,sandbox_enabled)
 VALUES ('s-app','w-app','app',4,1,2,0), ('s-root','w-root','root',2,1,2,1);
INSERT INTO command_operations (id,tool_call_id,session_id,workspace_id,command_text,timeout_ms,status,queue_deadline_at,created_at,sandbox_json)
 VALUES ('history','tool-history','s-app','w-app','true',1000,'completed',1,1,'{"mode":"workspace_write","sandboxRoot":"/srv/app"}');
