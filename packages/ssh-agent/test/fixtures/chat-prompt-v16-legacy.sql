-- Historical v16 schema captured before the compatibility migration; contains no application data.
CREATE TABLE chat_prompt_snapshots (
				session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
				system_prompt TEXT NOT NULL,
				version INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				initial_mode TEXT NOT NULL CHECK (initial_mode IN ('command', 'terminal'))
			) STRICT;
CREATE TRIGGER chat_prompt_initial_mode AFTER INSERT ON chat_prompt_snapshots
			BEGIN
				INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, message_json, created_at)
				SELECT 'initial-mode:' || NEW.session_id, NEW.session_id, NULL,
					COALESCE(MAX(sequence), 0) + 1, 'system',
					json_object('role', 'system', 'runtimeMode', NEW.initial_mode,
						'content', json_array(json_object('type', 'text', 'text',
							CASE NEW.initial_mode WHEN 'terminal' THEN '<terminal-model-on>' ELSE '<terminal-model-off>' END)),
						'timestamp', NEW.created_at), NEW.created_at
				FROM chat_messages WHERE session_id = NEW.session_id;
			END;
CREATE TRIGGER chat_prompt_snapshot_immutable BEFORE UPDATE ON chat_prompt_snapshots
			BEGIN SELECT RAISE(ABORT, 'Chat prompt snapshots are immutable'); END;
CREATE TRIGGER chat_terminal_mode_transition AFTER UPDATE OF status ON terminal_sessions
			WHEN (OLD.status = 'active') != (NEW.status = 'active')
				AND EXISTS (SELECT 1 FROM chat_prompt_snapshots WHERE session_id = NEW.session_id)
			BEGIN
				INSERT INTO chat_messages (id, session_id, run_id, sequence, message_type, message_json, created_at)
				SELECT 'terminal-mode:' || NEW.id || ':' || NEW.revision, NEW.session_id, NULL,
					COALESCE(MAX(sequence), 0) + 1, 'system',
					json_object('role', 'system', 'runtimeMode', CASE NEW.status WHEN 'active' THEN 'terminal' ELSE 'command' END,
						'content', json_array(json_object('type', 'text', 'text',
							CASE NEW.status WHEN 'active' THEN '<terminal-model-on>' ELSE '<terminal-model-off>' END)),
						'timestamp', NEW.updated_at), NEW.updated_at
				FROM chat_messages WHERE session_id = NEW.session_id;
			END;
