import { describe, expect, it, vi } from "vitest";
import type { TerminalInteractionService } from "../src/application/services/terminal-interaction-service.ts";
import {
	createTerminalInteractionTool,
	terminalInteractionAction,
	terminalInteractionParameters,
	type TerminalInteractionParameters,
} from "../src/application/tools/terminal-interaction-tool.ts";
import { localizePublicValue } from "../src/i18n/projection.ts";

const conflictingArguments = [
	{ action: "submit", input: "pwd", key: "CTRL_C", expectation: "finite" },
	{ action: "key", input: "pwd", key: "CTRL_C", expectation: "finite" },
	{ action: "observe", input: "pwd", expectation: "finite" },
	{ action: "observe", key: "CTRL_C", expectation: "finite" },
	{ action: "observe", input: "pwd", key: "CTRL_C", expectation: "finite" },
] satisfies TerminalInteractionParameters[];

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
		expect(terminalInteractionAction({ action: "key", key: "CTRL_C", expectation: "interactive" })).toEqual({
			type: "key", key: "CTRL_C",
		});
		expect(terminalInteractionAction({ action: "observe", expectation: "streaming" })).toEqual({ type: "observe" });
		expect(() => terminalInteractionAction({ action: "submit", expectation: "finite" })).toThrow(
			"Terminal submit requires",
		);
		expect(() => terminalInteractionAction({ action: "key", expectation: "interactive" })).toThrow(
			"Terminal key action requires",
		);
	});

	it.each(conflictingArguments)("rejects contradictory action fields with correction guidance: %j", (args) => {
		expect(() => terminalInteractionAction(args)).toThrowError(expect.objectContaining({
			terminate: false,
			message: expect.stringContaining("Contradictory terminal_interaction parameters"),
			content: [{ type: "text", text: expect.stringContaining("Regenerate the tool call") }],
		}));
	});

	it.each(conflictingArguments)("rejects contradictory direct calls without dispatching or delivering: %j", async (args) => {
		const execute = vi.fn();
		const markDelivered = vi.fn();
		const tool = createTerminalInteractionTool({
			sessionId: "session-1", terminalSessionId: "terminal-1", agentRunId: "run-1",
			interactions: { execute, markDelivered } as unknown as TerminalInteractionService,
			sandbox: { mode: "full_access", backend: "none", enforcement: "none", source: "session_setting", configuredAt: 10 },
		});
		await expect(tool.execute("conflicting", args)).rejects.toMatchObject({
			terminate: false, message: expect.stringContaining("Regenerate the tool call"),
		});
		expect(execute).not.toHaveBeenCalled();
		expect(markDelivered).not.toHaveBeenCalled();
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
