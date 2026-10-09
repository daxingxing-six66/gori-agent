import type {
	TerminalGuardDecision,
	TerminalInteraction,
	TerminalInteractionRequestAction,
	TerminalObservationExpectation,
} from "../../domain/terminal.ts";
import { TerminalError } from "../../domain/terminal.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import type { CommandGuardDecision, CommandGuardEvaluator } from "../services/command-guard-evaluator.ts";
import { TERMINAL_DEFAULTS } from "./terminal-defaults.ts";
import { TerminalObservationCancelledError } from "./terminal-observation-capture.ts";
import type { TerminalSessionActor } from "./terminal-session-actor.ts";

export interface TerminalInteractionRequest {
	readonly sessionId: string;
	readonly terminalSessionId: string;
	readonly agentRunId: string;
	readonly toolCallId: string;
	readonly action: TerminalInteractionRequestAction;
	readonly expectation: TerminalObservationExpectation;
}

export interface PreparedTerminalInput {
	readonly displayText: string;
	readonly encodedBytes: Uint8Array;
}

/** Checks the bound runtime and input policy without changing durable state or writing to the PTY. */
export class TerminalInteractionPolicy {
	readonly #sessions: SessionRepository;
	readonly #terminals: { getActor(sessionId: string): TerminalSessionActor | undefined };
	readonly #guards: CommandGuardEvaluator;

	constructor(options: {
		sessions: SessionRepository;
		terminals: { getActor(sessionId: string): TerminalSessionActor | undefined };
		guards: CommandGuardEvaluator;
	}) {
		this.#sessions = options.sessions;
		this.#terminals = options.terminals;
		this.#guards = options.guards;
	}

	requireActor(request: TerminalInteractionRequest): TerminalSessionActor {
		const actor = this.#terminals.getActor(request.sessionId);
		if (!actor || actor.id !== request.terminalSessionId) {
			throw new TerminalError("terminal_session_unavailable", "Bound TerminalSession is unavailable", {
				status: 409,
				retryable: true,
			});
		}
		return actor;
	}

	requireApprovalResolved(interaction: TerminalInteraction): void {
		if (interaction.status === "awaiting_approval") {
			throw new TerminalError("terminal_approval_required", "TerminalInteraction approval is still pending", {
				status: 409,
			});
		}
	}

	requireNotCancelled(signal?: AbortSignal): void {
		if (signal?.aborted) throw new TerminalObservationCancelledError();
	}

	async checkSubmit(sessionId: string, displayText: string): Promise<CommandGuardDecision> {
		const session = await this.#sessions.findById(sessionId);
		if (!session) throw new TerminalError("terminal_session_not_found", "Session was not found", { status: 404 });
		return this.#guards.evaluate(session.workspaceId, displayText);
	}

	normalizeSubmit(input: string): PreparedTerminalInput {
		const displayText = input.replace(/\r\n?/g, "\n");
		if (displayText.length === 0) throw new TerminalError("terminal_input_invalid", "submit input must not be empty");
		for (const character of displayText) {
			const code = character.codePointAt(0) ?? 0;
			if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) {
				throw new TerminalError("terminal_input_invalid", "submit input contains an unsupported control character");
			}
		}
		const encodedBytes = new TextEncoder().encode(`${displayText.replace(/\n/g, "\r")}\r`);
		if (encodedBytes.byteLength > TERMINAL_DEFAULTS.input.maxBytes) {
			throw new TerminalError("terminal_input_too_large", "submit input exceeds the Terminal input limit");
		}
		return { displayText, encodedBytes };
	}
}

export function terminalGuardDecision(decision: CommandGuardDecision): TerminalGuardDecision {
	return {
		allowed: decision.allowed,
		guardRevision: decision.guardRevision ?? null,
		matchedRuleId: decision.matchedRule?.id ?? null,
		reason: decision.matchedRule?.reason ?? null,
	};
}

export function restoredGuardDecision(value: TerminalGuardDecision | null): CommandGuardDecision {
	if (value === null) return { allowed: false };
	return {
		allowed: value.allowed,
		...(value.guardRevision === null ? {} : { guardRevision: value.guardRevision }),
	};
}

export function terminalGuardFailure(decision: CommandGuardDecision): TerminalError {
	return new TerminalError("guard_blocked", decision.matchedRule?.reason ?? "Workspace Guard blocked the input", {
		status: 403,
	});
}
