export type SessionActivityState = "running" | "waiting_approval" | "waiting_input" | "attention" | "completed" | "failed" | "cancelled";

/** A display projection of the latest Run; never a second Run lifecycle. */
export interface SessionActivity {
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly runId: string;
	readonly state: SessionActivityState;
}

export interface SessionActivityUpdate {
	readonly sessionId: string;
	readonly runId: string;
	readonly activity: SessionActivity | null;
}

export type SessionActivityEvent =
	| { readonly type: "activity.snapshot"; readonly data: { readonly activities: readonly SessionActivity[] } }
	| { readonly type: "activity.updated"; readonly data: SessionActivityUpdate };
