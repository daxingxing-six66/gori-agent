import type { DatabaseSync } from "node:sqlite";

/** Narrow compatibility query for both managed deployments and older entry points. */
export function hasActiveDeploymentTask(database: DatabaseSync, sessionId: string): boolean {
	return database.prepare(`SELECT 1 WHERE
		EXISTS (SELECT 1 FROM deployment_sessions WHERE session_id = ? AND outcome IS NULL) OR
		EXISTS (SELECT 1 FROM deployment_runs WHERE session_id = ? AND status IN ('preparing', 'running', 'recovering')) OR
		EXISTS (SELECT 1 FROM deployment_discussions WHERE session_id = ? AND status = 'discussing')`)
		.get(sessionId, sessionId, sessionId) !== undefined;
}
