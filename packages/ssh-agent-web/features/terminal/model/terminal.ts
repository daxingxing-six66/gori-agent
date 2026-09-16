export type TerminalSessionStatus = "opening" | "active" | "closing" | "closed" | "failed" | "lost";
export type ServerInteractionMode = "command" | "terminal";

export interface TerminalGeometry {
	rows: number;
	cols: number;
}

export interface TerminalSessionView {
	id: string;
	sessionId: string;
	workspaceId: string;
	status: TerminalSessionStatus;
	geometry: TerminalGeometry;
	eventSequence: number;
	ownershipEpoch: number;
	closeReason: string | null;
	failureCode: string | null;
	failureMessage: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface TerminalStatusResponse {
	terminal: TerminalSessionView | null;
	effectiveServerInteractionMode: ServerInteractionMode;
	transitionInProgress: boolean;
	capabilities: { minRows: number; maxRows: number; minCols: number; maxCols: number };
}

export interface TerminalSnapshotV1 extends TerminalGeometry {
	format: "xterm-ansi";
	formatVersion: 1;
	encoding: "base64";
	data: string;
	sequence: number;
}

export interface TerminalAttachmentBootstrap {
	attachmentId: string;
	terminalSessionId: string;
	status: "bootstrapping";
	snapshot: TerminalSnapshotV1;
	owner: false;
	ownershipEpoch: null;
}

export interface TerminalOwnership {
	owner: boolean;
	ownershipEpoch: number | null;
}

export interface TerminalTimelineEvent {
	id: string;
	terminalSessionId: string;
	sessionId: string;
	timelineSequence: number;
	terminalEventSequence: number | null;
	type: string;
	interactionId: string | null;
	observationId: string | null;
	agentRunId: string | null;
	data: unknown;
	createdAt: number;
}

export interface TerminalObservationView {
	id: string;
	terminalSessionId: string;
	startSequence: number;
	endSequence: number;
	kind: "transcript" | "screen";
	agentViewText: string;
	capturedAt: number;
}

export interface TerminalSseEnvelope {
	version: 1;
	terminalSessionId: string;
	type: string;
	sequence: number | null;
	emittedAt: string;
	data: Record<string, unknown>;
}

export function requireTerminalStatus(value: unknown): TerminalStatusResponse {
	if (!isRecord(value) || !isMode(value.effectiveServerInteractionMode) || typeof value.transitionInProgress !== "boolean") {
		throw new Error("Invalid Terminal status response");
	}
	if (!isCapabilities(value.capabilities)) throw new Error("Invalid Terminal capabilities");
	if (value.terminal !== null && !isTerminalSession(value.terminal)) throw new Error("Invalid TerminalSession response");
	return {
		terminal: value.terminal,
		effectiveServerInteractionMode: value.effectiveServerInteractionMode,
		transitionInProgress: value.transitionInProgress,
		capabilities: value.capabilities,
	};
}

export function requireTerminalSession(value: unknown): TerminalSessionView {
	if (!isTerminalSession(value)) throw new Error("Invalid TerminalSession response");
	return value;
}

export function requireTerminalAttachment(value: unknown): TerminalAttachmentBootstrap {
	if (
		!isRecord(value) ||
		typeof value.attachmentId !== "string" ||
		typeof value.terminalSessionId !== "string" ||
		value.status !== "bootstrapping" ||
		value.owner !== false ||
		value.ownershipEpoch !== null ||
		!isSnapshot(value.snapshot)
	) {
		throw new Error("Invalid Terminal attachment response");
	}
	return {
		attachmentId: value.attachmentId,
		terminalSessionId: value.terminalSessionId,
		status: value.status,
		snapshot: value.snapshot,
		owner: value.owner,
		ownershipEpoch: value.ownershipEpoch,
	};
}

export function requireTerminalOwnership(value: unknown): TerminalOwnership {
	if (
		!isRecord(value) ||
		typeof value.owner !== "boolean" ||
		(value.ownershipEpoch !== null && !isNonNegativeSafeInteger(value.ownershipEpoch)) ||
		(value.owner && value.ownershipEpoch === null)
	) {
		throw new Error("Invalid Terminal ownership response");
	}
	return { owner: value.owner, ownershipEpoch: value.ownershipEpoch };
}

export function requireTerminalTimeline(value: unknown): TerminalTimelineEvent[] {
	if (!isRecord(value) || !Array.isArray(value.events) || !value.events.every(isTimelineEvent)) {
		throw new Error("Invalid Terminal timeline response");
	}
	return value.events;
}

export function requireTerminalObservation(value: unknown): TerminalObservationView {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.terminalSessionId !== "string" ||
		!isNonNegativeSafeInteger(value.startSequence) ||
		!isNonNegativeSafeInteger(value.endSequence) ||
		value.startSequence > value.endSequence ||
		(value.kind !== "transcript" && value.kind !== "screen") ||
		typeof value.agentViewText !== "string" ||
		!isFiniteNumber(value.capturedAt)
	) {
		throw new Error("Invalid Terminal Observation response");
	}
	return {
		id: value.id,
		terminalSessionId: value.terminalSessionId,
		startSequence: value.startSequence,
		endSequence: value.endSequence,
		kind: value.kind,
		agentViewText: value.agentViewText,
		capturedAt: value.capturedAt,
	};
}

export function parseTerminalEnvelope(value: unknown, expectedType: string): TerminalSseEnvelope | null {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.terminalSessionId !== "string" ||
		value.type !== expectedType ||
		(value.sequence !== null && !isNonNegativeSafeInteger(value.sequence)) ||
		!isIsoTimestamp(value.emittedAt) ||
		!isRecord(value.data)
	) {
		return null;
	}
	return {
		version: value.version,
		terminalSessionId: value.terminalSessionId,
		type: value.type,
		sequence: value.sequence,
		emittedAt: value.emittedAt,
		data: value.data,
	};
}

function isTerminalSession(value: unknown): value is TerminalSessionView {
	if (!isRecord(value) || !isStatus(value.status) || !isGeometry(value.geometry)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.sessionId === "string" &&
		typeof value.workspaceId === "string" &&
		isNonNegativeSafeInteger(value.eventSequence) &&
		isNonNegativeSafeInteger(value.ownershipEpoch) &&
		(value.closeReason === null || typeof value.closeReason === "string") &&
		(value.failureCode === null || typeof value.failureCode === "string") &&
		(value.failureMessage === null || typeof value.failureMessage === "string") &&
		isFiniteNumber(value.createdAt) &&
		isFiniteNumber(value.updatedAt)
	);
}

function isSnapshot(value: unknown): value is TerminalSnapshotV1 {
	return (
		isRecord(value) &&
		value.format === "xterm-ansi" &&
		value.formatVersion === 1 &&
		value.encoding === "base64" &&
		typeof value.data === "string" &&
		isNonNegativeSafeInteger(value.sequence) &&
		isGeometry(value)
	);
}

function isTimelineEvent(value: unknown): value is TerminalTimelineEvent {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.terminalSessionId === "string" &&
		typeof value.sessionId === "string" &&
		isNonNegativeSafeInteger(value.timelineSequence) &&
		(value.terminalEventSequence === null || isNonNegativeSafeInteger(value.terminalEventSequence)) &&
		typeof value.type === "string" &&
		(value.interactionId === null || typeof value.interactionId === "string") &&
		(value.observationId === null || typeof value.observationId === "string") &&
		(value.agentRunId === null || typeof value.agentRunId === "string") &&
		isFiniteNumber(value.createdAt)
	);
}

function isCapabilities(value: unknown): value is TerminalStatusResponse["capabilities"] {
	return (
		isRecord(value) &&
		isPositiveSafeInteger(value.minRows) &&
		isPositiveSafeInteger(value.maxRows) &&
		isPositiveSafeInteger(value.minCols) &&
		isPositiveSafeInteger(value.maxCols) &&
		value.minRows <= value.maxRows &&
		value.minCols <= value.maxCols
	);
}

function isGeometry(value: unknown): value is TerminalGeometry {
	return isRecord(value) && isPositiveSafeInteger(value.rows) && isPositiveSafeInteger(value.cols);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isStatus(value: unknown): value is TerminalSessionStatus {
	return value === "opening" || value === "active" || value === "closing" || value === "closed" || value === "failed" || value === "lost";
}

function isMode(value: unknown): value is ServerInteractionMode {
	return value === "command" || value === "terminal";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
