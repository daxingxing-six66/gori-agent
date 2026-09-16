import { describe, expect, it, vi } from "vitest";
import { ChatToolAuthorizationPolicy } from "../src/application/services/chat-tool-authorization-policy.ts";
import type { TerminalInteractionService } from "../src/application/services/terminal-interaction-service.ts";
import type { ChatRun } from "../src/domain/chat.ts";
import type { Session } from "../src/domain/session.ts";

const run: ChatRun = {
	id: "run-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	requestId: "request-1",
	providerId: "provider",
	modelId: "model",
	thinkingLevel: "off",
	serverInteractionMode: "terminal",
	terminalSessionId: "terminal-1",
	status: "running",
	createdAt: 1,
	updatedAt: 1,
};

function createPolicy(options: { autoAudit?: boolean; remoteAllowed?: boolean; terminalAllowed?: boolean } = {}) {
	const session: Session = {
		id: "session-1",
		workspaceId: "workspace-1",
		displayName: "test",
		workDir: null,
		autoAudit: options.autoAudit ?? false,
		terminalContextCursor: 0,
		revision: 1,
		createdAt: 1,
		updatedAt: 1,
	};
	const findById = vi.fn(async () => session);
	const preflightSubmit = vi.fn(async () => ({ allowed: options.terminalAllowed ?? true }));
	const approve = vi.fn();
	const reject = vi.fn();
	const terminalInteractions = {
		preflightSubmit,
		approve,
		reject,
	} satisfies Pick<TerminalInteractionService, "preflightSubmit" | "approve" | "reject">;
	const preflightRemoteGuard = vi.fn(async () => ({
		allowed: options.remoteAllowed ?? true,
		...(options.remoteAllowed === false ? { reason: "remote blocked" } : {}),
	}));
	return {
		policy: new ChatToolAuthorizationPolicy({
			sessions: { findById },
			terminalInteractions,
			preflightRemoteGuard,
		}),
		findById,
		preflightSubmit,
		preflightRemoteGuard,
		approve,
		reject,
	};
}

describe("ChatToolAuthorizationPolicy", () => {
	it("reads the current Session setting when an SFTP overwrite needs authorization", async () => {
		const context = createPolicy({ autoAudit: true });
		await expect(context.policy.shouldAutoApproveSftpOverwrite(run.sessionId)).resolves.toBe(true);
		const session = await context.findById();
		session.autoAudit = false;
		await expect(context.policy.shouldAutoApproveSftpOverwrite(run.sessionId)).resolves.toBe(false);
		expect(context.findById).toHaveBeenCalledWith(run.sessionId);
	});

	it("allows read and defers SFTP overwrite approval without loading Session policy", async () => {
		const context = createPolicy();

		await expect(context.policy.prepare({ run, toolCallId: "read-1", toolName: "read", args: {} })).resolves.toEqual({
			kind: "allow",
		});
		await expect(
			context.policy.prepare({ run, toolCallId: "sftp-1", toolName: "sftp_upload", args: {} }),
		).resolves.toEqual({ kind: "defer_to_tool" });
		expect(context.findById).not.toHaveBeenCalled();
	});

	it("blocks a remote command before Approval when Workspace Guard rejects it", async () => {
		const context = createPolicy({ remoteAllowed: false });

		await expect(
			context.policy.prepare({
				run: { ...run, serverInteractionMode: "command", terminalSessionId: null },
				toolCallId: "remote-1",
				toolName: "remote_server_call",
				args: { command: "rm -rf /" },
			}),
		).resolves.toEqual({ kind: "block", block: true, reason: "remote blocked", terminate: true });
		expect(context.preflightRemoteGuard).toHaveBeenCalledWith("session-1", "rm -rf /");
		expect(context.findById).not.toHaveBeenCalled();
	});

	it("uses autoAudit only after Guard allows an approvable Tool", async () => {
		const context = createPolicy({ autoAudit: true });

		await expect(
			context.policy.prepare({ run, toolCallId: "write-1", toolName: "write", args: {} }),
		).resolves.toEqual({ kind: "approval", autoApprove: true });
		await expect(
			context.policy.prepare({ run, toolCallId: "unknown-1", toolName: "custom_tool", args: {} }),
		).resolves.toEqual({ kind: "approval", autoApprove: false });
	});

	it("prepares Terminal submit and records the final Approval decision", async () => {
		const context = createPolicy({ autoAudit: false });
		const prepared = await context.policy.prepare({
			run,
			toolCallId: "terminal-1",
			toolName: "terminal_interaction",
			args: { action: "submit", input: "echo ok", expectation: "finite" },
		});

		expect(prepared).toEqual({
			kind: "approval",
			autoApprove: false,
			terminalInteraction: { agentRunId: "run-1", toolCallId: "terminal-1" },
		});
		expect(context.preflightSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "session-1",
				terminalSessionId: "terminal-1",
				action: { type: "submit", input: "echo ok" },
			}),
			true,
		);
		context.policy.recordDecision(prepared, false);
		expect(context.reject).toHaveBeenCalledWith("run-1", "terminal-1");
		expect(context.approve).not.toHaveBeenCalled();
	});

	it("blocks Terminal submit before Approval when Workspace Guard rejects it", async () => {
		const context = createPolicy({ terminalAllowed: false });

		await expect(
			context.policy.prepare({
				run,
				toolCallId: "terminal-blocked",
				toolName: "terminal_interaction",
				args: { action: "submit", input: "rm -rf /", expectation: "finite" },
			}),
		).resolves.toEqual({
			kind: "block",
			block: true,
			reason: "Command blocked by Workspace Guard",
			terminate: true,
		});
		expect(context.findById).toHaveBeenCalledOnce();
		expect(context.approve).not.toHaveBeenCalled();
		expect(context.reject).not.toHaveBeenCalled();
	});

	it("allows non-submit Terminal actions without creating an Approval", async () => {
		const context = createPolicy();

		await expect(
			context.policy.prepare({
				run,
				toolCallId: "terminal-key",
				toolName: "terminal_interaction",
				args: { action: "key", key: "CTRL_C", expectation: "interactive" },
			}),
		).resolves.toEqual({ kind: "allow" });
		expect(context.preflightSubmit).not.toHaveBeenCalled();
		expect(context.findById).not.toHaveBeenCalled();
	});
});
