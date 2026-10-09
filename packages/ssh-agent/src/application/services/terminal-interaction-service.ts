import type { Clock, IdGenerator } from "../../domain/ids.ts";
import type { TerminalInteraction, TerminalObservation } from "../../domain/terminal.ts";
import { TerminalError } from "../../domain/terminal.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import type { TerminalRepository } from "../repositories/terminal-repository.ts";
import {
	restoredGuardDecision,
	terminalGuardFailure,
	TerminalInteractionPolicy,
	type TerminalInteractionRequest,
} from "../terminal/terminal-interaction-policy.ts";
import {
	isTerminalInteractionFailure,
	TerminalInteractionRecorder,
	type TerminalInteractionRecording,
	type TerminalInteractionResult,
} from "../terminal/terminal-interaction-recorder.ts";
import { captureTerminalObservation, TerminalObservationCancelledError } from "../terminal/terminal-observation-capture.ts";
import type { TerminalCanonicalCapture, TerminalSessionActor } from "../terminal/terminal-session-actor.ts";
import type { CommandGuardDecision, CommandGuardEvaluator } from "./command-guard-evaluator.ts";
import type { TerminalSessionService } from "./terminal-session-service.ts";

export type { TerminalInteractionRequest, TerminalInteractionResult };

interface ObservationCursor {
	delivered: TerminalCanonicalCapture;
	pending?: { readonly observationId: string; readonly capture: TerminalCanonicalCapture };
}

export class TerminalInteractionService {
	readonly #repository: TerminalRepository;
	readonly #terminals: TerminalSessionService;
	readonly #policy: TerminalInteractionPolicy;
	readonly #recording: TerminalInteractionRecording;
	// Actor lifetime scopes the cursor across Chat Runs, without retaining closed terminals.
	readonly #observationCursors = new WeakMap<TerminalSessionActor, ObservationCursor>();
	readonly #inFlight = new Map<string, {
		readonly interactionId: string;
		readonly result: Promise<TerminalInteractionResult>;
	}>();

	constructor(options: {
		repository: TerminalRepository;
		sessions: SessionRepository;
		terminals: TerminalSessionService;
		guards: CommandGuardEvaluator;
		clock: Clock;
		ids: IdGenerator;
	}) {
		this.#repository = options.repository;
		this.#terminals = options.terminals;
		this.#policy = new TerminalInteractionPolicy({ sessions: options.sessions, terminals: options.terminals, guards: options.guards });
		this.#recording = { repository: options.repository, clock: options.clock, ids: options.ids };
	}

	async preflightSubmit(request: TerminalInteractionRequest, approvalRequired: boolean): Promise<CommandGuardDecision> {
		if (request.action.type !== "submit")
			throw new TerminalError("terminal_input_invalid", "Only submit uses Guard preflight");
		const existing = this.#repository.findInteractionByToolCall(request.agentRunId, request.toolCallId);
		if (existing) return restoredGuardDecision(existing.guardDecision);
		this.#policy.requireActor(request);
		const input = this.#policy.normalizeSubmit(request.action.input);
		const decision = await this.#policy.checkSubmit(request.sessionId, input.displayText);
		TerminalInteractionRecorder.prepare(request, this.#recording, { input, decision, approvalRequired });
		return decision;
	}

	approve(agentRunId: string, toolCallId: string): void {
		const interaction = this.#repository.findInteractionByToolCall(agentRunId, toolCallId);
		if (interaction) this.#recorder(interaction).approve();
	}

	reject(agentRunId: string, toolCallId: string): void {
		const interaction = this.#repository.findInteractionByToolCall(agentRunId, toolCallId);
		if (interaction) this.#recorder(interaction).reject();
	}

	execute(request: TerminalInteractionRequest, signal?: AbortSignal): Promise<TerminalInteractionResult> {
		let existing = this.#repository.findInteractionByToolCall(request.agentRunId, request.toolCallId);
		if (existing?.status === "completed" && existing.observationId) {
			const observation = this.#repository.findObservation(existing.observationId);
			if (!observation)
				throw new TerminalError("terminal_persistence_failed", "Terminal Observation is missing", { status: 500 });
			return Promise.resolve({ interaction: existing, observation });
		}
		if (existing && isTerminalInteractionFailure(existing.status)) return Promise.reject(interactionFailure(existing));
		if (!existing) existing = this.#prepareNonSubmit(request);
		const active = this.#inFlight.get(request.terminalSessionId);
		if (active) {
			if (existing.id === active.interactionId) return active.result;
			return Promise.reject(new TerminalError("terminal_interaction_busy", "Another TerminalInteraction is active", {
				status: 409, retryable: true,
			}));
		}
		const result = this.#execute(request, this.#recorder(existing), signal);
		this.#inFlight.set(request.terminalSessionId, { interactionId: existing.id, result });
		const release = (): void => {
			if (this.#inFlight.get(request.terminalSessionId)?.result === result)
				this.#inFlight.delete(request.terminalSessionId);
		};
		void result.then(release, release);
		return result;
	}

	async markDelivered(result: TerminalInteractionResult): Promise<void> {
		await this.#markObservationStage(result.interaction, result.observation, "delivered", {
			toolCallId: result.interaction.toolCallId,
		});
		const actor = this.#terminals.getActor(result.interaction.sessionId);
		const cursor = actor && this.#observationCursors.get(actor);
		if (cursor?.pending?.observationId === result.observation.id) {
			cursor.delivered = cursor.pending.capture;
			delete cursor.pending;
		}
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
		record: TerminalInteractionRecorder,
		signal?: AbortSignal,
	): Promise<TerminalInteractionResult> {
		const actor = this.#policy.requireActor(request);
		this.#policy.requireApprovalResolved(record.interaction);
		const cursor = this.#cursor(actor);
		const baseline = cursor.delivered;
		try {
			this.#policy.requireNotCancelled(signal);
			if (request.action.type === "observe") record.markObserving();
			else await this.#writeInput(request, record, actor, signal);
			const captured = await captureTerminalObservation(actor, baseline, request.expectation, signal);
			const result = await record.complete(actor, baseline, captured);
			cursor.pending = { observationId: result.observation.id, capture: captured.canonical };
			return result;
		} catch (error) {
			if (error instanceof TerminalObservationCancelledError) record.fail("cancelled", "run_cancelled");
			else record.fail("failed", error instanceof TerminalError ? error.code : "terminal_interaction_failed");
			throw error;
		}
	}

	async #writeInput(
		request: TerminalInteractionRequest,
		record: TerminalInteractionRecorder,
		actor: TerminalSessionActor,
		signal?: AbortSignal,
	): Promise<void> {
		const input = record.requireInput();
		if (request.action.type === "submit") {
			// Approval can wait for human input; check the current Guard against the persisted bytes' display text.
			const decision = await this.#policy.checkSubmit(request.sessionId, input.displayText);
			if (!decision.allowed) {
				record.rejectGuard(input, decision);
				throw terminalGuardFailure(decision);
			}
		}
		this.#policy.requireNotCancelled(signal);
		const sequence = await record.beginWrite(actor, input);
		this.#policy.requireNotCancelled(signal);
		try {
			await actor.write(input.encodedBytes);
			record.markWritten(input, sequence);
		} catch (error) {
			record.markWriteUncertain(sequence);
			throw error;
		}
	}

	#prepareNonSubmit(request: TerminalInteractionRequest): TerminalInteraction {
		if (request.action.type === "submit") {
			throw new TerminalError("terminal_interaction_not_prepared", "Submit interaction was not prepared", { status: 409 });
		}
		this.#policy.requireActor(request);
		return TerminalInteractionRecorder.prepare(request, this.#recording).interaction;
	}

	#cursor(actor: TerminalSessionActor): ObservationCursor {
		let cursor = this.#observationCursors.get(actor);
		if (!cursor) {
			cursor = { delivered: { sequence: 0, geometry: actor.view.geometry, screenText: "", allText: "" } };
			this.#observationCursors.set(actor, cursor);
		}
		return cursor;
	}

	#recorder(interaction: TerminalInteraction): TerminalInteractionRecorder {
		return new TerminalInteractionRecorder(interaction, this.#recording);
	}

	async #markObservationStage(
		interaction: TerminalInteraction,
		observation: TerminalObservation,
		stage: "delivered" | "processing" | "finished",
		data: Readonly<Record<string, string>>,
	): Promise<void> {
		const actor = this.#terminals.getActor(interaction.sessionId);
		await this.#recorder(interaction).markObservationStage(
			actor?.id === interaction.terminalSessionId ? actor : undefined, observation, stage, data,
		);
	}
}

function interactionFailure(interaction: TerminalInteraction): TerminalError {
	return new TerminalError(
		interaction.status === "rejected" ? "terminal_interaction_rejected" : `terminal_interaction_${interaction.status}`,
		`TerminalInteraction ended with status ${interaction.status}`,
		{ status: 409, retryable: interaction.status === "write_uncertain" },
	);
}
