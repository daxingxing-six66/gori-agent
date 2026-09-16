import { TERMINAL_DEFAULTS } from "./terminal-defaults.ts";
import type { TerminalSessionActor } from "./terminal-session-actor.ts";

export interface TerminalRuntimeReservation {
	release(): void;
}

export class TerminalRuntimeRegistry {
	readonly #actorsById = new Map<string, TerminalSessionActor>();
	readonly #actorIdBySession = new Map<string, string>();
	readonly #capacity: number;
	#reservations = 0;

	constructor(options: { readonly capacity?: number } = {}) {
		this.#capacity = options.capacity ?? TERMINAL_DEFAULTS.capacity.processTerminalSessions;
	}

	reserve(): TerminalRuntimeReservation | null {
		if (this.#reservations >= this.#capacity) return null;
		this.#reservations += 1;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.#reservations -= 1;
			},
		};
	}

	register(actor: TerminalSessionActor): void {
		if (this.#actorsById.has(actor.id) || this.#actorIdBySession.has(actor.sessionId)) {
			throw new Error(`Terminal runtime already registered for Session: ${actor.sessionId}`);
		}
		this.#actorsById.set(actor.id, actor);
		this.#actorIdBySession.set(actor.sessionId, actor.id);
	}

	remove(actor: TerminalSessionActor): void {
		if (this.#actorsById.get(actor.id) === actor) this.#actorsById.delete(actor.id);
		if (this.#actorIdBySession.get(actor.sessionId) === actor.id) this.#actorIdBySession.delete(actor.sessionId);
	}

	findById(id: string): TerminalSessionActor | undefined {
		return this.#actorsById.get(id);
	}

	findBySession(sessionId: string): TerminalSessionActor | undefined {
		const id = this.#actorIdBySession.get(sessionId);
		return id === undefined ? undefined : this.#actorsById.get(id);
	}

	list(): readonly TerminalSessionActor[] {
		return [...this.#actorsById.values()];
	}

	get reservationCount(): number {
		return this.#reservations;
	}
}
