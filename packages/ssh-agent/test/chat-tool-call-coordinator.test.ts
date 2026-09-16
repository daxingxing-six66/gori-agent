import { describe, expect, it, vi } from "vitest";
import type { ApprovalDecision, ChatApprovalService } from "../src/application/services/chat-approval-service.ts";
import type {
	ChatToolAuthorizationPolicy,
	PreparedToolAuthorization,
} from "../src/application/services/chat-tool-authorization-policy.ts";
import { ChatToolCallCoordinator } from "../src/application/services/chat-tool-call-coordinator.ts";
import type { ChatRun } from "../src/domain/chat.ts";

const run: ChatRun = {
	id: "run-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	requestId: "request-1",
	providerId: "provider",
	modelId: "model",
	thinkingLevel: "off",
	serverInteractionMode: "command",
	terminalSessionId: null,
	status: "running",
	createdAt: 1,
	updatedAt: 1,
};

function createContext(
	prepared: PreparedToolAuthorization,
	decision: ApprovalDecision = { approved: true, source: "user" },
) {
	const authorization = {
		prepare: vi.fn(async () => prepared),
		recordDecision: vi.fn(),
		shouldAutoApproveSftpOverwrite: vi.fn(async () => false),
	} satisfies Pick<ChatToolAuthorizationPolicy, "prepare" | "recordDecision" | "shouldAutoApproveSftpOverwrite">;
	const approvals = {
		request: vi.fn(async () => decision),
	} satisfies Pick<ChatApprovalService, "request">;
	return {
		coordinator: new ChatToolCallCoordinator({ authorization, approvals }),
		authorization,
		approvals,
	};
}

function beforeInput(onApprovalRejection = vi.fn()) {
	return {
		run,
		assistantMessageId: "assistant-1",
		toolCallId: "tool-1",
		toolName: "bash",
		args: { command: "echo ok" },
		onApprovalRejection,
	};
}

describe("ChatToolCallCoordinator", () => {
	it.each(["sftp_upload", "sftp_download"] as const)(
		"auto-approves %s only while the Run is active",
		async (toolName) => {
			const context = createContext({ kind: "defer_to_tool" }, { approved: true, source: "auto" });
			context.authorization.shouldAutoApproveSftpOverwrite.mockResolvedValue(true);
			const input = { ...beforeInput(), toolName, description: "Overwrite file" };
			await context.coordinator.beforeToolCall(input);
			await expect(
				context.coordinator.requestSftpOverwriteApproval(input, new AbortController().signal),
			).resolves.toEqual({ approved: true, source: "auto" });
			expect(context.approvals.request).toHaveBeenCalledWith(
				expect.objectContaining({ toolName, autoApprove: true }),
				expect.any(AbortSignal),
			);
			await context.coordinator.beforeToolCall(input);
			context.approvals.request.mockClear();
			const controller = new AbortController();
			controller.abort();
			await expect(context.coordinator.requestSftpOverwriteApproval(input, controller.signal)).resolves.toEqual({
				approved: false,
				reason: "run_cancelled",
			});
			expect(context.approvals.request).not.toHaveBeenCalled();
		},
	);

	it("passes allow and block plans through without creating an Approval", async () => {
		const allowed = createContext({ kind: "allow" });
		await expect(allowed.coordinator.beforeToolCall(beforeInput())).resolves.toBeUndefined();
		expect(allowed.approvals.request).not.toHaveBeenCalled();

		const blockedPlan = {
			kind: "block",
			block: true,
			reason: "blocked",
			terminate: true,
		} as const;
		const blocked = createContext(blockedPlan);
		await expect(blocked.coordinator.beforeToolCall(beforeInput())).resolves.toEqual(blockedPlan);
		expect(blocked.approvals.request).not.toHaveBeenCalled();
	});

	it("creates an Approval and records its Terminal decision", async () => {
		const prepared = {
			kind: "approval",
			autoApprove: false,
			terminalInteraction: { agentRunId: "run-1", toolCallId: "tool-1" },
		} as const;
		const context = createContext(prepared);

		await expect(context.coordinator.beforeToolCall(beforeInput())).resolves.toBeUndefined();
		expect(context.approvals.request).toHaveBeenCalledWith(
			expect.objectContaining({
				run,
				assistantMessageId: "assistant-1",
				toolName: "bash",
				descriptionMessage: { key: "approval.tool_execution.bash" },
				autoApprove: false,
			}),
			undefined,
		);
		expect(context.authorization.recordDecision).toHaveBeenCalledWith(prepared, true);
	});

	it("stops automatic continuation only for user rejection and timeout", async () => {
		const userRejected = createContext(
			{ kind: "approval", autoApprove: false },
			{ approved: false, reason: "user_rejected" },
		);
		const onUserRejection = vi.fn();
		await expect(userRejected.coordinator.beforeToolCall(beforeInput(onUserRejection))).resolves.toEqual({
			block: true,
			reason: "Tool execution was rejected by the user. The tool was not executed.",
			terminate: true,
		});
		expect(onUserRejection).toHaveBeenCalledOnce();

		const cancelled = createContext(
			{ kind: "approval", autoApprove: false },
			{ approved: false, reason: "run_cancelled" },
		);
		const onCancellation = vi.fn();
		await expect(cancelled.coordinator.beforeToolCall(beforeInput(onCancellation))).resolves.toEqual({
			block: true,
			reason: "Tool execution was cancelled because the Chat Run was cancelled.",
		});
		expect(onCancellation).not.toHaveBeenCalled();
	});

	it("uses and clears deferred SFTP Approval context", async () => {
		const context = createContext({ kind: "defer_to_tool" });
		const input = beforeInput();
		await context.coordinator.beforeToolCall(input);
		const controller = new AbortController();

		await expect(
			context.coordinator.requestSftpOverwriteApproval(
				{
					run,
					toolName: "sftp_upload",
					toolCallId: "tool-1",
					description: "Overwrite remote file",
					onApprovalRejection: vi.fn(),
				},
				controller.signal,
			),
		).resolves.toEqual({ approved: true, source: "user" });
		expect(context.approvals.request).toHaveBeenCalledWith(
			expect.objectContaining({
				assistantMessageId: "assistant-1",
				toolName: "sftp_upload",
				autoApprove: false,
			}),
			controller.signal,
		);
		await expect(
			context.coordinator.requestSftpOverwriteApproval(
				{
					run,
					toolName: "sftp_upload",
					toolCallId: "tool-1",
					description: "Overwrite remote file",
					onApprovalRejection: vi.fn(),
				},
				controller.signal,
			),
		).rejects.toThrow("SFTP Tool approval context is unavailable");
	});

	it("clears deferred context when a Run finishes", async () => {
		const context = createContext({ kind: "defer_to_tool" });
		await context.coordinator.beforeToolCall(beforeInput());
		context.coordinator.clearRun("run-1");

		await expect(
			context.coordinator.requestSftpOverwriteApproval(
				{
					run,
					toolName: "sftp_download",
					toolCallId: "tool-1",
					description: "Overwrite local file",
					onApprovalRejection: vi.fn(),
				},
				new AbortController().signal,
			),
		).rejects.toThrow("SFTP Tool approval context is unavailable");
	});
});
