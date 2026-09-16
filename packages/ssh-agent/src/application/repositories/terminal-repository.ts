import type { SessionId, TerminalObservationId, TerminalSessionId } from "../../domain/ids.ts";
import type {
	TerminalInput,
	TerminalInputStatus,
	TerminalInteraction,
	TerminalInteractionStatus,
	TerminalObservation,
	TerminalSession,
	TerminalSessionStatus,
	TerminalTimelineEvent,
} from "../../domain/terminal.ts";

export interface TerminalRepository {
	recoverInterrupted(now: number): void;
	findSession(id: TerminalSessionId): TerminalSession | undefined;
	findCurrentSession(sessionId: SessionId): TerminalSession | undefined;
	findSessionByOpenRequest(sessionId: SessionId, requestId: string): TerminalSession | undefined;
	insertSession(session: TerminalSession): void;
	updateSession(session: TerminalSession, expectedStatus: TerminalSessionStatus, expectedRevision: number): boolean;
	listIdleCandidates(now: number): TerminalSession[];
	findInteractionByToolCall(agentRunId: string, toolCallId: string): TerminalInteraction | undefined;
	findInteraction(id: string): TerminalInteraction | undefined;
	insertInteraction(interaction: TerminalInteraction): void;
	updateInteraction(interaction: TerminalInteraction, expectedStatuses: readonly TerminalInteractionStatus[]): boolean;
	insertInput(input: TerminalInput): void;
	findInputByInteraction(interactionId: string): TerminalInput | undefined;
	updateInputStatus(
		interactionId: string,
		status: TerminalInputStatus,
		terminalSequence: number | null,
		writtenAt: number | null,
	): boolean;
	insertObservation(observation: TerminalObservation): void;
	findObservation(id: TerminalObservationId): TerminalObservation | undefined;
	findObservationByInteraction(interactionId: string): TerminalObservation | undefined;
	findLatestDeliveredObservation(agentRunId: string): TerminalObservation | undefined;
	markObservationStage(id: TerminalObservationId, stage: "delivered" | "processing" | "finished", at: number): boolean;
	appendTimelineEvent(event: Omit<TerminalTimelineEvent, "timelineSequence">): TerminalTimelineEvent;
	listTimeline(sessionId: SessionId, beforeSequence?: number, limit?: number): TerminalTimelineEvent[];
}
