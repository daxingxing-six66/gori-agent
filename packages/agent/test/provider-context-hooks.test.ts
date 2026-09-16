import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 2_048,
	};
}

function createAssistantMessage(
	text: string,
	options: { stopReason?: AssistantMessage["stopReason"]; errorMessage?: string } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? "stop",
		errorMessage: options.errorMessage,
		timestamp: Date.now(),
	};
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function convert(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function terminalStream(message: AssistantMessage): MockAssistantStream {
	const stream = new MockAssistantStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else {
			stream.push({ type: "done", reason: "stop", message });
		}
	});
	return stream;
}

async function collect(
	config: AgentLoopConfig,
	streamFn: StreamFn,
): Promise<{ events: AgentEvent[]; messages: AgentMessage[] }> {
	const events: AgentEvent[] = [];
	const stream = agentLoop(
		[user("prompt")],
		{ systemPrompt: "system", messages: [], tools: [] },
		config,
		undefined,
		streamFn,
	);
	for await (const event of stream) events.push(event);
	return { events, messages: await stream.result() };
}

describe("agent provider context hooks", () => {
	it("applies replacement context immediately before the provider request", async () => {
		const replacement = user("compacted context");
		const seen: Message[][] = [];
		const beforeProviderRequest = vi.fn(() => ({
			context: { systemPrompt: "replacement system", messages: [replacement], tools: [] },
		}));
		const streamFn: StreamFn = (_model, context) => {
			seen.push(context.messages);
			return terminalStream(createAssistantMessage("done"));
		};

		await collect({ model: createModel(), convertToLlm: convert, beforeProviderRequest }, streamFn);

		expect(beforeProviderRequest).toHaveBeenCalledOnce();
		expect(seen).toEqual([[replacement]]);
	});

	it("recovers an uncommitted context overflow and retries only the provider request", async () => {
		let call = 0;
		const seen: Message[][] = [];
		const recoverProviderError = vi.fn(({ message }: { message: AssistantMessage }) => {
			expect(message.errorCode).toBe("context_overflow");
			return { context: { systemPrompt: "system", messages: [user("compact")], tools: [] } };
		});
		const streamFn: StreamFn = (_model, context) => {
			seen.push(context.messages);
			call += 1;
			return terminalStream(
				call === 1
					? createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "maximum context length is 8192 tokens",
						})
					: createAssistantMessage("recovered"),
			);
		};

		const result = await collect({ model: createModel(), convertToLlm: convert, recoverProviderError }, streamFn);

		expect(call).toBe(2);
		expect(recoverProviderError).toHaveBeenCalledOnce();
		expect(seen[1]).toEqual([expect.objectContaining({ role: "user", content: "compact" })]);
		const assistantEnds = result.events.filter(
			(event) => event.type === "message_end" && event.message.role === "assistant",
		);
		expect(assistantEnds).toHaveLength(1);
		expect(result.messages).toEqual([
			expect.objectContaining({ role: "user", content: "prompt" }),
			expect.objectContaining({ role: "assistant", stopReason: "stop" }),
		]);
	});

	it("does not retry a second provider overflow", async () => {
		let calls = 0;
		const recoverProviderError = vi.fn(() => ({
			context: { systemPrompt: "system", messages: [user("compact")], tools: [] },
		}));
		const streamFn: StreamFn = () => {
			calls += 1;
			return terminalStream(
				createAssistantMessage("", {
					stopReason: "error",
					errorMessage: "maximum context length is 8192 tokens",
				}),
			);
		};

		const result = await collect({ model: createModel(), convertToLlm: convert, recoverProviderError }, streamFn);

		expect(calls).toBe(2);
		expect(recoverProviderError).toHaveBeenCalledOnce();
		expect(result.messages.at(-1)).toEqual(
			expect.objectContaining({ stopReason: "error", errorCode: "context_overflow" }),
		);
	});

	it("does not recover an overflow after observable streaming output", async () => {
		const recoverProviderError = vi.fn(() => ({
			context: { systemPrompt: "system", messages: [user("compact")], tools: [] },
		}));
		const streamFn: StreamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const partial = createAssistantMessage("");
				stream.push({ type: "start", partial });
				const visible = createAssistantMessage("partial");
				stream.push({ type: "text_start", contentIndex: 0, partial: visible });
				stream.push({
					type: "error",
					reason: "error",
					error: createAssistantMessage("partial", {
						stopReason: "error",
						errorMessage: "maximum context length is 8192 tokens",
					}),
				});
			});
			return stream;
		};

		const result = await collect({ model: createModel(), convertToLlm: convert, recoverProviderError }, streamFn);

		expect(recoverProviderError).not.toHaveBeenCalled();
		expect(result.messages.at(-1)).toEqual(
			expect.objectContaining({ stopReason: "error", errorCode: "context_overflow" }),
		);
	});
});
