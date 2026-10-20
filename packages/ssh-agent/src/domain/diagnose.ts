export const DIAGNOSE_LIMITS = { title: 200, direction: 500, explanationBytes: 16_384, conclusionBytes: 262_144, inspectBytes: 65_536 } as const;
export type DiagnoseStatus = "active" | "completed" | "cancelled";
export type DiagnoseNodeStatus = "diagnosing" | "confirmed" | "unconfirmed";

export interface DiagnoseRequestLink { requestId: string; runId: string; queueItemId?: string }
export interface DiagnoseTask {
	id: string;
	sessionId: string;
	workspaceId: string;
	requestId: string;
	title: string;
	status: DiagnoseStatus;
	revision: number;
	currentSequence: number;
	conclusionAvailable: boolean;
	conclusionRequest?: DiagnoseRequestLink;
	createdAt: number;
	updatedAt: number;
	finishedAt?: number;
}
export interface DiagnoseNode {
	taskId: string;
	sequence: number;
	direction: string;
	status: DiagnoseNodeStatus;
	explanation: string;
	revision: number;
	createdAt: number;
	updatedAt: number;
}
export interface DiagnoseNodePage { nodes: DiagnoseNode[]; nextBeforeSequence: number | null }
export interface DiagnoseUpdate {
	title?: string;
	node?: { action: "append" | "update_current"; direction?: string; status?: DiagnoseNodeStatus; explanation?: string };
}
export interface DiagnoseToolBinding { sessionId: string; taskId: string; runId: string; toolCallId: string }
export interface DiagnoseMutationResult {
	taskId: string;
	status: DiagnoseStatus;
	revision: number;
	conclusionAvailable: boolean;
	currentNode?: DiagnoseNode;
}

export class DiagnoseError extends Error {
	readonly code: string;
	readonly status: number;
	readonly field?: string;
	constructor(code: string, message: string, status = 400, field?: string) {
		super(message);
		this.name = "DiagnoseError";
		this.code = code;
		this.status = status;
		this.field = field;
	}
}

export function diagnoseObject(value: unknown, keys: string[], field = "request"): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(field, "must be an object");
	const object = value as Record<string, unknown>;
	if (Object.keys(object).some((key) => !keys.includes(key))) invalid(field, "contains an unknown field");
	return object;
}
export function diagnoseText(value: unknown, field: string, limit: number, bytes = false, empty = false): string {
	if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") ||
		(bytes ? new TextEncoder().encode(value).length : Array.from(value).length) > limit) {
		return invalid(field, `must be ${empty ? "a string" : "nonempty text"} of at most ${limit} ${bytes ? "UTF-8 bytes" : "characters"}`);
	}
	return value;
}
export function parseDiagnoseUpdate(value: unknown): DiagnoseUpdate {
	const input = diagnoseObject(value, ["title", "node"]);
	const result: DiagnoseUpdate = {};
	if (input.title !== undefined) result.title = diagnoseText(input.title, "title", DIAGNOSE_LIMITS.title).trim();
	if (input.node !== undefined) {
		const node = diagnoseObject(input.node, ["action", "direction", "status", "explanation"], "node");
		if (node.action !== "append" && node.action !== "update_current") invalid("node.action", "must be append or update_current");
		result.node = { action: node.action };
		if (node.direction !== undefined) result.node.direction = diagnoseText(node.direction, "node.direction", DIAGNOSE_LIMITS.direction).trim();
		if (node.status !== undefined) {
			if (!isDiagnoseNodeStatus(node.status)) invalid("node.status", "must be diagnosing, confirmed or unconfirmed");
			result.node.status = node.status;
		}
		if (node.explanation !== undefined) result.node.explanation = diagnoseText(node.explanation, "node.explanation", DIAGNOSE_LIMITS.explanationBytes, true, true);
		if (node.action === "append" && !result.node.direction) invalid("node.direction", "is required when appending");
		if (node.action === "update_current" && Object.keys(node).length === 1) invalid("node", "must change at least one field");
	}
	if (!result.title && !result.node) invalid("request", "must include title or node");
	return result;
}
export function isDiagnoseNodeStatus(value: unknown): value is DiagnoseNodeStatus {
	return value === "diagnosing" || value === "confirmed" || value === "unconfirmed";
}
export function assertDiagnoseTerminal(node: Pick<DiagnoseNode, "status" | "explanation">): void {
	if (node.status !== "diagnosing" && !node.explanation.trim()) invalid("node.explanation", "is required for a terminal record; observations, uncertainty or a reason to change direction are sufficient");
}
export function nextDiagnoseNode(task: DiagnoseTask, current: DiagnoseNode | undefined, input: NonNullable<DiagnoseUpdate["node"]>, now: number): DiagnoseNode {
	if (input.action === "append") {
		if (current && (current.status === "diagnosing" || !current.explanation.trim()))
			throw new DiagnoseError("diagnose_current_unfinished", "Finish the current record with confirmed or unconfirmed and an explanation before appending", 409, "node");
		const node: DiagnoseNode = { taskId: task.id, sequence: task.currentSequence + 1,
			direction: input.direction!, status: input.status ?? "diagnosing", explanation: input.explanation ?? "",
			revision: 1, createdAt: now, updatedAt: now };
		assertDiagnoseTerminal(node);
		return node;
	}
	if (!current) throw new DiagnoseError("diagnose_node_missing", "Append the first record before updating it", 409, "node.action");
	const node = { ...current, ...input, revision: current.revision + 1, updatedAt: now };
	assertDiagnoseTerminal(node);
	return { taskId: node.taskId, sequence: node.sequence, direction: node.direction, status: node.status,
		explanation: node.explanation, revision: node.revision, createdAt: node.createdAt, updatedAt: now };
}
export function sealDiagnoseNode(node: DiagnoseNode, cancelled: boolean, now: number): DiagnoseNode | undefined {
	if (node.status !== "diagnosing") return undefined;
	const note = cancelled ? "User exited the diagnosis before this direction was separately confirmed." : "Diagnosis concluded before this direction was separately confirmed.";
	// Termination notes are factual metadata; retain the entire original explanation.
	return { ...node, status: "unconfirmed", explanation: [node.explanation, note].filter(Boolean).join("\n\n"), revision: node.revision + 1, updatedAt: now };
}
function invalid(field: string, reason: string): never {
	throw new DiagnoseError("diagnose_request_invalid", `${field} ${reason}`, 400, field);
}
