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

	it("tells the Agent when Terminal opened without Landlock after a capability fallback", () => {
		const tool = createTerminalInteractionTool({ sessionId: "session-1", terminalSessionId: "terminal-1",
			agentRunId: "run-1", interactions: {} as TerminalInteractionService,
			sandbox: { mode: "full_access", backend: "none", enforcement: "none", source: "landlock_unavailable", detectedAt: 10 } });
		expect(tool.description).toContain("Landlock unavailable");
		expect(tool.description).toContain("without filesystem confinement");
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
			sandbox: { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 8, launcherVersion: "3", sandboxRoot: "/srv/test" },
		});

		const result = await tool.execute("tool-1", { action: "observe", expectation: "finite" });
		expect(result.content).toEqual([
			{ type: "text", text: "No terminal text was observed before this observation boundary." },
			{ type: "text", text: "Terminal sandbox: Landlock ABI 8; writable root /srv/test." },
		]);
		expect(localizePublicValue(result, "zh-CN")).toMatchObject({
			content: [{ type: "text", text: "在本次观察边界前未检测到终端文本。\nTerminal sandbox: Landlock ABI 8; writable root /srv/test." }],
		});
	});
});
