import { isFinishedActivity, type SessionActivity, type SessionActivityDisplayState, type SessionActivityUpdate } from "../model/session-activity";
import { SessionActivityReadState } from "./session-activity-read-state";

/** Shared across navigation; only complete SSE snapshots make the state authoritative. */
export class SessionActivityStore {
	#activities = new Map<string, SessionActivity>();
	#connected = false;
	#viewedSessionId: string | null = null;
	readonly #listeners = new Map<string, Set<() => void>>();
	readonly #readState: SessionActivityReadState;

	constructor(readState = new SessionActivityReadState()) { this.#readState = readState; }

	subscribe(sessionId: string, listener: () => void): () => void {
		const listeners = this.#listeners.get(sessionId) ?? new Set();
		listeners.add(listener);
		this.#listeners.set(sessionId, listeners);
		return () => {
			if (!listeners.delete(listener)) return;
			if (listeners.size === 0) this.#listeners.delete(sessionId);
		};
	}

	state(sessionId: string): SessionActivityDisplayState {
		if (!this.#connected) return "unknown";
		const activity = this.#activities.get(sessionId);
		if (!activity || (isFinishedActivity(activity.state) && this.#readState.hasRead(sessionId, activity.runId))) return "idle";
		return activity.state;
	}

	acknowledge(sessionId: string): void {
		const activity = this.#activities.get(sessionId);
		if (!activity || !isFinishedActivity(activity.state)) return;
		const previous = this.state(sessionId);
		this.#readState.markRead(sessionId, activity.runId);
		if (this.state(sessionId) !== previous) this.#notify(sessionId);
	}

	/** The view reports presence; only successful results are automatically read. */
	setViewedSession(sessionId: string | null): void {
		this.#viewedSessionId = sessionId;
		if (!sessionId || !this.#connected) return;
		const previous = this.state(sessionId);
		this.#markViewedCompletion(this.#activities.get(sessionId));
		if (this.state(sessionId) !== previous) this.#notify(sessionId);
	}

	applySnapshot(activities: readonly SessionActivity[]): void {
		const previous = new Map([...this.#listeners.keys()].map((id) => [id, this.state(id)]));
		this.#activities = new Map(activities.map((activity) => [activity.sessionId, activity]));
		this.#connected = true;
		if (this.#viewedSessionId) this.#markViewedCompletion(this.#activities.get(this.#viewedSessionId));
		for (const [id, state] of previous) if (this.state(id) !== state) this.#notify(id);
	}

	applyUpdate(update: SessionActivityUpdate): void {
		if (!this.#connected) return;
		const previous = this.state(update.sessionId);
		const current = this.#activities.get(update.sessionId);
		const terminal = update.activity !== null && isFinishedActivity(update.activity.state);
		if (terminal && current && current.runId !== update.runId) return;
		if (update.activity) this.#activities.set(update.sessionId, update.activity);
		else {
			if (this.#activities.get(update.sessionId)?.runId !== update.runId) return;
			this.#activities.delete(update.sessionId);
		}
		this.#markViewedCompletion(update.activity ?? undefined);
		if (this.state(update.sessionId) !== previous) this.#notify(update.sessionId);
	}

	disconnect(): void {
		if (!this.#connected) return;
		this.#connected = false;
		for (const id of this.#listeners.keys()) this.#notify(id);
	}

	#markViewedCompletion(activity: SessionActivity | undefined): void {
		if (activity?.sessionId === this.#viewedSessionId && activity.state === "completed") {
			this.#readState.markRead(activity.sessionId, activity.runId);
		}
	}

	#notify(sessionId: string): void { for (const listener of this.#listeners.get(sessionId) ?? []) listener(); }
}
