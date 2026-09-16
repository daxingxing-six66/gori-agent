import type {
	Api,
	AssistantMessage,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	Models,
	RetryPolicy,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import { Agent } from "../agent.ts";
import type { AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.ts";
import { type CompactionSettings, compact as compactContext, prepareCompaction } from "./compaction/compaction.ts";
import { Result, type Result as ResultValue, TaggedError } from "./result.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	Entry,
	JsonValue,
	ProvisionedEntry,
	Session,
	SessionTree,
} from "./session/index.ts";
import type { TelemetryContext } from "./telemetry.ts";
import type { AgentHarnessResources, PromptTemplate, Skill } from "./types.ts";

export class LaneBusy extends TaggedError("LaneBusy")<{
	lane: string;
	operationId: string;
	operationKind: "run" | "compaction" | "navigation";
	message: string;
}> {}
export class MissingIdentities extends TaggedError("MissingIdentities")<{
	lane: string;
	tools: string[];
	models: string[];
	message: string;
}> {}
export class NoActiveRun extends TaggedError("NoActiveRun")<{ lane: string; message: string }> {}
export class NoActiveOperation extends TaggedError("NoActiveOperation")<{ lane: string; message: string }> {}
export class NothingToResume extends TaggedError("NothingToResume")<{ lane: string; message: string }> {}
export class InvalidMessage extends TaggedError("InvalidMessage")<{ lane: string; reason: string; message: string }> {}
export class UnknownSkill extends TaggedError("UnknownSkill")<{ name: string; message: string }> {}
export class UnknownTemplate extends TaggedError("UnknownTemplate")<{ name: string; message: string }> {}
export class UnknownTarget extends TaggedError("UnknownTarget")<{ targetId: string; message: string }> {}
export class UnknownQueueItem extends TaggedError("UnknownQueueItem")<{
	lane: string;
	entryId: string;
	message: string;
}> {}
export class LaneExists extends TaggedError("LaneExists")<{ lane: string; message: string }> {}
export class InvalidLane extends TaggedError("InvalidLane")<{ lane: string; reason: string; message: string }> {}
export class NothingToCompact extends TaggedError("NothingToCompact")<{ lane: string; message: string }> {}
export class Closed extends TaggedError("Closed")<{ message: string }> {}

export class HarnessFault extends Error {
	readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = "HarnessFault";
		this.cause = cause;
	}
}

export class HarnessClosed extends Error {
	constructor() {
		super("AgentHarness was closed while the operation was active");
		this.name = "HarnessClosed";
	}
}

export class HarnessNotImplemented extends Error {
	readonly operation: string;

	constructor(operation: string) {
		super(`AgentHarness.${operation} is not implemented yet`);
		this.name = "HarnessNotImplemented";
		this.operation = operation;
	}
}

export interface OperationError {
	code: string;
	message: string;
}

export type RunOutcome =
	| { kind: "completed"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "aborted"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "failed"; leafId: string; error: OperationError; finalEntryId?: string; finalMessage?: AssistantMessage }
	| { kind: "suspended"; leafId: string; finalEntryId: string; deferred: DeferredHandle };

export type CompactionOutcome =
	| { kind: "completed"; leafId: string; entry: CompactionEntry }
	| { kind: "declined" | "aborted"; leafId: string }
	| { kind: "failed"; leafId: string; error: OperationError };

export type NavigationOutcome =
	| { kind: "completed"; newLeafId: string | null; summaryEntry?: BranchSummaryEntry }
	| { kind: "declined" | "aborted"; leafId: string | null }
	| { kind: "failed"; leafId: string | null; error: OperationError };

export type RunRejected = LaneBusy | InvalidMessage | UnknownSkill | UnknownTemplate | Closed;
export type CompactionRejected = LaneBusy | NothingToCompact | Closed;
export type NavigationRejected = LaneBusy | UnknownTarget | Closed;
export type ResumeRejected = LaneBusy | NothingToResume | MissingIdentities | Closed;
export type QueueRejected = NoActiveRun | InvalidMessage | Closed;
export type CancelQueuedRejected = UnknownQueueItem | Closed;
export type AbortRejected = NoActiveOperation | Closed;

export type RunResult = ResultValue<{ runId: string } & RunOutcome, RunRejected>;
export type CompactionResult = ResultValue<{ runId: string } & CompactionOutcome, CompactionRejected>;
export type NavigationResult = ResultValue<{ runId: string } & NavigationOutcome, NavigationRejected>;
export type QueueResult = ResultValue<{ entryId: string }, QueueRejected>;
export type CancelQueuedResult = ResultValue<
	{ outcome: "cancelled" | "already_consumed" | "already_cleared" },
	CancelQueuedRejected
>;
export type RecordUsageResult = ResultValue<void, Closed>;
export type AbortResult = ResultValue<
	{ runId: string; steer: AgentMessage[]; followUp: AgentMessage[] },
	AbortRejected
>;

export type ResumeOutcome =
	| ({ operation: "run"; runId: string } & RunOutcome)
	| ({ operation: "compaction"; runId: string } & CompactionOutcome)
	| ({ operation: "navigation"; runId: string } & NavigationOutcome);
export type ResumeResult = ResultValue<ResumeOutcome, ResumeRejected>;
export type CreateLaneResult = ResultValue<AgentLane, LaneExists | InvalidLane | UnknownTarget | Closed>;

export interface NavigateOptions {
	summarize?: boolean;
	customInstructions?: string;
	label?: string;
}

export interface SuspendedOperation {
	lane: string;
	kind: "run" | "compaction" | "navigation";
	id: string;
	startedAt: number;
	reason: "crash" | "deferred";
	prompt?: AgentMessage[];
	deferred?: DeferredHandle;
	aborting?: { steer: AgentMessage[]; followUp: AgentMessage[] };
	missing: { tools: string[]; models: string[] };
}

export interface LaneInfo {
	name: string;
	leafId: string | null;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		status: "running" | "suspended" | "aborting";
	};
}

export interface QueuedItem {
	entryId: string;
	message: AgentMessage;
}

export interface LaneSnapshot {
	lane: string;
	transcript: Entry[];
	leafId: string | null;
	operation: LaneInfo["operation"];
	queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
	pendingWrites: { id: string; entry: ProvisionedEntry }[];
	faulted: boolean;
}

export interface SessionSnapshot {
	lanes: (LaneInfo & { suspended?: SuspendedOperation })[];
	faulted: boolean;
}

export type ActionInfo =
	| { kind: "append_entry"; entryType: Entry["type"]; entryId: string }
	| { kind: "append_record"; recordType: string }
	| { kind: "move_lane"; to: string | null }
	| { kind: "set_fact"; fact: "name" | "label" }
	| { kind: "try_finish_run"; outcome: "completed" | "failed" }
	| { kind: "finish_operation"; outcome: "completed" | "declined" | "failed" | "aborted" }
	| { kind: "commit_follow_up" }
	| { kind: "consume_queue_item"; queue: "steer" | "followUp"; entryId: string }
	| { kind: "apply_pending_write"; entryId: string }
	| { kind: "stream_assistant"; step: "assistant" | "compaction" | "branch_summary"; attempt: number }
	| { kind: "execute_tool"; toolCallId: string; toolName: string }
	| { kind: "fetch_deferred" | "cancel_deferred"; provider: string; id: string }
	| { kind: "hook"; name: HookName }
	| { kind: "sleep"; delayMs: number };

export type HookName =
	| "before_run"
	| "before_resume"
	| "before_run_end"
	| "transform_context"
	| "before_request"
	| "before_payload"
	| "after_response"
	| "before_tool"
	| "after_tool"
	| "before_compaction"
	| "before_navigation";

export interface Hooks {
	on(name: HookName, handler: (event: unknown) => unknown | Promise<unknown>, options?: { id?: string }): () => void;
}

export interface Events {
	on(type: string, listener: (event: unknown) => void | Promise<void>): () => void;
}

class CallbackRegistry implements Hooks, Events {
	private readonly callbacks = new Map<string, Set<(event: unknown) => unknown | Promise<unknown>>>();
	on(name: string, handler: (event: unknown) => unknown | Promise<unknown>): () => void {
		const handlers = this.callbacks.get(name) ?? new Set();
		this.callbacks.set(name, handlers);
		handlers.add(handler);
		return () => handlers.delete(handler);
	}
	async emit(name: string, event: unknown): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of this.callbacks.get(name) ?? []) results.push(await handler(event));
		return results;
	}
}

export type HarnessTool = AgentTool & { replay?: "never" | "safe" };
export type Resources = AgentHarnessResources<Skill, PromptTemplate>;
export type StreamOptions = SimpleStreamOptions;
export type StreamOptionsPatch = Partial<SimpleStreamOptions>;
export type EntryProjector = (entry: Entry) => AgentMessage[] | Promise<AgentMessage[]>;

export interface AgentHarnessOptions {
	session: Session;
	models: Models;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames?: string[];
	tools?: HarnessTool[];
	toolContext?: object | (() => object | Promise<object>);
	systemPrompt?: string | (() => string | Promise<string>);
	resources?: Resources;
	streamOptions?: StreamOptions;
	retry?: RetryPolicy;
	compaction?: CompactionSettings;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	toolExecution?: "sequential" | "parallel";
	drive?: "automatic" | "manual";
	toProviderMessages?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	entryProjectors?: Record<string, EntryProjector>;
	context?: TelemetryContext;
}

export interface WatchHandle<TSnapshot> {
	snapshot: TSnapshot;
	start(listener: (event: unknown) => void): void;
	unsubscribe(): void;
}

export interface AgentLane {
	readonly name: string;
	getLeafId(): Promise<string | null>;
	prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	skill(name: string, additionalInstructions?: string): Promise<RunResult>;
	promptFromTemplate(name: string, args?: string[]): Promise<RunResult>;
	compact(options?: { customInstructions?: string }): Promise<CompactionResult>;
	navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult>;
	resume(): Promise<ResumeResult>;
	abort(): Promise<AbortResult>;
	steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
	steer(message: AgentMessage): Promise<QueueResult>;
	followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
	followUp(message: AgentMessage): Promise<QueueResult>;
	nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
	nextRun(message: AgentMessage): Promise<QueueResult>;
	cancelQueued(entryId: string): Promise<CancelQueuedResult>;
	recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult>;
	waitForIdle(): Promise<void>;
	runWhenIdle(callback: () => void | Promise<void>): Promise<void>;
	peekAction(): Promise<ActionInfo | undefined>;
	executeAction(): Promise<ActionInfo | undefined>;
	runToCompletion(): Promise<void>;
	getModel(): Promise<Model<Api>>;
	setModel(model: Model<Api>): Promise<void>;
	getThinkingLevel(): Promise<ThinkingLevel>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	getActiveTools(): Promise<string[]>;
	setActiveTools(names: string[]): Promise<void>;
	readonly session: SessionTree;
	watch(): Promise<WatchHandle<LaneSnapshot>>;
}

export class AgentHarness implements AgentLane {
	readonly name = "main";
	readonly session: SessionTree;
	readonly hooks: Hooks;
	readonly events: Events;
	private readonly durableSession: Session;
	private readonly models: Models;
	private readonly systemPromptSource?: AgentHarnessOptions["systemPrompt"];
	private readonly toProviderMessages?: AgentHarnessOptions["toProviderMessages"];
	private readonly toolExecutionMode: "sequential" | "parallel";
	private model: Model<Api>;
	private thinkingLevel: ThinkingLevel;
	private activeToolNames: string[];
	private tools: HarnessTool[];
	private resources: Resources;
	private streamOptions: StreamOptions;
	private retryPolicy: RetryPolicy;
	private compactionSettings: CompactionSettings;
	private steeringMode: QueueMode;
	private followUpMode: QueueMode;
	private readonly hookRegistry = new CallbackRegistry();
	private readonly eventRegistry = new CallbackRegistry();
	private activeAgent?: Agent;
	private activeRunId?: string;
	private activePromise?: Promise<RunResult>;
	private readonly queued = new Map<string, { queue: "steer" | "followUp" | "nextRun"; message: AgentMessage }>();
	private closed = false;

	private constructor(options: AgentHarnessOptions) {
		this.durableSession = options.session;
		this.models = options.models;
		this.systemPromptSource = options.systemPrompt;
		this.toProviderMessages = options.toProviderMessages;
		this.toolExecutionMode = options.toolExecution ?? "parallel";
		this.session = options.session;
		this.hooks = this.hookRegistry;
		this.events = this.eventRegistry;
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.activeToolNames = [...(options.activeToolNames ?? options.tools?.map((tool) => tool.name) ?? [])];
		this.tools = [...(options.tools ?? [])];
		this.resources = {
			skills: options.resources?.skills ? [...options.resources.skills] : undefined,
			promptTemplates: options.resources?.promptTemplates ? [...options.resources.promptTemplates] : undefined,
		};
		this.streamOptions = { ...(options.streamOptions ?? {}) };
		this.retryPolicy = options.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 1000 };
		this.compactionSettings = options.compaction ?? {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		};
		this.steeringMode = options.steeringMode ?? "one-at-a-time";
		this.followUpMode = options.followUpMode ?? "one-at-a-time";
	}

	static async create(
		options: AgentHarnessOptions,
	): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
		const open = await options.session.findOpenOperations("main");
		return {
			harness: new AgentHarness(options),
			suspended: open.map((record) => ({
				lane: "main",
				kind: record.intent.kind,
				id: record.id,
				startedAt: record.timestamp,
				reason: "crash",
				missing: { tools: [], models: [] },
			})),
		};
	}

	private unavailable<T>(operation: string): Promise<T> {
		return Promise.reject(this.closed ? new HarnessClosed() : new HarnessNotImplemented(operation));
	}

	async getLeafId(): Promise<string | null> {
		return this.durableSession.getLeafId();
	}

	async prompt(_text: string, _images?: ImageContent[]): Promise<RunResult>;
	async prompt(_message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		if (this.activePromise)
			return Result.err(
				new LaneBusy({
					lane: this.name,
					operationId: this.activeRunId!,
					operationKind: "run",
					message: "Lane already has an active run",
				}),
			);
		const nextRun = [...this.queued]
			.filter(([, item]) => item.queue === "nextRun")
			.map(([entryId, item]) => {
				this.queued.delete(entryId);
				return item.message;
			});
		const messages = [...nextRun, ...normalizeInput(input, images)];
		if (messages.length === 0)
			return Result.err(new InvalidMessage({ lane: this.name, reason: "empty", message: "Prompt is empty" }));
		const runId = this.durableSession.idGenerator.next();
		this.activeRunId = runId;
		const promise = this.executePrompt(runId, messages);
		this.activePromise = promise;
		try {
			return await promise;
		} finally {
			this.activePromise = undefined;
			this.activeAgent = undefined;
			this.activeRunId = undefined;
		}
	}

	private async executePrompt(runId: string, messages: AgentMessage[]): Promise<RunResult> {
		await this.hookRegistry.emit("before_run", { lane: this.name, runId, messages });
		const sourceLeafId = await this.getLeafId();
		await this.durableSession.appendRecord({
			type: "operation_started",
			id: runId,
			lane: this.name,
			sourceLeafId,
			intent: { kind: "run", originalPrompt: messages, initialMessages: [] },
		});
		await this.eventRegistry.emit("run_start", { type: "run_start", lane: this.name, runId });
		const contextEntries = await this.session.findEntriesOnBranch({ order: "oldestFirst" });
		const transcript = contextEntries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const systemPrompt =
			typeof this.systemPromptSource === "function" ? await this.systemPromptSource() : this.systemPromptSource;
		const tools = this.tools
			.filter((tool) => this.activeToolNames.includes(tool.name))
			.map((tool): AgentTool => tool);
		const agent = new Agent({
			initialState: {
				systemPrompt: systemPrompt ?? "",
				model: this.model,
				thinkingLevel: this.thinkingLevel,
				tools,
				messages: transcript,
			},
			streamFn: (model, context, options) =>
				this.models.streamSimple(model, context, { ...this.streamOptions, ...options }),
			steeringMode: this.steeringMode,
			followUpMode: this.followUpMode,
			toolExecution: this.toolExecutionMode,
			convertToLlm: this.toProviderMessages,
			beforeToolCall: async (context, signal) => {
				const results = await this.hookRegistry.emit("before_tool", { context, signal, runId });
				return results.find((result) => result !== undefined) as Awaited<
					ReturnType<NonNullable<ConstructorParameters<typeof Agent>[0]["beforeToolCall"]>>
				>;
			},
		});
		this.activeAgent = agent;
		agent.subscribe(async (event) => {
			await this.eventRegistry.emit(event.type, event);
			if (event.type === "message_end") {
				await this.session.appendMessage(event.message);
				if (event.message.role === "user") {
					const queued = [...this.queued].find(([, item]) => item.message === event.message);
					if (queued) this.queued.delete(queued[0]);
				}
			}
		});
		try {
			await agent.prompt(messages);
			const finalMessage = [...agent.state.messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			if (!finalMessage) throw new Error("Agent Run produced no Assistant Message");
			const finalEntryId = (await this.session.findEntry({ type: "message" }))!.id;
			const leafId = (await this.getLeafId())!;
			const outcome =
				finalMessage.stopReason === "aborted"
					? "aborted"
					: finalMessage.stopReason === "error"
						? "failed"
						: "completed";
			await this.hookRegistry.emit("before_run_end", { lane: this.name, runId, outcome, finalMessage });
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: this.name,
				runId,
				outcome,
				...(outcome === "failed"
					? { error: { code: "agent_error", message: finalMessage.errorMessage ?? "Agent Run failed" } }
					: {}),
			});
			await this.eventRegistry.emit("run_end", { type: "run_end", lane: this.name, runId, outcome, leafId });
			if (outcome === "failed")
				return Result.ok({
					runId,
					kind: "failed",
					leafId,
					error: { code: "agent_error", message: finalMessage.errorMessage ?? "Agent Run failed" },
					finalEntryId,
					finalMessage,
				});
			return Result.ok({ runId, kind: outcome, leafId, finalEntryId, finalMessage });
		} catch (error) {
			const leafId = (await this.getLeafId()) ?? sourceLeafId ?? "";
			const message = error instanceof Error ? error.message : "Agent Run failed";
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: this.name,
				runId,
				outcome: "failed",
				error: { code: "harness_fault", message },
			});
			return Result.ok({ runId, kind: "failed", leafId, error: { code: "harness_fault", message } });
		}
	}
	async skill(_name: string, _additionalInstructions?: string): Promise<RunResult> {
		return this.unavailable("skill");
	}
	async promptFromTemplate(_name: string, _args?: string[]): Promise<RunResult> {
		return this.unavailable("promptFromTemplate");
	}
	async compact(_options?: { customInstructions?: string }): Promise<CompactionResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		if (this.activePromise)
			return Result.err(
				new LaneBusy({
					lane: this.name,
					operationId: this.activeRunId!,
					operationKind: "run",
					message: "Lane already has an active run",
				}),
			);
		const entries = await this.session.findEntriesOnBranch({ order: "oldestFirst" });
		const preparation = prepareCompaction(entries, this.compactionSettings);
		if (!preparation.ok || preparation.value === undefined)
			return Result.err(
				new NothingToCompact({
					lane: this.name,
					message: preparation.ok ? "Nothing to compact" : preparation.error.message,
				}),
			);
		const runId = this.durableSession.idGenerator.next();
		const result = await compactContext(
			preparation.value,
			this.models,
			this.model,
			_options?.customInstructions,
			undefined,
			this.thinkingLevel,
			this.retryPolicy,
		);
		if (!result.ok)
			return Result.ok({
				runId,
				kind: "failed",
				leafId: (await this.getLeafId()) ?? "",
				error: { code: result.error.code, message: result.error.message },
			});
		const entry = await this.durableSession.appendEntry<CompactionEntry>(
			{
				type: "compaction",
				id: this.durableSession.idGenerator.next(),
				summary: result.value.summary,
				retainedTail: result.value.retainedTail,
				tokensBefore: result.value.tokensBefore,
				...(result.value.details === undefined ? {} : { details: result.value.details }),
				...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
			},
			this.name,
		);
		return Result.ok({ runId, kind: "completed", leafId: entry.id, entry });
	}
	async navigateTree(_targetId: string | null, _options?: NavigateOptions): Promise<NavigationResult> {
		return this.unavailable("navigateTree");
	}
	async resume(): Promise<ResumeResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		return Result.err(new NothingToResume({ lane: this.name, message: "No resumable operation" }));
	}
	async abort(): Promise<AbortResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		if (!this.activeAgent || !this.activeRunId)
			return Result.err(new NoActiveOperation({ lane: this.name, message: "No active operation" }));
		const runId = this.activeRunId;
		this.activeAgent.abort();
		const steer = [...this.queued.values()].filter((item) => item.queue === "steer").map((item) => item.message);
		const followUp = [...this.queued.values()]
			.filter((item) => item.queue === "followUp")
			.map((item) => item.message);
		return Result.ok({ runId, steer, followUp });
	}
	async steer(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async steer(_message: AgentMessage): Promise<QueueResult>;
	async steer(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		return this.enqueue("steer", _input, _images);
	}
	async followUp(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async followUp(_message: AgentMessage): Promise<QueueResult>;
	async followUp(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		return this.enqueue("followUp", _input, _images);
	}
	async nextRun(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async nextRun(_message: AgentMessage): Promise<QueueResult>;
	async nextRun(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		const message = normalizeInput(_input, _images)[0];
		if (!message)
			return Result.err(
				new InvalidMessage({ lane: this.name, reason: "empty", message: "Queued message is empty" }),
			);
		const entryId = this.durableSession.idGenerator.next();
		this.queued.set(entryId, { queue: "nextRun", message });
		await this.durableSession.appendRecord({
			type: "queue_enqueued",
			id: this.durableSession.idGenerator.next(),
			lane: this.name,
			queue: "nextRun",
			target: { type: "message", id: entryId, message },
		});
		return Result.ok({ entryId });
	}
	async cancelQueued(entryId: string): Promise<CancelQueuedResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		const item = this.queued.get(entryId);
		if (!item) return Result.err(new UnknownQueueItem({ lane: this.name, entryId, message: "Queue item not found" }));
		this.queued.delete(entryId);
		await this.durableSession.appendRecord({
			type: "queue_cancelled",
			id: this.durableSession.idGenerator.next(),
			lane: this.name,
			...(this.activeRunId === undefined ? {} : { runId: this.activeRunId }),
			entryId,
		});
		return Result.ok({ outcome: "cancelled" });
	}
	async recordUsage(_usage: Usage, _options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		await this.durableSession.appendRecord({
			type: "usage",
			id: this.durableSession.idGenerator.next(),
			lane: this.name,
			usage: _usage,
			cause: "adjustment",
			...(_options?.entryId === undefined ? {} : { entryId: _options.entryId }),
			...(_options?.details === undefined ? {} : { details: _options.details }),
		});
		return Result.ok(undefined);
	}
	async waitForIdle(): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		await this.activePromise;
	}
	async runWhenIdle(callback: () => void | Promise<void>): Promise<void> {
		await this.waitForIdle();
		await callback();
	}
	async peekAction(): Promise<ActionInfo | undefined> {
		if (this.closed) throw new HarnessClosed();
		return undefined;
	}
	async executeAction(): Promise<ActionInfo | undefined> {
		if (this.closed) throw new HarnessClosed();
		return undefined;
	}
	async runToCompletion(): Promise<void> {
		await this.waitForIdle();
	}
	async getModel(): Promise<Model<Api>> {
		return this.model;
	}
	async setModel(model: Model<Api>): Promise<void> {
		this.model = model;
	}
	async getThinkingLevel(): Promise<ThinkingLevel> {
		return this.thinkingLevel;
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.thinkingLevel = level;
	}
	async getActiveTools(): Promise<string[]> {
		return [...this.activeToolNames];
	}
	async setActiveTools(names: string[]): Promise<void> {
		this.activeToolNames = [...names];
	}
	async watch(): Promise<WatchHandle<LaneSnapshot>> {
		if (this.closed) throw new HarnessClosed();
		const snapshot = await this.captureLaneSnapshot();
		let unsubscribe = () => {};
		return {
			snapshot,
			start: (listener) => {
				unsubscribe = this.eventRegistry.on("run_start", listener);
			},
			unsubscribe: () => unsubscribe(),
		};
	}

	async lane(_name: string): Promise<AgentLane | undefined> {
		if (this.closed) throw new HarnessClosed();
		return _name === "main" ? this : undefined;
	}
	async createLane(_name: string, _at: string | null): Promise<CreateLaneResult> {
		return this.unavailable("createLane");
	}
	async lanes(): Promise<LaneInfo[]> {
		if (this.closed) throw new HarnessClosed();
		return [
			{
				name: "main",
				leafId: await this.getLeafId(),
				operation: this.activeRunId ? { id: this.activeRunId, kind: "run", status: "running" } : null,
			},
		];
	}
	async getTools(): Promise<HarnessTool[]> {
		return [...this.tools];
	}
	async setTools(tools: HarnessTool[], activeNames?: string[]): Promise<void> {
		this.tools = [...tools];
		this.activeToolNames = [...(activeNames ?? tools.map((tool) => tool.name))];
	}
	async getResources(): Promise<Resources> {
		return {
			skills: this.resources.skills ? [...this.resources.skills] : undefined,
			promptTemplates: this.resources.promptTemplates ? [...this.resources.promptTemplates] : undefined,
		};
	}
	async setResources(resources: Resources): Promise<void> {
		this.resources = {
			skills: resources.skills ? [...resources.skills] : undefined,
			promptTemplates: resources.promptTemplates ? [...resources.promptTemplates] : undefined,
		};
	}
	async getStreamOptions(): Promise<StreamOptions> {
		return { ...this.streamOptions };
	}
	async setStreamOptions(options: StreamOptions): Promise<void> {
		this.streamOptions = { ...options };
	}
	async getRetryPolicy(): Promise<RetryPolicy> {
		return { ...this.retryPolicy };
	}
	async setRetryPolicy(policy: RetryPolicy): Promise<void> {
		this.retryPolicy = { ...policy };
	}
	async getCompactionSettings(): Promise<CompactionSettings> {
		return { ...this.compactionSettings };
	}
	async setCompactionSettings(settings: CompactionSettings): Promise<void> {
		this.compactionSettings = { ...settings };
	}
	async getSteeringMode(): Promise<QueueMode> {
		return this.steeringMode;
	}
	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringMode = mode;
	}
	async getFollowUpMode(): Promise<QueueMode> {
		return this.followUpMode;
	}
	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpMode = mode;
	}
	async watchSession(): Promise<WatchHandle<SessionSnapshot>> {
		if (this.closed) throw new HarnessClosed();
		const snapshot = { lanes: await this.lanes(), faulted: false };
		let unsubscribe = () => {};
		return {
			snapshot,
			start: (listener) => {
				unsubscribe = this.eventRegistry.on("run_start", listener);
			},
			unsubscribe: () => unsubscribe(),
		};
	}
	async close(): Promise<void> {
		this.activeAgent?.abort();
		await this.activePromise;
		this.closed = true;
	}

	private async enqueue(
		queue: "steer" | "followUp",
		input: string | AgentMessage,
		images?: ImageContent[],
	): Promise<QueueResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		if (!this.activeAgent || !this.activeRunId)
			return Result.err(new NoActiveRun({ lane: this.name, message: "No active run" }));
		const message = normalizeInput(input, images)[0];
		if (!message)
			return Result.err(
				new InvalidMessage({ lane: this.name, reason: "empty", message: "Queued message is empty" }),
			);
		const entryId = this.durableSession.idGenerator.next();
		this.queued.set(entryId, { queue, message });
		await this.durableSession.appendRecord({
			type: "queue_enqueued",
			id: this.durableSession.idGenerator.next(),
			lane: this.name,
			queue,
			runId: this.activeRunId,
			target: { type: "message", id: entryId, message },
		});
		if (queue === "steer") this.activeAgent.steer(message);
		else this.activeAgent.followUp(message);
		return Result.ok({ entryId });
	}

	private async captureLaneSnapshot(): Promise<LaneSnapshot> {
		return {
			lane: this.name,
			transcript: await this.session.findEntriesOnBranch({ order: "oldestFirst" }),
			leafId: await this.getLeafId(),
			operation: this.activeRunId ? { id: this.activeRunId, kind: "run", status: "running" } : null,
			queues: {
				steer: [...this.queued]
					.filter(([, item]) => item.queue === "steer")
					.map(([entryId, item]) => ({ entryId, message: item.message })),
				followUp: [...this.queued]
					.filter(([, item]) => item.queue === "followUp")
					.map(([entryId, item]) => ({ entryId, message: item.message })),
				nextRun: [...this.queued]
					.filter(([, item]) => item.queue === "nextRun")
					.map(([entryId, item]) => ({ entryId, message: item.message })),
			},
			pendingWrites: [],
			faulted: false,
		};
	}
}

function normalizeInput(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): AgentMessage[] {
	if (Array.isArray(input)) return input;
	if (typeof input !== "string") return [input];
	const text = input.trim();
	if (!text && (!images || images.length === 0)) return [];
	return [{ role: "user", content: [{ type: "text", text }, ...(images ?? [])], timestamp: Date.now() }];
}
