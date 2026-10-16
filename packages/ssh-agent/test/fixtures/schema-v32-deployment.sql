-- Frozen v28-v32 extension to schema-v27-sandbox.sql, before deployment completion positioning.

			ALTER TABLE workspaces ADD COLUMN sandbox_writable_roots_json TEXT
				CHECK (sandbox_writable_roots_json IS NULL OR (json_valid(sandbox_writable_roots_json) AND json_type(sandbox_writable_roots_json) = 'array'));
			ALTER TABLE sessions ADD COLUMN sandbox_writable_roots_json TEXT
				CHECK (sandbox_writable_roots_json IS NULL OR (json_valid(sandbox_writable_roots_json) AND json_type(sandbox_writable_roots_json) = 'array'));
			UPDATE workspaces SET sandbox_writable_roots_json = CASE
				WHEN remote_default_cwd = '/' THEN '[]' ELSE json_array(remote_default_cwd) END;
			UPDATE sessions SET sandbox_writable_roots_json = (
				SELECT sandbox_writable_roots_json FROM workspaces WHERE workspaces.id = sessions.workspace_id
			);

INSERT INTO ssh_agent_schema_migrations VALUES (28,1);


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

INSERT INTO ssh_agent_schema_migrations VALUES (30,1);


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

INSERT INTO ssh_agent_schema_migrations VALUES (31,1);

ALTER TABLE workspaces DROP COLUMN remote_default_cwd;
INSERT INTO ssh_agent_schema_migrations VALUES (32,1);
