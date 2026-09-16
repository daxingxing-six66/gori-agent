import type { DatabaseSync } from "node:sqlite";
import type { TerminalRepository } from "../../application/repositories/terminal-repository.ts";
import type { SessionId, TerminalObservationId, TerminalSessionId } from "../../domain/ids.ts";
import type {
	TerminalBoundaryReason,
	TerminalCloseReason,
	TerminalGuardDecision,
	TerminalInput,
	TerminalInputKind,
	TerminalInputStatus,
	TerminalInteraction,
	TerminalInteractionAction,
	TerminalInteractionFailure,
	TerminalInteractionStatus,
	TerminalObservation,
	TerminalObservationExpectation,
	TerminalObservationKind,
	TerminalSession,
	TerminalSessionStatus,
	TerminalTimelineEvent,
	TerminalTimelineEventType,
} from "../../domain/terminal.ts";
import type { BackendMessageKey, BackendMessageValues } from "../../i18n/message.ts";
import { descriptorForPublicCode } from "../../i18n/public-error.ts";

export class SqliteTerminalRepository implements TerminalRepository {
	readonly #database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	recoverInterrupted(now: number): void {
		this.#database
			.prepare(`UPDATE terminal_interactions
				SET status = CASE WHEN status = 'writing' THEN 'write_uncertain' ELSE 'cancelled' END,
					failure_json = ?, updated_at = ?, completed_at = ?
				WHERE status IN ('prepared', 'awaiting_approval', 'approved', 'writing', 'observing')
					AND NOT (status = 'observing' AND observation_id IS NOT NULL)`)
			.run(JSON.stringify({ code: "backend_restarted" }), now, now);
		this.#database
			.prepare(`UPDATE terminal_interactions SET status = 'completed', updated_at = ?, completed_at = ?
				WHERE status = 'observing' AND observation_id IS NOT NULL`)
			.run(now, now);
		this.#database
			.prepare(`UPDATE terminal_sessions SET status = 'lost', close_reason = 'backend_restarted',
				closed_at = ?, updated_at = ?, revision = revision + 1
				WHERE status IN ('opening', 'active', 'closing')`)
			.run(now, now);
	}

	findSession(id: TerminalSessionId): TerminalSession | undefined {
		return optionalSession(this.#database.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(id));
	}

	findCurrentSession(sessionId: SessionId): TerminalSession | undefined {
		return optionalSession(
			this.#database
				.prepare(`SELECT * FROM terminal_sessions WHERE session_id = ?
					ORDER BY CASE WHEN status IN ('opening', 'active', 'closing') THEN 0 ELSE 1 END, created_at DESC, rowid DESC
					LIMIT 1`)
				.get(sessionId),
		);
	}

	findSessionByOpenRequest(sessionId: SessionId, requestId: string): TerminalSession | undefined {
		return optionalSession(
			this.#database
				.prepare("SELECT * FROM terminal_sessions WHERE session_id = ? AND open_request_id = ?")
				.get(sessionId, requestId),
		);
	}

	insertSession(session: TerminalSession): void {
		const failureMessage = terminalFailureDescriptor(session);
		this.#database
			.prepare(`INSERT INTO terminal_sessions (
				id, session_id, workspace_id, open_request_id, close_request_id, status, revision,
				connection_generation, term, rows, cols, last_event_sequence, ownership_epoch,
				last_consumer_activity_at, idle_deadline_at, close_reason, activated_at, closing_at,
				closed_at, failure_code, failure_message, failure_message_key, failure_message_values_json,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(...sessionValues(session, failureMessage));
	}

	updateSession(session: TerminalSession, expectedStatus: TerminalSessionStatus, expectedRevision: number): boolean {
		const failureMessage = terminalFailureDescriptor(session);
		return (
			this.#database
				.prepare(`UPDATE terminal_sessions SET
					close_request_id = ?, status = ?, revision = ?, connection_generation = ?, term = ?,
					rows = ?, cols = ?, last_event_sequence = ?, ownership_epoch = ?,
					last_consumer_activity_at = ?, idle_deadline_at = ?, close_reason = ?, activated_at = ?,
					closing_at = ?, closed_at = ?, failure_code = ?, failure_message = ?, failure_message_key = ?,
					failure_message_values_json = ?, updated_at = ?
					WHERE id = ? AND status = ? AND revision = ?`)
				.run(
					session.closeRequestId,
					session.status,
					session.revision,
					session.connectionGeneration,
					session.term,
					session.geometry.rows,
					session.geometry.cols,
					session.eventSequence,
					session.ownershipEpoch,
					session.lastConsumerActivityAt,
					session.idleDeadlineAt,
					session.closeReason,
					session.activatedAt,
					session.closingAt,
					session.closedAt,
					session.failureCode,
					session.failureMessage,
					failureMessage?.key ?? null,
					failureMessage?.values === undefined ? null : JSON.stringify(failureMessage.values),
					session.updatedAt,
					session.id,
					expectedStatus,
					expectedRevision,
				).changes === 1
		);
	}

	listIdleCandidates(now: number): TerminalSession[] {
		return this.#database
			.prepare(`SELECT * FROM terminal_sessions
				WHERE status = 'active' AND idle_deadline_at IS NOT NULL AND idle_deadline_at <= ?
				ORDER BY idle_deadline_at, id`)
			.all(now)
			.map(sessionFromRow);
	}

	findInteractionByToolCall(agentRunId: string, toolCallId: string): TerminalInteraction | undefined {
		return optionalInteraction(
			this.#database
				.prepare("SELECT * FROM terminal_interactions WHERE agent_run_id = ? AND tool_call_id = ?")
				.get(agentRunId, toolCallId),
		);
	}

	findInteraction(id: string): TerminalInteraction | undefined {
		return optionalInteraction(this.#database.prepare("SELECT * FROM terminal_interactions WHERE id = ?").get(id));
	}

	insertInteraction(interaction: TerminalInteraction): void {
		this.#database
			.prepare(`INSERT INTO terminal_interactions (
				id, terminal_session_id, session_id, agent_run_id, tool_call_id, action_json, expectation,
				status, input_sequence, observation_id, guard_decision_json, approval_required,
				failure_json, created_at, updated_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				interaction.id,
				interaction.terminalSessionId,
				interaction.sessionId,
				interaction.agentRunId,
				interaction.toolCallId,
				JSON.stringify(interaction.action),
				interaction.expectation,
				interaction.status,
				interaction.inputSequence,
				interaction.observationId,
				interaction.guardDecision === null ? null : JSON.stringify(interaction.guardDecision),
				interaction.approvalRequired ? 1 : 0,
				interaction.failure === null ? null : JSON.stringify(interaction.failure),
				interaction.createdAt,
				interaction.updatedAt,
				interaction.completedAt,
			);
	}

	updateInteraction(
		interaction: TerminalInteraction,
		expectedStatuses: readonly TerminalInteractionStatus[],
	): boolean {
		if (expectedStatuses.length === 0) return false;
		const placeholders = expectedStatuses.map(() => "?").join(", ");
		return (
			this.#database
				.prepare(`UPDATE terminal_interactions SET status = ?, input_sequence = ?, observation_id = ?,
					guard_decision_json = ?, approval_required = ?, failure_json = ?, updated_at = ?, completed_at = ?
					WHERE id = ? AND status IN (${placeholders})`)
				.run(
					interaction.status,
					interaction.inputSequence,
					interaction.observationId,
					interaction.guardDecision === null ? null : JSON.stringify(interaction.guardDecision),
					interaction.approvalRequired ? 1 : 0,
					interaction.failure === null ? null : JSON.stringify(interaction.failure),
					interaction.updatedAt,
					interaction.completedAt,
					interaction.id,
					...expectedStatuses,
				).changes === 1
		);
	}

	insertInput(input: TerminalInput): void {
		this.#database
			.prepare(`INSERT INTO terminal_inputs (
				id, interaction_id, terminal_session_id, display_text, input_kind, encoded_bytes,
				byte_length, status, terminal_sequence, guard_revision, matched_guard_rule_id, created_at, written_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				input.id,
				input.interactionId,
				input.terminalSessionId,
				input.displayText,
				input.inputKind,
				input.encodedBytes,
				input.byteLength,
				input.status,
				input.terminalSequence,
				input.guardRevision,
				input.matchedGuardRuleId,
				input.createdAt,
				input.writtenAt,
			);
	}

	findInputByInteraction(interactionId: string): TerminalInput | undefined {
		return optionalInput(
			this.#database.prepare("SELECT * FROM terminal_inputs WHERE interaction_id = ?").get(interactionId),
		);
	}

	updateInputStatus(
		interactionId: string,
		status: TerminalInputStatus,
		terminalSequence: number | null,
		writtenAt: number | null,
	): boolean {
		return (
			this.#database
				.prepare(`UPDATE terminal_inputs SET status = ?, terminal_sequence = ?, written_at = ?
					WHERE interaction_id = ?`)
				.run(status, terminalSequence, writtenAt, interactionId).changes === 1
		);
	}

	insertObservation(observation: TerminalObservation): void {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database
				.prepare(`INSERT INTO terminal_observations (
					id, interaction_id, terminal_session_id, start_sequence, end_sequence, kind, rows, cols,
					boundary_reason, agent_view_text, raw_byte_count, truncated, captured_at,
					delivered_at, processing_at, finished_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(
					observation.id,
					observation.interactionId,
					observation.terminalSessionId,
					observation.startSequence,
					observation.endSequence,
					observation.kind,
					observation.geometry.rows,
					observation.geometry.cols,
					observation.boundaryReason,
					observation.agentViewText,
					observation.rawByteCount,
					observation.truncated ? 1 : 0,
					observation.capturedAt,
					observation.deliveredAt,
					observation.processingAt,
					observation.finishedAt,
				);
			this.#database
				.prepare("UPDATE terminal_interactions SET observation_id = ? WHERE id = ?")
				.run(observation.id, observation.interactionId);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	findObservation(id: TerminalObservationId): TerminalObservation | undefined {
		return optionalObservation(this.#database.prepare("SELECT * FROM terminal_observations WHERE id = ?").get(id));
	}

	findObservationByInteraction(interactionId: string): TerminalObservation | undefined {
		return optionalObservation(
			this.#database.prepare("SELECT * FROM terminal_observations WHERE interaction_id = ?").get(interactionId),
		);
	}

	findLatestDeliveredObservation(agentRunId: string): TerminalObservation | undefined {
		return optionalObservation(
			this.#database
				.prepare(`SELECT observation.* FROM terminal_observations observation
					JOIN terminal_interactions interaction ON interaction.id = observation.interaction_id
					WHERE interaction.agent_run_id = ? AND observation.delivered_at IS NOT NULL
					ORDER BY observation.delivered_at DESC, observation.rowid DESC LIMIT 1`)
				.get(agentRunId),
		);
	}

	markObservationStage(
		id: TerminalObservationId,
		stage: "delivered" | "processing" | "finished",
		at: number,
	): boolean {
		const column = stage === "delivered" ? "delivered_at" : stage === "processing" ? "processing_at" : "finished_at";
		return (
			this.#database.prepare(`UPDATE terminal_observations SET ${column} = ? WHERE id = ?`).run(at, id).changes === 1
		);
	}

	appendTimelineEvent(event: Omit<TerminalTimelineEvent, "timelineSequence">): TerminalTimelineEvent {
		const row = this.#database
			.prepare(`SELECT COALESCE(MAX(timeline_sequence), 0) + 1 AS sequence
				FROM terminal_timeline_events WHERE terminal_session_id = ?`)
			.get(event.terminalSessionId);
		const timelineSequence = Number(row?.sequence ?? 1);
		this.#database
			.prepare(`INSERT INTO terminal_timeline_events (
				id, terminal_session_id, session_id, timeline_sequence, terminal_event_sequence, type,
				interaction_id, observation_id, agent_run_id, data_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				event.id,
				event.terminalSessionId,
				event.sessionId,
				timelineSequence,
				event.terminalEventSequence,
				event.type,
				event.interactionId,
				event.observationId,
				event.agentRunId,
				JSON.stringify(event.data),
				event.createdAt,
			);
		return { ...event, timelineSequence };
	}

	listTimeline(sessionId: SessionId, beforeSequence = Number.MAX_SAFE_INTEGER, limit = 100): TerminalTimelineEvent[] {
		return this.#database
			.prepare(`SELECT * FROM terminal_timeline_events
				WHERE session_id = ? AND timeline_sequence < ?
				ORDER BY created_at DESC, rowid DESC LIMIT ?`)
			.all(sessionId, beforeSequence, limit)
			.map(timelineFromRow);
	}
}

function sessionValues(
	session: TerminalSession,
	failureMessage: ReturnType<typeof terminalFailureDescriptor>,
): readonly (string | number | null)[] {
	return [
		session.id,
		session.sessionId,
		session.workspaceId,
		session.openRequestId,
		session.closeRequestId,
		session.status,
		session.revision,
		session.connectionGeneration,
		session.term,
		session.geometry.rows,
		session.geometry.cols,
		session.eventSequence,
		session.ownershipEpoch,
		session.lastConsumerActivityAt,
		session.idleDeadlineAt,
		session.closeReason,
		session.activatedAt,
		session.closingAt,
		session.closedAt,
		session.failureCode,
		session.failureMessage,
		failureMessage?.key ?? null,
		failureMessage?.values === undefined ? null : JSON.stringify(failureMessage.values),
		session.createdAt,
		session.updatedAt,
	];
}

function optionalSession(row: unknown): TerminalSession | undefined {
	return row === undefined ? undefined : sessionFromRow(row);
}

function sessionFromRow(row: unknown): TerminalSession {
	const value = row as Record<string, unknown>;
	return {
		id: String(value.id),
		sessionId: String(value.session_id),
		workspaceId: String(value.workspace_id),
		openRequestId: String(value.open_request_id),
		closeRequestId: nullableString(value.close_request_id),
		status: String(value.status) as TerminalSessionStatus,
		revision: Number(value.revision),
		geometry: { rows: Number(value.rows), cols: Number(value.cols) },
		eventSequence: Number(value.last_event_sequence),
		ownershipEpoch: Number(value.ownership_epoch),
		connectionGeneration: nullableNumber(value.connection_generation),
		term: "xterm-256color",
		activatedAt: nullableNumber(value.activated_at),
		lastConsumerActivityAt: Number(value.last_consumer_activity_at),
		idleDeadlineAt: nullableNumber(value.idle_deadline_at),
		closingAt: nullableNumber(value.closing_at),
		closedAt: nullableNumber(value.closed_at),
		closeReason: nullableString(value.close_reason) as TerminalCloseReason | null,
		failureCode: nullableString(value.failure_code),
		failureMessage: nullableString(value.failure_message),
		...(value.failure_message_key === null || value.failure_message_key === undefined
			? {}
			: { failureMessageKey: String(value.failure_message_key) as BackendMessageKey }),
		...(value.failure_message_values_json === null || value.failure_message_values_json === undefined
			? {}
			: {
					failureMessageValues: JSON.parse(String(value.failure_message_values_json)) as BackendMessageValues,
				}),
		createdAt: Number(value.created_at),
		updatedAt: Number(value.updated_at),
	};
}

function terminalFailureDescriptor(session: TerminalSession) {
	if (session.failureMessageKey !== null && session.failureMessageKey !== undefined) {
		return {
			key: session.failureMessageKey,
			...(session.failureMessageValues == null ? {} : { values: session.failureMessageValues }),
		};
	}
	return session.failureCode === null ? undefined : descriptorForPublicCode(session.failureCode);
}

function optionalInteraction(row: unknown): TerminalInteraction | undefined {
	if (row === undefined) return undefined;
	const value = row as Record<string, unknown>;
	return {
		id: String(value.id),
		terminalSessionId: String(value.terminal_session_id),
		sessionId: String(value.session_id),
		agentRunId: String(value.agent_run_id),
		toolCallId: String(value.tool_call_id),
		action: parsePersistedTerminalAction(value.action_json),
		expectation: String(value.expectation) as TerminalObservationExpectation,
		status: String(value.status) as TerminalInteractionStatus,
		inputSequence: nullableNumber(value.input_sequence),
		observationId: nullableString(value.observation_id),
		guardDecision: parseGuardDecision(value.guard_decision_json),
		approvalRequired: Number(value.approval_required) === 1,
		failure: parseInteractionFailure(value.failure_json),
		createdAt: Number(value.created_at),
		updatedAt: Number(value.updated_at),
		completedAt: nullableNumber(value.completed_at),
	};
}

function parsePersistedTerminalAction(value: unknown): TerminalInteractionAction {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(value)) as unknown;
	} catch (error) {
		throw new Error("Invalid persisted Terminal interaction action JSON", { cause: error });
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Invalid persisted Terminal interaction action");
	}
	const action = parsed as Record<string, unknown>;
	if (action.type === "submit" || action.type === "observe") return { type: action.type };
	if (action.type === "key" && action.key === "CTRL_C") return { type: "key", key: "CTRL_C" };
	throw new Error("Invalid persisted Terminal interaction action");
}

function optionalInput(row: unknown): TerminalInput | undefined {
	if (row === undefined) return undefined;
	const value = row as Record<string, unknown>;
	const encodedBytes = value.encoded_bytes;
	if (!(encodedBytes instanceof Uint8Array)) throw new Error("Invalid persisted Terminal input bytes");
	return {
		id: String(value.id),
		interactionId: String(value.interaction_id),
		terminalSessionId: String(value.terminal_session_id),
		displayText: String(value.display_text),
		inputKind: String(value.input_kind) as TerminalInputKind,
		encodedBytes,
		byteLength: Number(value.byte_length),
		status: String(value.status) as TerminalInputStatus,
		terminalSequence: nullableNumber(value.terminal_sequence),
		guardRevision: nullableNumber(value.guard_revision),
		matchedGuardRuleId: nullableString(value.matched_guard_rule_id),
		createdAt: Number(value.created_at),
		writtenAt: nullableNumber(value.written_at),
	};
}

function optionalObservation(row: unknown): TerminalObservation | undefined {
	if (row === undefined) return undefined;
	const value = row as Record<string, unknown>;
	return {
		id: String(value.id),
		interactionId: String(value.interaction_id),
		terminalSessionId: String(value.terminal_session_id),
		startSequence: Number(value.start_sequence),
		endSequence: Number(value.end_sequence),
		kind: String(value.kind) as TerminalObservationKind,
		geometry: { rows: Number(value.rows), cols: Number(value.cols) },
		boundaryReason: String(value.boundary_reason) as TerminalBoundaryReason,
		agentViewText: String(value.agent_view_text),
		rawByteCount: Number(value.raw_byte_count),
		truncated: Number(value.truncated) === 1,
		capturedAt: Number(value.captured_at),
		deliveredAt: nullableNumber(value.delivered_at),
		processingAt: nullableNumber(value.processing_at),
		finishedAt: nullableNumber(value.finished_at),
	};
}

function timelineFromRow(row: unknown): TerminalTimelineEvent {
	const value = row as Record<string, unknown>;
	return {
		id: String(value.id),
		terminalSessionId: String(value.terminal_session_id),
		sessionId: String(value.session_id),
		timelineSequence: Number(value.timeline_sequence),
		terminalEventSequence: nullableNumber(value.terminal_event_sequence),
		type: String(value.type) as TerminalTimelineEventType,
		interactionId: nullableString(value.interaction_id),
		observationId: nullableString(value.observation_id),
		agentRunId: nullableString(value.agent_run_id),
		data: JSON.parse(String(value.data_json)) as unknown,
		createdAt: Number(value.created_at),
	};
}

function nullableString(value: unknown): string | null {
	return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
	return value === null || value === undefined ? null : Number(value);
}

function parseGuardDecision(value: unknown): TerminalGuardDecision | null {
	if (value === null || value === undefined) return null;
	const parsed = parseJsonRecord(value, "Guard decision");
	if (
		typeof parsed.allowed !== "boolean" ||
		(parsed.guardRevision !== null && !isNonNegativeSafeInteger(parsed.guardRevision)) ||
		(parsed.matchedRuleId !== null && typeof parsed.matchedRuleId !== "string") ||
		(parsed.reason !== null && typeof parsed.reason !== "string")
	) {
		throw new Error("Invalid persisted Terminal Guard decision");
	}
	return {
		allowed: parsed.allowed,
		guardRevision: parsed.guardRevision,
		matchedRuleId: parsed.matchedRuleId,
		reason: parsed.reason,
	};
}

function parseInteractionFailure(value: unknown): TerminalInteractionFailure | null {
	if (value === null || value === undefined) return null;
	const parsed = parseJsonRecord(value, "interaction failure");
	if (typeof parsed.code !== "string") throw new Error("Invalid persisted Terminal interaction failure");
	return { code: parsed.code };
}

function parseJsonRecord(value: unknown, label: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(value)) as unknown;
	} catch (error) {
		throw new Error(`Invalid persisted Terminal ${label} JSON`, { cause: error });
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid persisted Terminal ${label}`);
	}
	return parsed as Record<string, unknown>;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}
