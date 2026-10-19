import type { SessionActivity, SessionActivityUpdate } from "../../domain/session-activity.ts";
import type { PublishedChatEvent } from "../chat-run-event-hub.ts";

export const SESSION_ACTIVITY_EVENT_TYPES = [
	"run.updated", "run.persistence_failed", "approval.requested", "approval.resolved", "decision.requested", "decision.resolved",
] as const;

interface ActiveSession {
	activity: SessionActivity;
	createdAt: number;
	approvals: Set<string>;
	decisions: Set<string>;
	attention: boolean;
}

interface FinishedSession {
	activity: SessionActivity;
	createdAt: number;
}

const MAX_FINISHED_SESSIONS = 256;

/** Owns display precedence and waits, retaining only results observed in this process. */
export class SessionActivityProjector {
	readonly #sessions = new Map<string, ActiveSession>();
	readonly #runs = new Map<string, ActiveSession>();
	readonly #finished = new Map<string, FinishedSession>();

	snapshot(): readonly SessionActivity[] {
		return [...this.#finished.values(), ...this.#sessions.values()].map((entry) => ({ ...entry.activity }));
	}

	apply({ runId, type, data }: PublishedChatEvent): SessionActivityUpdate | null {
		if (!isRecord(data)) return null;
		if (type === "run.updated") return this.#updateRun(runId, data);
		const entry = this.#runs.get(runId);
		if (!entry) return null;
		if (type === "run.persistence_failed") {
			if (data.runId !== runId) return null;
			entry.attention = true;
		} else {
			if (data.runId !== runId || data.sessionId !== entry.activity.sessionId || typeof data.id !== "string") return null;
			const waits = type.startsWith("approval.") ? entry.approvals : type.startsWith("decision.") ? entry.decisions : undefined;
			if (!waits) return null;
			if (type.endsWith(".requested") && data.status === "pending") waits.add(data.id);
			else if (type.endsWith(".resolved") && data.status !== "pending") waits.delete(data.id);
			else return null;
		}
		return this.#project(entry);
	}

	clear(): void { this.#sessions.clear(); this.#runs.clear(); this.#finished.clear(); }

	#updateRun(runId: string, data: Record<string, unknown>): SessionActivityUpdate | null {
		if (data.id !== runId || typeof data.sessionId !== "string" || typeof data.workspaceId !== "string" ||
			typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)) return null;
		const current = this.#sessions.get(data.sessionId);
		if (current && current.activity.workspaceId !== data.workspaceId) return null;
		if (data.status === "completed" || data.status === "cancelled" || data.status === "failed") {
			if (current?.activity.runId !== runId) return null;
			this.#sessions.delete(data.sessionId);
			this.#runs.delete(runId);
			const activity: SessionActivity = {
				sessionId: data.sessionId, workspaceId: data.workspaceId, runId, state: data.status,
			};
			this.#finished.delete(data.sessionId);
			this.#finished.set(data.sessionId, { activity, createdAt: data.createdAt });
			if (this.#finished.size > MAX_FINISHED_SESSIONS) this.#finished.delete(this.#finished.keys().next().value!);
			return { sessionId: data.sessionId, runId, activity: { ...activity } };
		}
		if (data.status !== "pending" && data.status !== "running") return null;
		if (current?.activity.runId === runId) return null;
		const previous = current ?? this.#finished.get(data.sessionId);
		if (previous && (previous.createdAt > data.createdAt || previous.activity.runId === runId)) return null;
		if (current) this.#runs.delete(current.activity.runId);
		this.#finished.delete(data.sessionId);
		const activity: SessionActivity = { sessionId: data.sessionId, workspaceId: data.workspaceId, runId, state: "running" };
		const entry: ActiveSession = { activity, createdAt: data.createdAt, approvals: new Set(), decisions: new Set(), attention: false };
		this.#sessions.set(activity.sessionId, entry);
		this.#runs.set(runId, entry);
		return { sessionId: activity.sessionId, runId, activity: { ...activity } };
	}

	#project(entry: ActiveSession): SessionActivityUpdate | null {
		const state = entry.attention ? "attention" : entry.decisions.size ? "waiting_input" : entry.approvals.size ? "waiting_approval" : "running";
		if (entry.activity.state === state) return null;
		entry.activity = { ...entry.activity, state };
		return { sessionId: entry.activity.sessionId, runId: entry.activity.runId, activity: { ...entry.activity } };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
