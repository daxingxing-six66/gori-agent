import { describe, expect, it, vi } from "vitest";
import type { TerminalInteractionService } from "../src/application/services/terminal-interaction-service.ts";
import {
	createTerminalInteractionTool,
	terminalInteractionAction,
	terminalInteractionParameters,
} from "../src/application/tools/terminal-interaction-tool.ts";
import { localizePublicValue } from "../src/i18n/projection.ts";

describe("Terminal interaction Tool schema", () => {
	it("uses an object at the function-parameter root", () => {
		expect(terminalInteractionParameters).toMatchObject({
			type: "object",
			required: ["action", "expectation"],
		});
	});

	it("enforces action-dependent fields before service execution", () => {
		expect(terminalInteractionAction({ action: "submit", input: "pwd", expectation: "finite" })).toEqual({
			type: "submit",
			input: "pwd",
		});
		expect(() => terminalInteractionAction({ action: "submit", expectation: "finite" })).toThrow(
			"Terminal submit requires",
		);
		expect(() => terminalInteractionAction({ action: "key", expectation: "interactive" })).toThrow(
			"Terminal key action requires",
		);
	});

	it("keeps the canonical empty observation for the Agent and localizes only the browser projection", async () => {
		const interactions = {
			execute: vi.fn(async () => ({
				interaction: { id: "interaction-1", expectation: "finite" },
				observation: {
					id: "observation-1",
					terminalSessionId: "terminal-1",
					agentViewText: "",
					kind: "transcript",
					boundaryReason: "quiet",
					startSequence: 1,
					endSequence: 2,
					truncated: false,
				},
			})),
			markDelivered: vi.fn(async () => undefined),
		} as unknown as TerminalInteractionService;
		const tool = createTerminalInteractionTool({
			sessionId: "session-1",
			terminalSessionId: "terminal-1",
			agentRunId: "run-1",
			interactions,
		});

		const result = await tool.execute("tool-1", { action: "observe", expectation: "finite" });
		expect(result.content).toEqual([
			{ type: "text", text: "No terminal text was observed before this observation boundary." },
		]);
		expect(localizePublicValue(result, "zh-CN")).toMatchObject({
			content: [{ type: "text", text: "在本次观察边界前未检测到终端文本。" }],
		});
	});
});
