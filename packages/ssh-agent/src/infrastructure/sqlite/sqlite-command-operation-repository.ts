import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { CommandOperationRepository } from "../../application/repositories/command-operation-repository.ts";
import type {
	CommandOperation,
	CommandOperationStatus,
	OperationEvent,
	OperationEventData,
	OperationEventType,
} from "../../domain/command-operation.ts";
import type { OperationId, SessionId } from "../../domain/ids.ts";
import type { SshFailure } from "../../domain/ssh-failure.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import { descriptorForPublicFailure } from "../../i18n/public-error.ts";

const OPERATION_COLUMNS = `id, tool_call_id, session_id, workspace_id, command_text, requested_cwd,
	resolved_cwd, timeout_ms, status, queue_deadline_at, execution_context_json, guard_revision,
	matched_guard_rule_id, exit_code, exit_signal, failure_json, output_bytes, output_truncated,
	created_at, enqueued_at, claimed_at, started_at, finished_at`;

interface CommandOperationRow {
	id: string;
	tool_call_id: string;
	session_id: string;
	workspace_id: string;
	command_text: string;
	requested_cwd: string | null;
	resolved_cwd: string | null;
	timeout_ms: number;
	status: CommandOperationStatus;
	queue_deadline_at: number;
	execution_context_json: string | null;
	guard_revision: number | null;
	matched_guard_rule_id: string | null;
	exit_code: number | null;
	exit_signal: string | null;
	failure_json: string | null;
	output_bytes: number;
	output_truncated: number;
	created_at: number;
	enqueued_at: number | null;
	claimed_at: number | null;
	started_at: number | null;
	finished_at: number | null;
}

interface OperationEventRow {
	operation_id: string;
	sequence: number;
	timestamp: number;
	type: OperationEventType;
	data_json: string;
}

export class SqliteCommandOperationRepository implements CommandOperationRepository {
	private readonly database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	async insert(operation: CommandOperation): Promise<void> {
		this.database
			.prepare(`INSERT INTO command_operations (${OPERATION_COLUMNS})
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(...operationValues(operation));
	}

	async findById(id: OperationId): Promise<CommandOperation | undefined> {
		const row = this.database.prepare(`SELECT ${OPERATION_COLUMNS} FROM command_operations WHERE id = ?`).get(id);
		return row === undefined ? undefined : operationFromRow(row as unknown as CommandOperationRow);
	}

	async listByStatuses(statuses: readonly CommandOperationStatus[]): Promise<CommandOperation[]> {
		if (statuses.length === 0) return [];
		const placeholders = statuses.map(() => "?").join(", ");
		const rows = this.database
			.prepare(
				`SELECT ${OPERATION_COLUMNS} FROM command_operations WHERE status IN (${placeholders}) ORDER BY created_at, id`,
			)
			.all(...statuses);
		return rows.map((row) => operationFromRow(row as unknown as CommandOperationRow));
	}

	async countActiveBySessionId(sessionId: SessionId): Promise<number> {
		const row = this.database
			.prepare(
				"SELECT COUNT(*) AS count FROM command_operations WHERE session_id = ? AND status IN ('queued', 'dispatching', 'running')",
			)
			.get(sessionId);
		return Number(row?.count ?? 0);
	}

	async update(operation: CommandOperation, expectedStatuses: readonly CommandOperationStatus[]): Promise<boolean> {
		if (expectedStatuses.length === 0) return false;
		const placeholders = expectedStatuses.map(() => "?").join(", ");
		const result = this.database
			.prepare(`UPDATE command_operations SET
				tool_call_id = ?, session_id = ?, workspace_id = ?, command_text = ?, requested_cwd = ?,
				resolved_cwd = ?, timeout_ms = ?, status = ?, queue_deadline_at = ?, execution_context_json = ?,
				guard_revision = ?, matched_guard_rule_id = ?, exit_code = ?, exit_signal = ?, failure_json = ?,
				output_bytes = ?, output_truncated = ?, created_at = ?, enqueued_at = ?, claimed_at = ?,
				started_at = ?, finished_at = ?
				WHERE id = ? AND status IN (${placeholders})`)
			.run(...operationValues(operation).slice(1), operation.id, ...expectedStatuses);
		return result.changes === 1;
	}

	async appendEvent(input: {
		operationId: OperationId;
		timestamp: number;
		type: OperationEventType;
		data: OperationEventData;
	}): Promise<OperationEvent> {
		const row = this.database
			.prepare(
				"SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM command_operation_events WHERE operation_id = ?",
			)
			.get(input.operationId);
		const sequence = Number(row?.sequence ?? 1);
		this.database
			.prepare(
				"INSERT INTO command_operation_events (operation_id, sequence, timestamp, type, data_json) VALUES (?, ?, ?, ?, ?)",
			)
			.run(input.operationId, sequence, input.timestamp, input.type, JSON.stringify(input.data));
		return { ...input, sequence };
	}

	async listEvents(operationId: OperationId, afterSequence = 0): Promise<OperationEvent[]> {
		const rows = this.database
			.prepare(`SELECT operation_id, sequence, timestamp, type, data_json
				FROM command_operation_events WHERE operation_id = ? AND sequence > ? ORDER BY sequence`)
			.all(operationId, afterSequence);
		return rows.map((row) => eventFromRow(row as unknown as OperationEventRow));
	}
}

function operationValues(operation: CommandOperation): SQLInputValue[] {
	return [
		operation.id,
		operation.toolCallId,
		operation.sessionId,
		operation.workspaceId,
		operation.command,
		operation.requestedCwd ?? null,
		operation.resolvedCwd ?? null,
		operation.timeoutMs,
		operation.status,
		operation.queueDeadlineAt,
		operation.executionContext === undefined ? null : JSON.stringify(operation.executionContext),
		operation.guardRevision ?? null,
		operation.matchedGuardRuleId ?? null,
		operation.exitCode ?? null,
		operation.exitSignal ?? null,
		operation.failure === undefined ? null : JSON.stringify(addFailureDescriptor(operation.failure)),
		operation.outputBytes,
		operation.outputTruncated ? 1 : 0,
		operation.createdAt,
		operation.enqueuedAt ?? null,
		operation.claimedAt ?? null,
		operation.startedAt ?? null,
		operation.finishedAt ?? null,
	];
}

function addFailureDescriptor(failure: SshFailure): SshFailure {
	if (failure.messageKey !== undefined) return failure;
	const descriptor = descriptorForPublicFailure(failure.code, failure.message);
	return descriptor === undefined
		? failure
		: {
				...failure,
				messageKey: descriptor.key,
				...(descriptor.values === undefined ? {} : { messageValues: descriptor.values }),
			};
}

function operationFromRow(row: CommandOperationRow): CommandOperation {
	return {
		id: row.id,
		toolCallId: row.tool_call_id,
		sessionId: row.session_id,
		workspaceId: row.workspace_id,
		command: row.command_text,
		...(row.requested_cwd === null ? {} : { requestedCwd: row.requested_cwd }),
		...(row.resolved_cwd === null ? {} : { resolvedCwd: row.resolved_cwd }),
		timeoutMs: row.timeout_ms,
		status: row.status,
		queueDeadlineAt: row.queue_deadline_at,
		...(row.execution_context_json === null
			? {}
			: { executionContext: JSON.parse(row.execution_context_json) as SshTargetSnapshot }),
		...(row.guard_revision === null ? {} : { guardRevision: row.guard_revision }),
		...(row.matched_guard_rule_id === null ? {} : { matchedGuardRuleId: row.matched_guard_rule_id }),
		...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
		...(row.exit_signal === null ? {} : { exitSignal: row.exit_signal }),
		...(row.failure_json === null ? {} : { failure: JSON.parse(row.failure_json) as SshFailure }),
		outputBytes: row.output_bytes,
		outputTruncated: row.output_truncated === 1,
		createdAt: row.created_at,
		...(row.enqueued_at === null ? {} : { enqueuedAt: row.enqueued_at }),
		...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
		...(row.started_at === null ? {} : { startedAt: row.started_at }),
		...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
	};
}

function eventFromRow(row: OperationEventRow): OperationEvent {
	return {
		operationId: row.operation_id,
		sequence: row.sequence,
		timestamp: row.timestamp,
		type: row.type,
		data: JSON.parse(row.data_json) as OperationEventData,
	};
}
