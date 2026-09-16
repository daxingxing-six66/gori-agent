import type { Clock, IdGenerator } from "../../domain/ids.ts";
import type {
	TerminalGuardDecision,
	TerminalInput,
	TerminalInteraction,
	TerminalInteractionRequestAction,
	TerminalObservation,
	TerminalObservationExpectation,
} from "../../domain/terminal.ts";
import { TerminalError } from "../../domain/terminal.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import type { TerminalRepository } from "../repositories/terminal-repository.ts";
import { TERMINAL_DEFAULTS } from "../terminal/terminal-defaults.ts";
import {
	captureTerminalObservation,
	TerminalObservationCancelledError,
} from "../terminal/terminal-observation-capture.ts";
import type { CommandGuardDecision, CommandGuardEvaluator } from "./command-guard-evaluator.ts";
import type { TerminalSessionService } from "./terminal-session-service.ts";

export interface TerminalInteractionRequest {
	readonly sessionId: string;
	readonly terminalSessionId: string;
	readonly agentRunId: string;
	readonly toolCallId: string;
	readonly action: TerminalInteractionRequestAction;
	readonly expectation: TerminalObservationExpectation;
}

export interface TerminalInteractionResult {
	readonly interaction: TerminalInteraction;
	readonly observation: TerminalObservation;
}

export class TerminalInteractionService {
	readonly #repository: TerminalRepository;
	readonly #sessions: SessionRepository;
	readonly #terminals: TerminalSessionService;
	readonly #guards: CommandGuardEvaluator;
	readonly #clock: Clock;
	readonly #ids: IdGenerator;
	readonly #inFlight = new Map<
		string,
		{ readonly interactionId: string; readonly result: Promise<TerminalInteractionResult> }
	>();

	constructor(options: {
		repository: TerminalRepository;
		sessions: SessionRepository;
		terminals: TerminalSessionService;
		guards: CommandGuardEvaluator;
		clock: Clock;
		ids: IdGenerator;
	}) {
		this.#repository = options.repository;
		this.#sessions = options.sessions;
		this.#terminals = options.terminals;
		this.#guards = options.guards;
		this.#clock = options.clock;
		this.#ids = options.ids;
	}

	async preflightSubmit(
		request: TerminalInteractionRequest,
		approvalRequired: boolean,
	): Promise<CommandGuardDecision> {
		if (request.action.type !== "submit")
			throw new TerminalError("terminal_input_invalid", "Only submit uses Guard preflight");
		const existing = this.#repository.findInteractionByToolCall(request.agentRunId, request.toolCallId);
		if (existing) return guardDecisionFrom(existing.guardDecision);
		const actor = this.#requireActor(request);
		const session = await this.#sessions.findById(request.sessionId);
		if (!session) throw new TerminalError("terminal_session_not_found", "Session was not found", { status: 404 });
		const input = normalizedSubmit(request.action.input);
		const decision = await this.#guards.evaluate(session.workspaceId, input.displayText);
		const now = this.#clock.now();
		const interaction = this.#newInteraction(
			request,
			approvalRequired ? "awaiting_approval" : "approved",
			approvalRequired,
			now,
			decision,
		);
		this.#repository.insertInteraction(interaction);
		this.#repository.insertInput({
			id: this.#ids.next(),
			interactionId: interaction.id,
			terminalSessionId: actor.id,
			displayText: input.displayText,
			inputKind: "submit",
			encodedBytes: input.encodedBytes,
			byteLength: input.encodedBytes.byteLength,
			status: decision.allowed ? "prepared" : "blocked",
			terminalSequence: null,
			guardRevision: decision.guardRevision ?? null,
			matchedGuardRuleId: decision.matchedRule?.id ?? null,
			createdAt: now,
			writtenAt: null,
		});
		if (!decision.allowed) {
			const rejected = { ...interaction, status: "rejected" as const, completedAt: now, updatedAt: now };
			this.#requireInteractionUpdate(rejected, [interaction.status]);
			this.#appendTimeline(rejected, "terminal.input", {
				status: "blocked",
				byteLength: input.encodedBytes.byteLength,
				matchedGuardRuleId: decision.matchedRule?.id ?? null,
			});
		}
		return decision;
	}

	approve(agentRunId: string, toolCallId: string): void {
		const interaction = this.#repository.findInteractionByToolCall(agentRunId, toolCallId);
		if (!interaction || interaction.status !== "awaiting_approval") return;
		this.#requireInteractionUpdate({ ...interaction, status: "approved", updatedAt: this.#clock.now() }, [
			"awaiting_approval",
		]);
	}

	reject(agentRunId: string, toolCallId: string): void {
		const interaction = this.#repository.findInteractionByToolCall(agentRunId, toolCallId);
		if (!interaction || interaction.status === "rejected") return;
		const now = this.#clock.now();
		this.#repository.updateInputStatus(interaction.id, "blocked", null, null);
		this.#requireInteractionUpdate({ ...interaction, status: "rejected", updatedAt: now, completedAt: now }, [
			"awaiting_approval",
			"approved",
			"prepared",
		]);
	}

	execute(request: TerminalInteractionRequest, signal?: AbortSignal): Promise<TerminalInteractionResult> {
		let existing = this.#repository.findInteractionByToolCall(request.agentRunId, request.toolCallId);
		if (existing?.status === "completed" && existing.observationId) {
			const observation = this.#repository.findObservation(existing.observationId);
			if (!observation)
				throw new TerminalError("terminal_persistence_failed", "Terminal Observation is missing", { status: 500 });
			return Promise.resolve({ interaction: existing, observation });
		}
		if (existing && isTerminalFailure(existing.status)) return Promise.reject(interactionFailure(existing));
		if (!existing) existing = this.#createNonSubmitInteraction(request);
		const active = this.#inFlight.get(request.terminalSessionId);
		if (active) {
			if (existing.id === active.interactionId) return active.result;
			return Promise.reject(
				new TerminalError("terminal_interaction_busy", "Another TerminalInteraction is active", {
					status: 409,
					retryable: true,
				}),
			);
		}
		const result = this.#execute(request, existing, signal);
		this.#inFlight.set(request.terminalSessionId, { interactionId: existing.id, result });
		void result.then(
			() => {
				if (this.#inFlight.get(request.terminalSessionId)?.result === result)
					this.#inFlight.delete(request.terminalSessionId);
			},
			() => {
				if (this.#inFlight.get(request.terminalSessionId)?.result === result)
					this.#inFlight.delete(request.terminalSessionId);
			},
		);
		return result;
	}

	async markDelivered(result: TerminalInteractionResult): Promise<void> {
		await this.#markObservationStage(result.interaction, result.observation, "delivered", {
			toolCallId: result.interaction.toolCallId,
		});
	}

	async markLatestProcessing(agentRunId: string): Promise<void> {
		const observation = this.#repository.findLatestDeliveredObservation(agentRunId);
		if (!observation || observation.processingAt !== null) return;
		const interaction = this.#repository.findInteraction(observation.interactionId);
		if (interaction) await this.#markObservationStage(interaction, observation, "processing", {});
	}

	async markLatestFinished(agentRunId: string, assistantMessageId: string): Promise<void> {
		const observation = this.#repository.findLatestDeliveredObservation(agentRunId);
		if (!observation || observation.processingAt === null || observation.finishedAt !== null) return;
		const interaction = this.#repository.findInteraction(observation.interactionId);
		if (interaction) await this.#markObservationStage(interaction, observation, "finished", { assistantMessageId });
	}

	async #execute(
		request: TerminalInteractionRequest,
		existing: TerminalInteraction,
		signal?: AbortSignal,
	): Promise<TerminalInteractionResult> {
		const actor = this.#requireActor(request);
		let interaction = existing;
		if (interaction.status === "awaiting_approval") {
			throw new TerminalError("terminal_approval_required", "TerminalInteraction approval is still pending", {
				status: 409,
			});
		}
		const baseline = await actor.captureCanonical();
		const input = this.#repository.findInputByInteraction(interaction.id);
		try {
			if (request.action.type !== "observe") {
				if (!input)
					throw new TerminalError("terminal_persistence_failed", "Terminal input is missing", { status: 500 });
				if (request.action.type === "submit") {
					const session = await this.#sessions.findById(request.sessionId);
					if (!session)
						throw new TerminalError("terminal_session_not_found", "Session was not found", { status: 404 });
					const decision = await this.#guards.evaluate(session.workspaceId, input.displayText);
					if (!decision.allowed) {
						this.#repository.updateInputStatus(interaction.id, "blocked", null, null);
						interaction = this.#finishFailure(interaction, "rejected", "guard_blocked");
						throw new TerminalError(
							"guard_blocked",
							decision.matchedRule?.reason ?? "Workspace Guard blocked the input",
							{ status: 403 },
						);
					}
				}
				interaction = this.#transition(interaction, "writing", ["approved", "prepared"]);
				const inputSequence = await actor.recordDurableEvent("terminal.input", {
					inputId: input.id,
					interactionId: interaction.id,
					status: "written",
					byteLength: input.byteLength,
				});
				try {
					await actor.write(input.encodedBytes);
				} catch (error) {
					this.#repository.updateInputStatus(interaction.id, "uncertain", inputSequence, this.#clock.now());
					interaction = this.#finishFailure(interaction, "write_uncertain", "terminal_write_uncertain");
					throw error;
				}
				this.#repository.updateInputStatus(interaction.id, "written", inputSequence, this.#clock.now());
				interaction = this.#transition({ ...interaction, inputSequence }, "observing", ["writing"]);
				this.#appendTimeline(interaction, "terminal.input", {
					inputId: input.id,
					status: "written",
					byteLength: input.byteLength,
				});
			} else {
				interaction = this.#transition(interaction, "observing", ["approved"]);
			}
			const captured = await captureTerminalObservation(actor, baseline, request.expectation, signal);
			const now = this.#clock.now();
			const observation: TerminalObservation = {
				id: this.#ids.next(),
				interactionId: interaction.id,
				terminalSessionId: actor.id,
				startSequence: baseline.sequence,
				endSequence: captured.sequence,
				kind: captured.kind,
				geometry: captured.geometry,
				boundaryReason: captured.boundaryReason,
				agentViewText: captured.text,
				rawByteCount: captured.rawByteCount,
				truncated: captured.truncated,
				capturedAt: now,
				deliveredAt: null,
				processingAt: null,
				finishedAt: null,
			};
			this.#repository.insertObservation(observation);
			const completed = this.#transition(
				{ ...interaction, observationId: observation.id },
				"completed",
				["observing"],
				true,
			);
			try {
				await actor.recordDurableEvent("terminal.observation.captured", {
					observationId: observation.id,
					interactionId: interaction.id,
					boundaryReason: observation.boundaryReason,
					truncated: observation.truncated,
				});
			} catch {
				// A closed Channel can still produce a durable final Observation.
			}
			this.#appendTimeline(completed, "observation.captured", {
				observationId: observation.id,
				boundaryReason: observation.boundaryReason,
				truncated: observation.truncated,
			});
			return { interaction: completed, observation };
		} catch (error) {
			if (error instanceof TerminalObservationCancelledError) {
				this.#finishFailure(interaction, "cancelled", "run_cancelled");
			}
			throw error;
		}
	}

	#createNonSubmitInteraction(request: TerminalInteractionRequest): TerminalInteraction {
		if (request.action.type === "submit") {
			throw new TerminalError("terminal_interaction_not_prepared", "Submit interaction was not prepared", {
				status: 409,
			});
		}
		const actor = this.#requireActor(request);
		const now = this.#clock.now();
		const interaction = this.#newInteraction(request, "approved", false, now, null);
		this.#repository.insertInteraction(interaction);
		if (request.action.type === "key") {
			const input: TerminalInput = {
				id: this.#ids.next(),
				interactionId: interaction.id,
				terminalSessionId: actor.id,
				displayText: "CTRL_C",
				inputKind: "semantic_key",
				encodedBytes: Uint8Array.of(0x03),
				byteLength: 1,
				status: "prepared",
				terminalSequence: null,
				guardRevision: null,
				matchedGuardRuleId: null,
				createdAt: now,
				writtenAt: null,
			};
			this.#repository.insertInput(input);
		}
		return interaction;
	}

	#newInteraction(
		request: TerminalInteractionRequest,
		status: TerminalInteraction["status"],
		approvalRequired: boolean,
		now: number,
		decision: CommandGuardDecision | null,
	): TerminalInteraction {
		return {
			id: this.#ids.next(),
			terminalSessionId: request.terminalSessionId,
			sessionId: request.sessionId,
			agentRunId: request.agentRunId,
			toolCallId: request.toolCallId,
			action:
				request.action.type === "key" ? { type: "key", key: request.action.key } : { type: request.action.type },
			expectation: request.expectation,
			status,
			inputSequence: null,
			observationId: null,
			guardDecision: decision === null ? null : guardDecisionData(decision),
			approvalRequired,
			failure: null,
			createdAt: now,
			updatedAt: now,
			completedAt: null,
		};
	}

	#requireActor(request: TerminalInteractionRequest) {
		const actor = this.#terminals.getActor(request.sessionId);
		if (!actor || actor.id !== request.terminalSessionId) {
			throw new TerminalError("terminal_session_unavailable", "Bound TerminalSession is unavailable", {
				status: 409,
				retryable: true,
			});
		}
		return actor;
	}

	#transition(
		interaction: TerminalInteraction,
		status: TerminalInteraction["status"],
		expected: readonly TerminalInteraction["status"][],
		completed = false,
	): TerminalInteraction {
		const now = this.#clock.now();
		const next = { ...interaction, status, updatedAt: now, ...(completed ? { completedAt: now } : {}) };
		this.#requireInteractionUpdate(next, expected);
		return next;
	}

	#finishFailure(
		interaction: TerminalInteraction,
		status: "rejected" | "cancelled" | "failed" | "write_uncertain",
		code: string,
	): TerminalInteraction {
		const now = this.#clock.now();
		const next = { ...interaction, status, failure: { code }, updatedAt: now, completedAt: now };
		this.#repository.updateInteraction(next, [interaction.status]);
		return next;
	}

	#requireInteractionUpdate(
		interaction: TerminalInteraction,
		expected: readonly TerminalInteraction["status"][],
	): void {
		if (!this.#repository.updateInteraction(interaction, expected)) {
			throw new TerminalError("terminal_persistence_failed", "TerminalInteraction state could not be persisted", {
				status: 500,
			});
		}
	}

	#appendTimeline(
		interaction: TerminalInteraction,
		type: "terminal.input" | "observation.captured",
		data: unknown,
	): void {
		this.#repository.appendTimelineEvent({
			id: this.#ids.next(),
			terminalSessionId: interaction.terminalSessionId,
			sessionId: interaction.sessionId,
			terminalEventSequence: interaction.inputSequence,
			type,
			interactionId: interaction.id,
			observationId: interaction.observationId,
			agentRunId: interaction.agentRunId,
			data,
			createdAt: this.#clock.now(),
		});
	}

	async #markObservationStage(
		interaction: TerminalInteraction,
		observation: TerminalObservation,
		stage: "delivered" | "processing" | "finished",
		data: Readonly<Record<string, string>>,
	): Promise<void> {
		const now = this.#clock.now();
		if (!this.#repository.markObservationStage(observation.id, stage, now)) {
			throw new TerminalError("terminal_persistence_failed", "Terminal Observation stage could not be persisted", {
				status: 500,
			});
		}
		const eventType = `terminal.observation.${stage}` as const;
		const actor = this.#terminals.getActor(interaction.sessionId);
		if (actor?.id === interaction.terminalSessionId) {
			try {
				await actor.recordDurableEvent(eventType, {
					observationId: observation.id,
					interactionId: interaction.id,
					agentRunId: interaction.agentRunId,
					...data,
				});
			} catch {
				// The durable stage remains queryable if the Terminal closed concurrently.
			}
		}
		this.#repository.appendTimelineEvent({
			id: this.#ids.next(),
			terminalSessionId: interaction.terminalSessionId,
			sessionId: interaction.sessionId,
			terminalEventSequence: actor?.view.eventSequence ?? null,
			type: `observation.${stage}`,
			interactionId: interaction.id,
			observationId: observation.id,
			agentRunId: interaction.agentRunId,
			data,
			createdAt: now,
		});
	}
}

function normalizedSubmit(input: string): { readonly displayText: string; readonly encodedBytes: Uint8Array } {
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

function guardDecisionData(decision: CommandGuardDecision): TerminalGuardDecision {
	return {
		allowed: decision.allowed,
		guardRevision: decision.guardRevision ?? null,
		matchedRuleId: decision.matchedRule?.id ?? null,
		reason: decision.matchedRule?.reason ?? null,
	};
}

function guardDecisionFrom(value: TerminalGuardDecision | null): CommandGuardDecision {
	if (value === null) return { allowed: false };
	return {
		allowed: value.allowed,
		...(value.guardRevision === null ? {} : { guardRevision: value.guardRevision }),
	};
}

function isTerminalFailure(status: TerminalInteraction["status"]): boolean {
	return status === "rejected" || status === "cancelled" || status === "failed" || status === "write_uncertain";
}

function interactionFailure(interaction: TerminalInteraction): TerminalError {
	return new TerminalError(
		interaction.status === "rejected"
			? "terminal_interaction_rejected"
			: `terminal_interaction_${interaction.status}`,
		`TerminalInteraction ended with status ${interaction.status}`,
		{ status: 409, retryable: interaction.status === "write_uncertain" },
	);
}
