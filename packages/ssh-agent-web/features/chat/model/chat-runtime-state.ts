import type {
	AgentMessage,
	ChatConnectionState,
	ChatMessage,
	ChatQueueEntry,
	ChatQueueItem,
	ChatRun,
	ChatStreamEvent,
	ChatToolExecution,
	ToolApproval,
	ToolResultMessage,
} from "@/features/chat/model/chat";
import type { SessionAttachment } from "@/features/session/api/session-attachment-api";
import type { UserDecision } from "@/features/chat/model/user-decision";
import { isRecord } from "@/features/chat/model/chat";

export interface ChatTimelineEntry {
	historyOrder?: 1;
	key: string;
	runId?: string;
	sequence?: number;
	/** Last persisted sequence observed when this live entry was added. Never a server sequence. */
	afterSequence?: number;
	message: AgentMessage;
	attachments?: SessionAttachment[];
	optimisticRequestId?: string;
	final: boolean;
}

type PersistedTimelineEntry = ChatTimelineEntry & { sequence: number };

export interface ChatRuntimeState {
	connection: ChatConnectionState;
	run: ChatRun | null;
	timeline: ChatTimelineEntry[];
	tools: Record<string, ChatToolExecution>;
	approvals: Record<string, ToolApproval>;
	decisions: Record<string, UserDecision>;
	queue: Record<string, ChatQueueEntry>;
	activeAssistantKey: string | null;
	maxSequence: number;
	readyCount: number;
	compaction: { status: "idle" | "running" | "completed" | "failed"; message?: string };
}

export type ChatRuntimeAction =
	| { type: "hydrate"; messages: ChatMessage[]; approvals?: ToolApproval[]; decisions?: UserDecision[] }
	| { type: "mergePersisted"; messages: ChatMessage[]; approvals?: ToolApproval[]; decisions?: UserDecision[] }
	| { type: "reset" }
	| { type: "connection"; connection: ChatConnectionState }
	| { type: "setRun"; run: ChatRun | null }
	| { type: "clearPendingRuntime" }
	| { type: "hydrateQueue"; items: ChatQueueItem[]; replace: boolean }
	| { type: "optimisticUser"; requestId: string; message: string; attachments: SessionAttachment[]; timestamp: number }
	| { type: "removeOptimistic"; requestId: string }
	| { type: "approvalPending"; approvalId: string; pending: boolean }
	| { type: "event"; event: ChatStreamEvent };

export const initialChatRuntimeState: ChatRuntimeState = {
	connection: "closed",
	run: null,
	timeline: [],
	tools: {},
	approvals: {},
	decisions: {},
	queue: {},
	activeAssistantKey: null,
	maxSequence: 0,
	readyCount: 0,
	compaction: { status: "idle" },
};

export function chatRuntimeReducer(state: ChatRuntimeState, action: ChatRuntimeAction): ChatRuntimeState {
	if (action.type === "reset") return initialChatRuntimeState;
	if (action.type === "hydrate") return hydrate(state, action.messages, action.approvals, action.decisions, false);
	if (action.type === "mergePersisted") return hydrate(state, action.messages, action.approvals, action.decisions, true);
	if (action.type === "connection") return { ...state, connection: action.connection };
	if (action.type === "setRun") return applyRun(state, action.run);
	if (action.type === "clearPendingRuntime") {
		return {
			...state,
			approvals: Object.fromEntries(Object.entries(state.approvals).filter(([, approval]) => approval.status !== "pending")),
			decisions: Object.fromEntries(Object.entries(state.decisions).filter(([, decision]) => decision.status !== "pending")),
			queue: {},
		};
	}
	if (action.type === "hydrateQueue") {
		const queue = action.replace ? {} : { ...state.queue };
		for (const item of action.items) queue[item.id] = mergeQueueEntry(state.queue[item.id], item);
		return { ...state, queue };
	}
	if (action.type === "optimisticUser") {
		return {
			...state,
			timeline: [...state.timeline, {
				key: `optimistic:${action.requestId}`,
				afterSequence: state.maxSequence,
				message: { role: "user", content: action.message, timestamp: action.timestamp },
				...(action.attachments.length === 0 ? {} : { attachments: action.attachments }),
				optimisticRequestId: action.requestId,
				final: false,
			}],
		};
	}
	if (action.type === "removeOptimistic") {
		return { ...state, timeline: state.timeline.filter((entry) => entry.optimisticRequestId !== action.requestId) };
	}
	if (action.type === "approvalPending") {
		const approval = state.approvals[action.approvalId];
		if (!approval) return state;
		return {
			...state,
			approvals: {
				...state.approvals,
				[action.approvalId]: { ...approval, status: action.pending ? "pending" : approval.status },
			},
		};
	}
	return reduceEvent(state, action.event);
}

export function activeChatRun(run: ChatRun | null): run is ChatRun {
	return run?.status === "pending" || run?.status === "running";
}

function hydrate(state: ChatRuntimeState, messages: ChatMessage[], approvals: ToolApproval[] | undefined, decisions: UserDecision[] | undefined, merge: boolean): ChatRuntimeState {
	const currentByKey = new Map(state.timeline.map((entry) => [entry.key, entry]));
	const persisted = messages.map((message) => {
		const incoming = toTimelineEntry(message);
		const current = currentByKey.get(incoming.key);
		return current && isNewerEntry(current, incoming) ? current : incoming;
	});
	const persistedFingerprints = new Set(persisted.map((entry) => messageFingerprint(entry.message)));
	const retained = merge
		? state.timeline.filter((entry) => entry.sequence === undefined && !persistedFingerprints.has(messageFingerprint(entry.message)) &&
			!hasCommittedUser(entry, persisted))
		: [];
	const timeline = dedupeTimeline([...(merge ? state.timeline.filter((entry) => entry.sequence !== undefined) : []), ...persisted, ...retained]);
	// Message-only pagination must not discard pending controls restored by REST or SSE.
	// An explicitly supplied (possibly empty) list is an authoritative pending snapshot.
	const approvalMap: Record<string, ToolApproval> = merge
		? Object.fromEntries(Object.entries(state.approvals).filter(([, approval]) => approvals === undefined || approval.status !== "pending"))
		: {};
	for (const approval of approvals ?? []) {
		const current = approvalMap[approval.id];
		if (approval.status === "pending" && current && current.status !== "pending") continue;
		approvalMap[approval.id] = approval;
	}
	const decisionMap: Record<string, UserDecision> = merge
		? Object.fromEntries(Object.entries(state.decisions).filter(([, decision]) => decisions === undefined || decision.status !== "pending"))
		: {};
	for (const decision of decisions ?? []) {
		const current = decisionMap[decision.id];
		if (decision.status === "pending" && current && current.status !== "pending") continue;
		decisionMap[decision.id] = decision;
	}
	let tools = merge ? state.tools : {};
	for (const entry of timeline) {
		if (entry.message.role === "toolResult") tools = applyToolResult(tools, entry.message);
	}
	return {
		...state,
		timeline,
		tools,
		approvals: approvalMap,
		decisions: decisionMap,
		maxSequence: Math.max(state.maxSequence, ...messages.map((message) => message.sequence), 0),
	};
}

function reduceEvent(state: ChatRuntimeState, event: ChatStreamEvent): ChatRuntimeState {
	if (event.type === "stream.ready") return { ...state, readyCount: state.readyCount + 1, connection: "connected" };
	if (event.type === "run.updated") return applyRun(state, event.data);
	if (event.type === "message_start" || event.type === "message_end") {
		return reduceMessage(state, event.data.message, event.type === "message_end");
	}
	if (event.type === "message_update") {
		const assistantEvent = event.data.assistantMessageEvent;
		const message = assistantEvent.type === "done" ? assistantEvent.message : assistantEvent.type === "error" ? assistantEvent.error : assistantEvent.partial;
		const key = state.activeAssistantKey ?? messageKey(message);
		return {
			...state,
			activeAssistantKey: key,
			timeline: upsertTimeline(state.timeline, { key, runId: state.run?.id, message, final: false }, state.maxSequence),
		};
	}
	if (event.type === "tool_execution_start") {
		return {
			...state,
			tools: {
				...state.tools,
				[event.data.toolCallId]: {
					toolCallId: event.data.toolCallId,
					toolName: event.data.toolName,
					status: "running",
					args: event.data.args,
					startedAt: Date.now(),
				},
			},
		};
	}
	if (event.type === "tool_execution_update") {
		return {
			...state,
			tools: {
				...state.tools,
				[event.data.toolCallId]: {
					...(state.tools[event.data.toolCallId] ?? {
						toolCallId: event.data.toolCallId,
						toolName: event.data.toolName,
						status: "running" as const,
					}),
					latestUpdate: event.data.update,
				},
			},
		};
	}
	if (event.type === "tool_execution_end") {
		return {
			...state,
			tools: {
				...state.tools,
				[event.data.toolCallId]: {
					...(state.tools[event.data.toolCallId] ?? {
						toolCallId: event.data.toolCallId,
						toolName: event.data.toolName,
					}),
					status: event.data.isError ? "failed" : "completed",
					result: event.data.result,
					...(isRecord(event.data.result) && event.data.result.details !== undefined ? { details: event.data.result.details } : {}),
					isError: event.data.isError,
					finishedAt: Date.now(),
				},
			},
		};
	}
	if (event.type === "approval.requested" || event.type === "approval.resolved") {
		return { ...state, approvals: { ...state.approvals, [event.data.id]: event.data } };
	}
	if (event.type === "decision.requested" || event.type === "decision.resolved") {
		return { ...state, decisions: { ...state.decisions, [event.data.id]: event.data } };
	}
	if (event.type === "queue.updated") {
		return {
			...state,
			queue: {
				...state.queue,
				[event.data.id]: mergeQueueEntry(state.queue[event.data.id], event.data),
			},
		};
	}
	if (event.type === "compaction.started") return { ...state, compaction: { status: "running" } };
	if (event.type === "compaction.completed") return { ...state, compaction: { status: "completed" } };
	if (event.type === "compaction.failed") return { ...state, compaction: { status: "failed", message: event.data.message } };
	return state;
}

function mergeQueueEntry(current: ChatQueueEntry | undefined, incoming: ChatQueueEntry): ChatQueueEntry {
	return {
		...current,
		...incoming,
		...(current?.status === "consumed" || current?.status === "cancelled" ? { status: current.status } : {}),
		...(current?.behavior === "steer" ? { behavior: "steer" } : {}),
	};
}

function applyRun(state: ChatRuntimeState, run: ChatRun | null): ChatRuntimeState {
	const boundTimeline = run ? state.timeline.map((entry) => entry.optimisticRequestId === run.requestId ? { ...entry, runId: run.id } : entry) : state.timeline;
	const timeline = boundTimeline.filter((entry) => !hasCommittedUser(entry, boundTimeline));
	if (activeChatRun(run)) return { ...state, run, timeline };
	return {
		...state,
		run,
		timeline,
		approvals: Object.fromEntries(Object.entries(state.approvals).filter(([, approval]) => approval.status !== "pending")),
		decisions: Object.fromEntries(Object.entries(state.decisions).filter(([, decision]) => decision.status !== "pending")),
		queue: {},
	};
}

function reduceMessage(state: ChatRuntimeState, message: AgentMessage, final: boolean): ChatRuntimeState {
	let timeline = state.timeline;
	if (message.role === "user") {
		const optimisticIndex = timeline.findIndex((entry) => entry.optimisticRequestId !== undefined &&
			(entry.runId === undefined || entry.runId === state.run?.id) && userText(entry.message) === userText(message));
		if (optimisticIndex >= 0) {
			const next = [...timeline];
			const optimisticEntry = next[optimisticIndex]!;
			next[optimisticIndex] = {
				key: messageKey(message),
				afterSequence: optimisticEntry.afterSequence,
				runId: state.run?.id,
				message,
				...(optimisticEntry.attachments === undefined ? {} : { attachments: optimisticEntry.attachments }),
				final,
			};
			timeline = dedupeTimeline(next);
		} else timeline = upsertTimeline(timeline, { key: messageKey(message), runId: state.run?.id, message, final }, state.maxSequence);
	} else {
		timeline = upsertTimeline(timeline, { key: messageKey(message), runId: state.run?.id, message, final }, state.maxSequence);
	}
	return {
		...state,
		timeline,
		tools: message.role === "toolResult" ? applyToolResult(state.tools, message) : state.tools,
		activeAssistantKey: message.role === "assistant" && final ? null : state.activeAssistantKey,
	};
}

function applyToolResult(tools: Record<string, ChatToolExecution>, message: ToolResultMessage): Record<string, ChatToolExecution> {
	return {
		...tools,
		[message.toolCallId]: {
			...(tools[message.toolCallId] ?? { toolCallId: message.toolCallId, toolName: message.toolName }),
			status: message.isError ? "failed" : "completed",
			result: message.content,
			...(message.details === undefined ? {} : { details: message.details }),
			isError: message.isError,
			finishedAt: message.timestamp,
		},
	};
}

function toTimelineEntry(message: ChatMessage): ChatTimelineEntry {
	return {
		key: `persisted:${message.id}`,
		...(message.runId === undefined ? {} : { runId: message.runId }),
		sequence: message.sequence,
		...(message.historyOrder === undefined ? {} : { historyOrder: message.historyOrder }),
		message: message.message,
		...(message.attachments === undefined ? {} : { attachments: message.attachments }),
		final: true,
	};
}

function upsertTimeline(timeline: ChatTimelineEntry[], entry: ChatTimelineEntry, afterSequence: number): ChatTimelineEntry[] {
	const fingerprint = messageFingerprint(entry.message);
	const index = timeline.findIndex((candidate) => candidate.key === entry.key || messageFingerprint(candidate.message) === fingerprint);
	if (index < 0) return [...timeline, { ...entry, afterSequence }];
	const next = [...timeline];
	next[index] = { ...timeline[index], ...entry };
	return next;
}

function dedupeTimeline(timeline: ChatTimelineEntry[]): ChatTimelineEntry[] {
	const byFingerprint = new Map<string, ChatTimelineEntry>();
	for (const entry of timeline) {
		const key = messageFingerprint(entry.message);
		const current = byFingerprint.get(key);
		// A delayed page/event must not replace a newer persisted revision that moved in history.
		if (current && isNewerEntry(current, entry)) continue;
		if (!current || entry.sequence !== undefined || (entry.final && !current.final)) byFingerprint.set(key, entry);
	}
	const entries = [...byFingerprint.values()];
	const persisted = entries.filter((entry): entry is PersistedTimelineEntry => entry.sequence !== undefined).sort(compareTimelineEntries);
	const ordered: ChatTimelineEntry[] = [];
	let cursor = 0;
	// Sequence orders committed facts. Live entries retain stream order and are inserted
	// by time after their observed anchor, without comparing a sequence to a timestamp.
	for (const entry of entries.filter((entry) => entry.sequence === undefined)) {
		while (cursor < persisted.length) {
			const next = persisted[cursor]!;
			if (next.sequence > (entry.afterSequence ?? 0) && next.message.timestamp >= entry.message.timestamp) break;
			ordered.push(next); cursor++;
		}
		ordered.push(entry);
	}
	return [...ordered, ...persisted.slice(cursor)];
}

function compareTimelineEntries(left: PersistedTimelineEntry, right: PersistedTimelineEntry): number {
	return left.sequence - right.sequence
		|| (left.historyOrder ?? 0) - (right.historyOrder ?? 0)
		|| (left.historyOrder ? left.message.timestamp - right.message.timestamp || (left.key === right.key ? 0 : left.key < right.key ? -1 : 1) : 0);
}

function messageKey(message: AgentMessage): string {
	return `live:${messageFingerprint(message)}`;
}

function messageFingerprint(message: AgentMessage): string {
	if (message.role === "system" && message.runtimeEventId) return `system:${message.runtimeEventId}`;
	if (message.role === "custom" && message.customType === "deployment" &&
		isRecord(message.details) && typeof message.details.deploymentId === "string")
		return `deployment:${message.details.deploymentId}`;
	if (message.role === "custom" && message.customType === "diagnose" &&
		isRecord(message.details) && typeof message.details.taskId === "string")
		return `diagnose:${message.details.taskId}`;
	return `${message.role}:${message.timestamp}${message.role === "toolResult" ? `:${message.toolCallId}` : ""}`;
}

function isNewerEntry(current: ChatTimelineEntry, incoming: ChatTimelineEntry): boolean {
	if (current.sequence === undefined || incoming.sequence === undefined) return false;
	if (current.sequence !== incoming.sequence) return current.sequence > incoming.sequence;
	const left = current.message;
	const right = incoming.message;
	return left.role === "custom" && right.role === "custom" && left.customType === right.customType &&
		isRecord(left.details) && isRecord(right.details) && typeof left.details.revision === "number" &&
		typeof right.details.revision === "number" && left.details.revision > right.details.revision;
}

function userText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("");
}

function hasCommittedUser(entry: ChatTimelineEntry, entries: ChatTimelineEntry[]): boolean {
	return entry.optimisticRequestId !== undefined && entry.runId !== undefined && entries.some((candidate) =>
		candidate.sequence !== undefined && candidate.runId === entry.runId && candidate.message.role === "user" &&
		userText(candidate.message) === userText(entry.message));
}

export function approvalForTool(approvals: Record<string, ToolApproval>, toolCallId: string): ToolApproval | undefined {
	const matching = Object.values(approvals).filter((approval) => approval.toolCallId === toolCallId);
	return matching.find((approval) => approval.status === "pending") ?? matching.at(-1);
}

export function toolResultText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value.flatMap((entry) => entry && typeof entry === "object" && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string" ? [entry.text] : []).join("\n");
	}
	if (value === undefined) return "";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
