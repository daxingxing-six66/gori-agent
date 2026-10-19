export type SessionActivityState = "running" | "waiting_approval" | "waiting_input" | "attention" | "completed" | "failed" | "cancelled";
export type SessionActivityDisplayState = SessionActivityState | "idle" | "unknown";

export interface SessionActivity {
	sessionId: string;
	workspaceId: string;
	runId: string;
	state: SessionActivityState;
}

export interface SessionActivityUpdate {
	sessionId: string;
	runId: string;
	activity: SessionActivity | null;
}

export function isFinishedActivity(state: SessionActivityState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

export function parseActivitySnapshot(value: unknown): SessionActivity[] | null {
	if (!isRecord(value) || !Array.isArray(value.activities) || !value.activities.every(isActivity)) return null;
	if (new Set(value.activities.map((entry) => entry.sessionId)).size !== value.activities.length) return null;
	return value.activities;
}

export function parseActivityUpdate(value: unknown): SessionActivityUpdate | null {
	if (!isRecord(value) || !identifier(value.sessionId) || !identifier(value.runId)) return null;
	if (value.activity !== null && (!isActivity(value.activity) || value.activity.sessionId !== value.sessionId || value.activity.runId !== value.runId)) return null;
	return { sessionId: value.sessionId, runId: value.runId, activity: value.activity };
}

function isActivity(value: unknown): value is SessionActivity {
	return isRecord(value) && identifier(value.sessionId) && identifier(value.workspaceId) && identifier(value.runId) &&
		(value.state === "running" || value.state === "waiting_approval" || value.state === "waiting_input" || value.state === "attention" ||
			value.state === "completed" || value.state === "failed" || value.state === "cancelled");
}

function identifier(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
