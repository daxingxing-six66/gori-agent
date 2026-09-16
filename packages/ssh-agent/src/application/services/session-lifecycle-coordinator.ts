import { ManagementError } from "../../domain/errors.ts";
import type { SessionId } from "../../domain/ids.ts";

export type SessionUseKind =
	| "chat_run"
	| "chat_compaction"
	| "command_operation"
	| "session_update"
	| "attachment_upload"
	| "terminal_open"
	| "terminal_session";

export interface SessionUseLease {
	release(): void;
}

export interface SessionDeletionBarrier {
	release(): void;
}

export interface SessionUsageSnapshot {
	readonly deleting: boolean;
	readonly total: number;
	readonly byKind: Readonly<Record<SessionUseKind, number>>;
}

interface SessionLifecycleState {
	deleting: boolean;
	readonly counts: Record<SessionUseKind, number>;
	readonly barrierWaiters: Array<() => void>;
}

const USE_KINDS: readonly SessionUseKind[] = [
	"chat_run",
	"chat_compaction",
	"command_operation",
	"session_update",
	"attachment_upload",
	"terminal_open",
	"terminal_session",
];

export class SessionLifecycleCoordinator {
	readonly #states = new Map<SessionId, SessionLifecycleState>();

	acquireUse(sessionId: SessionId, kind: SessionUseKind): SessionUseLease {
		const state = this.#getOrCreate(sessionId);
		if (state.deleting) {
			throw new ManagementError("session_deletion_in_progress", "Session deletion is in progress");
		}
		state.counts[kind] += 1;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				state.counts[kind] -= 1;
				this.#deleteIfUnused(sessionId, state);
			},
		};
	}

	async acquireDeletionBarrier(sessionId: SessionId): Promise<SessionDeletionBarrier> {
		const state = this.#getOrCreate(sessionId);
		if (state.deleting) {
			await new Promise<void>((resolve) => state.barrierWaiters.push(resolve));
			return this.acquireDeletionBarrier(sessionId);
		}
		state.deleting = true;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				state.deleting = false;
				const next = state.barrierWaiters.shift();
				next?.();
				this.#deleteIfUnused(sessionId, state);
			},
		};
	}

	getUsage(sessionId: SessionId): SessionUsageSnapshot {
		const state = this.#states.get(sessionId);
		const byKind = Object.fromEntries(USE_KINDS.map((kind) => [kind, state?.counts[kind] ?? 0])) as Record<
			SessionUseKind,
			number
		>;
		return {
			deleting: state?.deleting ?? false,
			total: USE_KINDS.reduce((total, kind) => total + byKind[kind], 0),
			byKind,
		};
	}

	#getOrCreate(sessionId: SessionId): SessionLifecycleState {
		const current = this.#states.get(sessionId);
		if (current) return current;
		const counts = Object.fromEntries(USE_KINDS.map((kind) => [kind, 0])) as Record<SessionUseKind, number>;
		const created = { deleting: false, counts, barrierWaiters: [] };
		this.#states.set(sessionId, created);
		return created;
	}

	#deleteIfUnused(sessionId: SessionId, state: SessionLifecycleState): void {
		if (!state.deleting && state.barrierWaiters.length === 0 && USE_KINDS.every((kind) => state.counts[kind] === 0)) {
			this.#states.delete(sessionId);
		}
	}
}
