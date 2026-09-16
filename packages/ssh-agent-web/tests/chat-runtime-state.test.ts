import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { ChatMarkdown } from "../features/chat/components/chat-markdown.tsx";
import { ChatMessageRow } from "../features/chat/components/chat-message.tsx";
import {
	chatRuntimeReducer,
	initialChatRuntimeState,
} from "../features/chat/model/chat-runtime-state.ts";
import { chatScrollBehavior, isNearChatHistoryTop } from "../features/chat/model/chat-scroll.ts";
import type { AssistantMessage, ChatRun, CompactionSummaryMessage, UserMessage } from "../features/chat/model/chat.ts";
import type { SessionAttachment } from "../features/session/api/session-attachment-api.ts";
import { ChatEventStream, parseChatStreamEvent } from "../features/chat/runtime/chat-event-stream.ts";
import { zhCNMessages } from "../features/i18n/messages/zh-CN.ts";

function renderLocalized(element: ReturnType<typeof createElement>): string {
	return renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: zhCNMessages }, element));
}

const run: ChatRun = {
	id: "run-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	requestId: "request-1",
	providerId: "deepseek",
	modelId: "deepseek-v4-flash",
	thinkingLevel: "off",
	serverInteractionMode: "command",
	terminalSessionId: null,
	status: "running",
	createdAt: 1,
	updatedAt: 2,
};

function assistant(content: AssistantMessage["content"], timestamp = 20): AssistantMessage {
	return { role: "assistant", content, provider: "deepseek", model: "deepseek-v4-flash", stopReason: "pending", timestamp };
}

describe("Chat runtime state", () => {
	it("follows new content near the bottom and exposes a return action after scrolling away", () => {
		expect(chatScrollBehavior({ scrollHeight: 1200, scrollTop: 400, clientHeight: 600 })).toEqual({
			followNewContent: true,
			showReturnToBottom: false,
		});
		expect(chatScrollBehavior({ scrollHeight: 1200, scrollTop: 300, clientHeight: 600 })).toEqual({
			followNewContent: false,
			showReturnToBottom: true,
		});
	});

	it("requests older history only near the top of the timeline", () => {
		expect(isNearChatHistoryTop(120)).toBe(true);
		expect(isNearChatHistoryTop(121)).toBe(false);
	});

	it("keeps thinking, text, and tool calls as separate live blocks and finalizes without another fetch", () => {
		let state = chatRuntimeReducer(initialChatRuntimeState, { type: "setRun", run });
		state = chatRuntimeReducer(state, { type: "event", event: { type: "message_start", data: { type: "message_start", message: assistant([]) } } });
		state = chatRuntimeReducer(state, {
			type: "event",
			event: {
				type: "message_update",
				data: { assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "分析", partial: assistant([{ type: "thinking", thinking: "分析" }]) } },
			},
		});
		state = chatRuntimeReducer(state, {
			type: "event",
			event: {
				type: "message_update",
				data: { assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "完成", partial: assistant([{ type: "thinking", thinking: "分析" }, { type: "text", text: "完成" }]) } },
			},
		});
		const finalMessage = assistant([{ type: "thinking", thinking: "分析" }, { type: "text", text: "完成" }, { type: "toolCall", id: "tool-1", name: "remote_server_call", arguments: { command: "uname -a" } }]);
		state = chatRuntimeReducer(state, { type: "event", event: { type: "message_end", data: { type: "message_end", message: finalMessage } } });

		expect(state.timeline).toHaveLength(1);
		expect(state.timeline[0]).toMatchObject({ final: true, message: finalMessage });
		expect(state.activeAssistantKey).toBeNull();
	});

	it("reconciles an optimistic user message in FIFO order", () => {
		let state = chatRuntimeReducer(initialChatRuntimeState, { type: "optimisticUser", requestId: "request-1", message: "检查服务", attachments: [], timestamp: 10 });
		const finalMessage: UserMessage = { role: "user", content: "检查服务", timestamp: 11 };
		state = chatRuntimeReducer(state, { type: "event", event: { type: "message_end", data: { type: "message_end", message: finalMessage } } });
		expect(state.timeline).toHaveLength(1);
		expect(state.timeline[0]).toMatchObject({ final: true, message: finalMessage });
		expect(state.timeline[0]?.optimisticRequestId).toBeUndefined();
	});

	it("renders persisted image attachments and retains optimistic images after the user SSE event", () => {
		const attachment: SessionAttachment = {
			id: "attachment-1",
			sessionId: "session-1",
			name: "screen.png",
			mimeType: "image/png",
			size: 1_200,
			storagePath: "attachments/sessions/session-1/screen.png",
			contentUrl: "/api/sessions/session-1/attachments/attachment-1/content",
			createdAt: 10,
		};
		const message: UserMessage = { role: "user", content: "分析这张图片", timestamp: 11 };
		let state = chatRuntimeReducer(initialChatRuntimeState, {
			type: "optimisticUser",
			requestId: "request-1",
			message: "分析这张图片",
			attachments: [attachment],
			timestamp: 10,
		});
		state = chatRuntimeReducer(state, { type: "event", event: { type: "message_end", data: { type: "message_end", message } } });
		expect(state.timeline[0]?.attachments).toEqual([attachment]);

		state = chatRuntimeReducer(state, {
			type: "hydrate",
			messages: [{ id: "message-1", sequence: 1, runId: "run-1", message, attachments: [attachment], createdAt: 11 }],
		});
		const html = renderLocalized(createElement(ChatMessageRow, {
			entry: state.timeline[0]!,
			tools: {},
			approvals: {},
			approvalMutationId: null,
			onResolveApproval: vi.fn(),
		}));
		expect(html).toContain('src="/api/sessions/session-1/attachments/attachment-1/content"');
		expect(html).toContain('loading="lazy"');
		expect(html).toContain('alt="screen.png"');
		expect(html).toContain("w-fit min-w-0 max-w-[78%]");
		expect(html).toContain("w-1/2 min-w-0");
		expect(html).toContain("overflow-x-auto");
		expect(html).toContain("h-24 w-24 shrink-0 snap-start");
	});

	it("tracks tool execution, approval, queue, and compaction independently from the UI", () => {
		let state = chatRuntimeReducer(initialChatRuntimeState, { type: "event", event: { type: "tool_execution_start", data: { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "pwd" } } } });
		state = chatRuntimeReducer(state, { type: "event", event: { type: "tool_execution_update", data: { type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", update: { type: "text", detail: { content: "working", mode: "replace" } } } } });
		state = chatRuntimeReducer(state, { type: "event", event: { type: "tool_execution_end", data: { type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: "ok", isError: false } } });
		state = chatRuntimeReducer(state, { type: "event", event: { type: "queue.updated", data: { id: "queue-1", behavior: "steer", status: "pending", message: "继续" } } });
		state = chatRuntimeReducer(state, {
			type: "event",
			event: {
				type: "compaction.started",
				data: {
					reason: "threshold",
					attempt: 1,
					tokensBefore: 100,
					thresholdTokens: 80,
					model: { providerId: "deepseek", modelId: "deepseek-v4-flash", fallback: false },
				},
			},
		});
		expect(state.tools["tool-1"]).toMatchObject({ status: "completed", result: "ok", latestUpdate: { type: "text", detail: { content: "working", mode: "replace" } } });
		expect(state.queue["queue-1"]).toMatchObject({ status: "pending" });
		expect(state.compaction.status).toBe("running");
	});

	it("hydrates full pending Queue items and preserves their metadata across SSE patches", () => {
		const queuedMessage: UserMessage = { role: "user", content: "完成后汇总", timestamp: 30 };
		let state = chatRuntimeReducer(initialChatRuntimeState, {
			type: "hydrateQueue",
			replace: true,
			items: [{
				id: "queue-1",
				sessionId: "session-1",
				runId: "run-1",
				requestId: "queue-request-1",
				behavior: "follow_up",
				message: queuedMessage,
				status: "pending",
				createdAt: 30,
			}],
		});
		state = chatRuntimeReducer(state, {
			type: "event",
			event: { type: "queue.updated", data: { id: "queue-1", status: "cancelled", resolvedAt: 31 } },
		});

		expect(state.queue["queue-1"]).toMatchObject({
			behavior: "follow_up",
			message: queuedMessage,
			status: "cancelled",
			resolvedAt: 31,
		});
	});

	it("keeps a follow-up out of the timeline until the backend emits its consumed user message", () => {
		let state = chatRuntimeReducer(initialChatRuntimeState, { type: "setRun", run });
		state = chatRuntimeReducer(state, {
			type: "event",
			event: { type: "queue.updated", data: { id: "queue-1", behavior: "follow_up", message: "继续检查", status: "pending" } },
		});
		expect(state.timeline).toEqual([]);
		expect(state.queue["queue-1"]).toMatchObject({ status: "pending", message: "继续检查" });

		const consumedMessage: UserMessage = { role: "user", content: "继续检查", timestamp: 31 };
		state = chatRuntimeReducer(state, {
			type: "event",
			event: { type: "message_end", data: { type: "message_end", message: consumedMessage } },
		});
		expect(state.timeline).toHaveLength(1);
		expect(state.timeline[0]?.message).toEqual(consumedMessage);
	});

	it("clears pending Queue and Approval controls when a recovered Run ends", () => {
		let state = chatRuntimeReducer(initialChatRuntimeState, { type: "setRun", run });
		state = chatRuntimeReducer(state, {
			type: "event",
			event: {
				type: "approval.requested",
				data: {
					id: "approval-1",
					sessionId: "session-1",
					runId: "run-1",
					assistantMessageId: "message-1",
					toolCallId: "tool-1",
					toolName: "remote_server_call",
					description: "远程命令需要确认，是否继续执行？",
					status: "pending",
					createdAt: 1,
				},
			},
		});
		state = chatRuntimeReducer(state, {
			type: "event",
			event: { type: "queue.updated", data: { id: "queue-1", behavior: "follow_up", message: "继续", status: "pending" } },
		});
		state = chatRuntimeReducer(state, {
			type: "event",
			event: { type: "run.updated", data: { ...run, status: "cancelled", finishedAt: 40, updatedAt: 40 } },
		});

		expect(state.approvals).toEqual({});
		expect(state.queue).toEqual({});
	});

	it("merges reconnect persistence without duplicating a live final message", () => {
		const message = assistant([{ type: "text", text: "完成" }]);
		let state = chatRuntimeReducer(initialChatRuntimeState, { type: "event", event: { type: "message_end", data: { type: "message_end", message } } });
		state = chatRuntimeReducer(state, { type: "mergePersisted", messages: [{ id: "message-1", sequence: 1, runId: "run-1", message, createdAt: 21 }] });
		expect(state.timeline).toHaveLength(1);
		expect(state.timeline[0]?.sequence).toBe(1);
		expect(state.maxSequence).toBe(1);
	});

	it("hydrates and renders a persisted compaction summary as a timeline node", () => {
		const message: CompactionSummaryMessage = {
			role: "compactionSummary",
			summary: "保留最近的部署操作，并汇总更早的排障记录。",
			tokensBefore: 12_000,
			timestamp: 30,
		};
		const state = chatRuntimeReducer(initialChatRuntimeState, {
			type: "hydrate",
			messages: [{ id: "compact-1", sequence: 4, message, createdAt: 30 }],
		});
		expect(state.timeline[0]).toMatchObject({ sequence: 4, message });

		const html = renderLocalized(createElement(ChatMessageRow, {
			entry: state.timeline[0]!,
			tools: {},
			approvals: {},
			approvalMutationId: null,
			onResolveApproval: vi.fn(),
		}));
		expect(html).toContain("上下文压缩摘要");
		expect(html).toContain("压缩前 12,000 Token");
		expect(html).toContain("保留最近的部署操作");
	});
});

describe("Chat event stream", () => {
	it("parses typed events and keeps one EventSource while run updates arrive", () => {
		const sources: FakeEventSource[] = [];
		const stream = new ChatEventStream("session / 1", "run / 1", "en-US", (url) => {
			const source = new FakeEventSource(url);
			sources.push(source);
			return source;
		});
		const listener = vi.fn();
		stream.subscribe(listener);
		sources[0]?.emit("stream.ready", { runId: "run / 1", connectedAt: 1 });
		sources[0]?.emit("run.updated", run);
		expect(sources).toHaveLength(1);
		expect(listener).toHaveBeenCalledTimes(2);
		expect(sources[0]?.url).toContain("session%20%2F%201/chat/runs/run%20%2F%201/events");
		expect(sources[0]?.url).toContain("locale=en-US");
		stream.close();
	});

	it("rejects malformed message events", () => {
		expect(parseChatStreamEvent("message_end", { message: { role: "assistant" } })).toBeNull();
	});

	it("accepts the public Tool update envelope and rejects legacy or invalid progress payloads", () => {
		expect(parseChatStreamEvent("tool_execution_update", {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "sftp_upload",
			update: { type: "progress", detail: { current: 512, total: 1024, unit: "bytes", message: "Uploading release.tar" } },
		})).toMatchObject({ type: "tool_execution_update", data: { update: { type: "progress" } } });
		expect(parseChatStreamEvent("tool_execution_update", { toolCallId: "tool-1", toolName: "bash", args: {}, partialResult: "legacy" })).toBeNull();
		expect(parseChatStreamEvent("tool_execution_update", {
			toolCallId: "tool-1",
			toolName: "sftp_upload",
			update: { type: "progress", detail: { current: 2, total: 1, unit: "bytes" } },
		})).toBeNull();
	});

	it("requires and preserves approval descriptions", () => {
		const approval = {
			id: "approval-1",
			sessionId: "session-1",
			runId: "run-1",
			assistantMessageId: "message-1",
			toolCallId: "tool-1",
			toolName: "sftp_upload",
			description: "远程文件 /srv/releases/app.tar 已存在。继续执行将覆盖该文件，是否继续执行？",
			status: "pending",
			createdAt: 1,
		};
		expect(parseChatStreamEvent("approval.requested", approval)).toMatchObject({
			type: "approval.requested",
			data: { description: approval.description },
		});
		const withoutDescription: Partial<typeof approval> = { ...approval };
		delete withoutDescription.description;
		expect(parseChatStreamEvent("approval.requested", withoutDescription)).toBeNull();
	});

	it("parses complete compaction events and rejects incomplete payloads", () => {
		const completed = {
			reason: "overflow",
			attempt: 2,
			messageId: "compact-1",
			sequence: 7,
			tokensBefore: 12_000,
			estimatedTokensAfter: 4_000,
			reductionPercent: 66.7,
			model: { providerId: "deepseek", modelId: "deepseek-v4-flash", fallback: false },
		};
		expect(parseChatStreamEvent("compaction.completed", completed)).toEqual({
			type: "compaction.completed",
			data: completed,
		});
		expect(parseChatStreamEvent("compaction.completed", { tokensBefore: 12_000, estimatedTokensAfter: 4_000 })).toBeNull();
	});
});

describe("Chat Tool updates", () => {
	it("renders terminal input as the tool target instead of protocol fields", () => {
		const message = assistant([
			{
				type: "toolCall",
				id: "tool-1",
				name: "terminal_interaction",
				arguments: { action: "submit", expectation: "finite", input: "systemctl restart api.service" },
			},
		]);
		const html = renderLocalized(createElement(ChatMessageRow, {
			entry: { key: "message-1", message, final: true },
			tools: { "tool-1": { toolCallId: "tool-1", toolName: "terminal_interaction", status: "completed" } },
			approvals: {},
			approvalMutationId: null,
			onResolveApproval: vi.fn(),
		}));
		expect(html).toContain("systemctl restart api.service");
		expect(html).not.toContain("expectation=finite");
	});

	it("renders terminal input and key text without protocol fields", () => {
		const message = assistant([
			{
				type: "toolCall",
				id: "tool-1",
				name: "terminal_interaction",
				arguments: { action: "submit", input: "y", expectation: "interactive" },
			},
			{
				type: "toolCall",
				id: "tool-2",
				name: "terminal_interaction",
				arguments: { action: "key", key: "CTRL_C", expectation: "interactive" },
			},
		]);
		const html = renderLocalized(createElement(ChatMessageRow, {
			entry: { key: "message-1", message, final: true },
			tools: {
				"tool-1": { toolCallId: "tool-1", toolName: "terminal_interaction", status: "completed" },
				"tool-2": { toolCallId: "tool-2", toolName: "terminal_interaction", status: "completed" },
			},
			approvals: {},
			approvalMutationId: null,
			onResolveApproval: vi.fn(),
		}));
		expect(html).toContain(">y<");
		expect(html).toContain("Ctrl+C");
		expect(html).not.toContain("expectation=interactive");
	});

	it("renders progress updates with percentage and transferred bytes", () => {
		const message = assistant([{ type: "toolCall", id: "tool-1", name: "sftp_upload", arguments: { path: "/tmp/release.tar" } }]);
		const html = renderLocalized(createElement(ChatMessageRow, {
			entry: { key: "message-1", message, final: false },
			tools: {
				"tool-1": {
					toolCallId: "tool-1",
					toolName: "sftp_upload",
					status: "running",
					latestUpdate: { type: "progress", detail: { current: 512, total: 1024, unit: "bytes", message: "Uploading release.tar" } },
				},
			},
			approvals: {},
			approvalMutationId: null,
			onResolveApproval: vi.fn(),
		}));
		expect(html).toContain("role=\"progressbar\"");
		expect(html).toContain("50%");
		expect(html).toContain("512 B / 1.0 KiB");
	});

	it("renders the backend approval description without inferring it from the Tool name", () => {
		const description = "本地文件 /srv/releases/app.tar 已存在。继续执行将覆盖该文件，是否继续执行？";
		const message = assistant([{ type: "toolCall", id: "tool-1", name: "sftp_download", arguments: { path: "/srv/releases/app.tar" } }]);
		const html = renderLocalized(createElement(ChatMessageRow, {
			entry: { key: "message-1", message, final: false },
			tools: {},
			approvals: {
				"approval-1": {
					id: "approval-1",
					sessionId: "session-1",
					runId: "run-1",
					assistantMessageId: "message-1",
					toolCallId: "tool-1",
					toolName: "sftp_download",
					description,
					status: "pending",
					createdAt: 1,
				},
			},
			approvalMutationId: null,
			onResolveApproval: vi.fn(),
		}));
		expect(html).toContain(description);
	});
});

describe("Chat Markdown", () => {
	it("renders GFM and code while keeping raw HTML inert", () => {
		const html = renderLocalized(createElement(ChatMarkdown, null, "| A | B |\n|---|---|\n| 1 | 2 |\n\n```sh\necho ok\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))"));
		expect(html).toContain("<table>");
		expect(html).toContain("echo ok");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("href=\"javascript:");
	});

	it("keeps indented directory trees as block code without a language tag", () => {
		const html = renderLocalized(createElement(ChatMarkdown, null, "目录结构\n\n    /software/\n    ├── frpc\n    └── frps\n"));
		expect(html).toContain("chat-code-block");
		expect(html).toContain("/software/\n├── frpc\n└── frps");
	});
});

class FakeEventSource {
	readonly url: string;
	onerror: ((event: Event) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	private readonly listeners = new Map<string, Array<(event: Event) => void>>();

	constructor(url: string) { this.url = url; }

	addEventListener(type: string, listener: (event: Event) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	close(): void {}

	emit(type: string, data: unknown): void {
		const event = new MessageEvent(type, { data: JSON.stringify(data) });
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}
