import type { Clock, IdGenerator } from "../../domain/ids.ts";
import type { TerminalInput, TerminalInteraction, TerminalObservation } from "../../domain/terminal.ts";
import { TerminalError } from "../../domain/terminal.ts";
import type { TerminalRepository } from "../repositories/terminal-repository.ts";
import type { CommandGuardDecision } from "../services/command-guard-evaluator.ts";
import {
	terminalGuardDecision,
	type PreparedTerminalInput,
	type TerminalInteractionRequest,
} from "./terminal-interaction-policy.ts";
import type { CapturedTerminalObservation } from "./terminal-observation-capture.ts";
import type { TerminalCanonicalCapture, TerminalSessionActor } from "./terminal-session-actor.ts";

export interface TerminalInteractionResult {
	readonly interaction: TerminalInteraction;
	readonly observation: TerminalObservation;
}

export interface TerminalInteractionRecording {
	readonly repository: TerminalRepository;
	readonly clock: Clock;
	readonly ids: IdGenerator;
}

type FailureStatus = Extract<TerminalInteraction["status"], "rejected" | "cancelled" | "failed" | "write_uncertain">;

/** Owns one Interaction's durable state and audit events. It never approves policy or writes PTY bytes. */
export class TerminalInteractionRecorder {
	#interaction: TerminalInteraction;
	readonly #recording: TerminalInteractionRecording;

	constructor(interaction: TerminalInteraction, recording: TerminalInteractionRecording) {
		this.#interaction = interaction;
		this.#recording = recording;
	}

	get interaction(): TerminalInteraction { return this.#interaction; }

	static prepare(
		request: TerminalInteractionRequest,
		recording: TerminalInteractionRecording,
		prepared?: { readonly input: PreparedTerminalInput; readonly decision: CommandGuardDecision; readonly approvalRequired: boolean },
	): TerminalInteractionRecorder {
		const { repository, clock, ids } = recording;
		const now = clock.now();
		const approvalRequired = prepared?.approvalRequired ?? false;
		const blocked = prepared?.decision.allowed === false;
		const interaction: TerminalInteraction = {
			id: ids.next(), terminalSessionId: request.terminalSessionId, sessionId: request.sessionId,
			agentRunId: request.agentRunId, toolCallId: request.toolCallId,
			action: request.action.type === "key" ? { type: "key", key: request.action.key } : { type: request.action.type },
			expectation: request.expectation, status: blocked ? "rejected" : approvalRequired ? "awaiting_approval" : "approved",
			inputSequence: null, observationId: null,
			guardDecision: prepared ? terminalGuardDecision(prepared.decision) : null,
			approvalRequired, failure: blocked ? { code: "guard_blocked" } : null,
			createdAt: now, updatedAt: now, completedAt: blocked ? now : null,
		};
		repository.insertInteraction(interaction);
		const input = request.action.type === "key"
			? { displayText: "CTRL_C", encodedBytes: Uint8Array.of(0x03) }
			: prepared?.input;
		if (input) {
			repository.insertInput({
				id: ids.next(), interactionId: interaction.id, terminalSessionId: interaction.terminalSessionId,
				...input, inputKind: request.action.type === "key" ? "semantic_key" : "submit",
				byteLength: input.encodedBytes.byteLength,
				status: blocked ? "blocked" : "prepared",
				terminalSequence: null, guardRevision: prepared?.decision.guardRevision ?? null,
				matchedGuardRuleId: prepared?.decision.matchedRule?.id ?? null, createdAt: now, writtenAt: null,
			});
		}
		const record = new TerminalInteractionRecorder(interaction, recording);
		if (blocked && prepared) record.#appendBlockedInput(prepared.input.encodedBytes.byteLength, prepared.decision);
		return record;
	}

	approve(): void {
		if (this.#interaction.status === "awaiting_approval") this.#transition("approved", ["awaiting_approval"]);
	}

	reject(): void {
		if (this.#interaction.status === "rejected") return;
		if (this.#interaction.action.type !== "observe") this.#updateInput("blocked", null, null);
		this.#transition("rejected", ["awaiting_approval", "approved", "prepared"], { completedAt: this.#now() });
	}

	requireInput(): TerminalInput {
		const input = this.#recording.repository.findInputByInteraction(this.#interaction.id);
		if (!input) throw new TerminalError("terminal_persistence_failed", "Terminal input is missing", { status: 500 });
		return input;
	}

	rejectGuard(input: TerminalInput, decision: CommandGuardDecision): void {
		this.#updateInput("blocked", null, null);
		this.#transition("rejected", [this.#interaction.status], {
			guardDecision: terminalGuardDecision(decision), failure: { code: "guard_blocked" }, completedAt: this.#now(),
		});
		this.#appendBlockedInput(input.byteLength, decision);
	}

	#appendBlockedInput(byteLength: number, decision: CommandGuardDecision): void {
		this.#appendTimeline("terminal.input", {
			status: "blocked", byteLength, matchedGuardRuleId: decision.matchedRule?.id ?? null,
		});
	}

	async beginWrite(actor: TerminalSessionActor, input: TerminalInput): Promise<number> {
		this.#transition("writing", ["approved", "prepared"]);
		return actor.recordDurableEvent("terminal.input", {
			inputId: input.id, interactionId: this.#interaction.id, status: "written", byteLength: input.byteLength,
		});
	}

	markObserving(): void { this.#transition("observing", ["approved"]); }

	markWritten(input: TerminalInput, sequence: number): void {
		this.#updateInput("written", sequence, this.#now());
		this.#transition("observing", ["writing"], { inputSequence: sequence });
		this.#appendTimeline("terminal.input", { inputId: input.id, status: "written", byteLength: input.byteLength });
	}

	markWriteUncertain(sequence: number): void {
		this.#updateInput("uncertain", sequence, this.#now());
		this.fail("write_uncertain", "terminal_write_uncertain");
	}

	fail(status: FailureStatus, code: string): void {
		if (this.#interaction.status === "completed" || isTerminalInteractionFailure(this.#interaction.status)) return;
		this.#transition(status, [this.#interaction.status], { failure: { code }, completedAt: this.#now() });
	}

	async complete(
		actor: TerminalSessionActor,
		baseline: TerminalCanonicalCapture,
		captured: CapturedTerminalObservation,
	): Promise<TerminalInteractionResult> {
		const observation: TerminalObservation = {
			id: this.#recording.ids.next(), interactionId: this.#interaction.id, terminalSessionId: actor.id,
			startSequence: baseline.sequence, endSequence: captured.sequence, kind: captured.kind,
			geometry: captured.geometry, boundaryReason: captured.boundaryReason, agentViewText: captured.text,
			rawByteCount: captured.rawByteCount, truncated: captured.truncated, capturedAt: this.#now(),
			deliveredAt: null, processingAt: null, finishedAt: null,
		};
		this.#recording.repository.insertObservation(observation);
		this.#transition("completed", ["observing"], { observationId: observation.id, completedAt: this.#now() });
		const data = {
			observationId: observation.id, boundaryReason: observation.boundaryReason, truncated: observation.truncated,
		};
		await this.#recordObservationEvent(actor, "terminal.observation.captured", data);
		this.#appendTimeline("observation.captured", data);
		return { interaction: this.#interaction, observation };
	}

	async markObservationStage(
		actor: TerminalSessionActor | undefined,
		observation: TerminalObservation,
		stage: "delivered" | "processing" | "finished",
		data: Readonly<Record<string, string>>,
	): Promise<void> {
		const now = this.#now();
		if (!this.#recording.repository.markObservationStage(observation.id, stage, now)) {
			throw new TerminalError("terminal_persistence_failed", "Terminal Observation stage could not be persisted", { status: 500 });
		}
		await this.#recordObservationEvent(actor, `terminal.observation.${stage}`, {
			observationId: observation.id, agentRunId: this.#interaction.agentRunId, ...data,
		});
		this.#appendTimeline(`observation.${stage}`, data, actor?.view.eventSequence ?? null, now);
	}

	async #recordObservationEvent(
		actor: TerminalSessionActor | undefined,
		type: "terminal.observation.captured" | "terminal.observation.delivered" | "terminal.observation.processing" | "terminal.observation.finished",
		data: Readonly<Record<string, string | boolean>>,
	): Promise<void> {
		if (!actor) return;
		try {
			await actor.recordDurableEvent(type, { interactionId: this.#interaction.id, ...data });
		} catch {
			// Observation records remain queryable if the Terminal closed concurrently.
		}
	}

	#transition(
		status: TerminalInteraction["status"],
		expected: readonly TerminalInteraction["status"][],
		patch: Partial<TerminalInteraction> = {},
	): void {
		const next = { ...this.#interaction, ...patch, status, updatedAt: this.#now() };
		if (!this.#recording.repository.updateInteraction(next, expected)) {
			throw new TerminalError("terminal_persistence_failed", "TerminalInteraction state could not be persisted", { status: 500 });
		}
		this.#interaction = next;
	}

	#updateInput(status: TerminalInput["status"], sequence: number | null, writtenAt: number | null): void {
		if (!this.#recording.repository.updateInputStatus(this.#interaction.id, status, sequence, writtenAt)) {
			throw new TerminalError("terminal_persistence_failed", "Terminal input state could not be persisted", { status: 500 });
		}
	}

	#appendTimeline(
		type: "terminal.input" | "observation.captured" | "observation.delivered" | "observation.processing" | "observation.finished",
		data: unknown,
		sequence: number | null = this.#interaction.inputSequence,
		now = this.#now(),
	): void {
		const interaction = this.#interaction;
		this.#recording.repository.appendTimelineEvent({
			id: this.#recording.ids.next(), terminalSessionId: interaction.terminalSessionId, sessionId: interaction.sessionId,
			terminalEventSequence: sequence, type, interactionId: interaction.id, observationId: interaction.observationId,
			agentRunId: interaction.agentRunId, data, createdAt: now,
		});
	}

	#now(): number { return this.#recording.clock.now(); }
}

export function isTerminalInteractionFailure(status: TerminalInteraction["status"]): boolean {
	return status === "rejected" || status === "cancelled" || status === "failed" || status === "write_uncertain";
}
