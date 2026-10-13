-- Frozen v27 subset for the additive writable-directory migration.
-- Includes the real Workspace/Session constraints and an untouched command audit row.
PRAGMA foreign_keys = ON;
CREATE TABLE ssh_agent_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
WITH RECURSIVE versions(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM versions WHERE n<27)
INSERT INTO ssh_agent_schema_migrations SELECT n, 1 FROM versions;
CREATE TABLE workspaces (
 id TEXT PRIMARY KEY, display_name TEXT NOT NULL, environment TEXT NOT NULL,
 hostname TEXT NOT NULL, port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
 default_cwd TEXT NOT NULL, connect_timeout_ms INTEGER NOT NULL,
 keepalive_interval_ms INTEGER NOT NULL, keepalive_max_count INTEGER NOT NULL,
 revision INTEGER NOT NULL CHECK (revision>0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 remote_default_cwd TEXT NOT NULL DEFAULT '/'
) STRICT;
CREATE TABLE sessions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 display_name TEXT NOT NULL, terminal_context_cursor INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL CHECK (revision>0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 work_dir TEXT, auto_audit INTEGER NOT NULL DEFAULT 0 CHECK (auto_audit IN (0,1)),
 sandbox_enabled INTEGER NOT NULL DEFAULT 1 CHECK (sandbox_enabled IN (0,1))
) STRICT;
CREATE TABLE command_operations (id TEXT PRIMARY KEY, sandbox_json TEXT) STRICT;
INSERT INTO workspaces VALUES ('w-app','app','development','fixture.invalid',22,'/local',1000,1000,3,7,1,2,'/srv/link/../app ');
INSERT INTO workspaces VALUES ('w-root','root','development','fixture.invalid',22,'/local',1000,1000,3,3,1,2,'/');
INSERT INTO sessions (id,workspace_id,display_name,revision,created_at,updated_at,sandbox_enabled)
 VALUES ('s-app','w-app','app',4,1,2,0), ('s-root','w-root','root',2,1,2,1);
INSERT INTO command_operations VALUES ('history','{"mode":"workspace_write","sandboxRoot":"/srv/app"}');
