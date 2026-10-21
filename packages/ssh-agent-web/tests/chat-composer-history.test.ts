import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../features/chat/model/chat";
import { recentChatComposerMessages } from "../features/chat/model/chat-composer-history";

const entry = (message: AgentMessage) => ({ message });
const user = (text: string, timestamp = 1) => entry({ role: "user", content: text, timestamp });

describe("recent composer message selection", () => {
	it("selects only the latest seven user messages in reverse history order", () => {
		const timeline = Array.from({ length: 10 }, (_, index) => user(`message ${index}`, index));
		expect(recentChatComposerMessages(timeline)).toEqual([
			"message 9", "message 8", "message 7", "message 6", "message 5", "message 4", "message 3",
		]);
		expect(timeline[0]!.message.timestamp).toBe(0);
	});

	it("skips assistant, system and tool output without consuming history slots", () => {
		const timeline = [user("first"), entry({ role: "assistant", content: [{ type: "text", text: "assistant" }],
			provider: "test", model: "test", stopReason: "stop", timestamp: 2 }),
			entry({ role: "system", content: [{ type: "text", text: "system" }], timestamp: 3 }),
			entry({ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "tool output" }], isError: false, timestamp: 4 }),
			user("last", 5)];
		expect(recentChatComposerMessages(timeline)).toEqual(["last", "first"]);
	});

	it("preserves repeated messages and skips empty or image-only inputs", () => {
		const timeline = [user("same", 1), user(" \n", 2), entry({ role: "user", content: [{ type: "image", data: "image-bytes", mimeType: "image/png" }], timestamp: 3 }), user("same", 4)];
		expect(recentChatComposerMessages(timeline)).toEqual(["same", "same"]);
	});

	it("extracts text blocks verbatim without image bytes or reference rewriting", () => {
		const reference = '<file name="notes.md" path="/work/notes.md" type="text/markdown" />';
		const timeline = [entry({ role: "user", timestamp: 1, content: [
			{ type: "text", text: `请读取\n${reference}` },
			{ type: "image", data: "private-image-bytes", mimeType: "image/png" },
			{ type: "text", text: "\n保留换行" },
		] })];
		expect(recentChatComposerMessages(timeline)).toEqual([`请读取\n${reference}\n保留换行`]);
	});
});
