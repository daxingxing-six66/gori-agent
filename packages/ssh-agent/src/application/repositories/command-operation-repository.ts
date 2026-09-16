import type {
	CommandOperation,
	CommandOperationStatus,
	OperationEvent,
	OperationEventData,
	OperationEventType,
} from "../../domain/command-operation.ts";
import type { OperationId, SessionId } from "../../domain/ids.ts";

export interface CommandOperationRepository {
	insert(operation: CommandOperation): Promise<void>;
	findById(id: OperationId): Promise<CommandOperation | undefined>;
	listByStatuses(statuses: readonly CommandOperationStatus[]): Promise<CommandOperation[]>;
	countActiveBySessionId(sessionId: SessionId): Promise<number>;
	update(operation: CommandOperation, expectedStatuses: readonly CommandOperationStatus[]): Promise<boolean>;
	appendEvent(input: {
		operationId: OperationId;
		timestamp: number;
		type: OperationEventType;
		data: OperationEventData;
	}): Promise<OperationEvent>;
	listEvents(operationId: OperationId, afterSequence?: number): Promise<OperationEvent[]>;
}
