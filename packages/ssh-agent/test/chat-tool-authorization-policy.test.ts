import { describe, expect, it, vi } from "vitest";
import { ChatToolAuthorizationPolicy } from "../src/application/services/chat-tool-authorization-policy.ts";
import type { TerminalInteractionService } from "../src/application/services/terminal-interaction-service.ts";
import type { ChatRun } from "../src/domain/chat.ts";
import type { Session } from "../src/domain/session.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";
import type { RemoteSandboxRoute } from "../src/application/services/remote-sandbox-routing.ts";
import { TerminalError } from "../src/domain/terminal.ts";

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

function createPolicy(options: { autoAudit?: boolean; sandboxEnabled?: boolean; remoteAllowed?: boolean; terminalAllowed?: boolean;
	remoteRoute?: RemoteSandboxRoute; deploymentStageMode?: "workspace_write" | "full_access"; deploymentSessionAuthorized?: boolean } = {}) {
	const session: Session = {
		id: "session-1",
		workspaceId: "workspace-1",
		displayName: "test",
		workDir: null,
		autoAudit: options.autoAudit ?? false,
		sandboxEnabled: options.sandboxEnabled ?? true,
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
	const assessRemoteSandbox = vi.fn(async () => ({ target: { defaultCwd: "/srv/app" } as SshTargetSnapshot,
		route: options.remoteRoute ?? { mode: "workspace_write" as const,
			facts: { mode: "workspace_write" as const, backend: "landlock" as const, enforcement: "full" as const,
				sandboxRoot: "/srv/app", abi: 5, launcherVersion: "3" } } }));
	const previewDeploymentRemoteStage = vi.fn(() => ({ command: "cd /srv/app && ./restart.sh",
		mode: options.deploymentStageMode ?? "workspace_write", sessionAuthorized: options.deploymentSessionAuthorized }));
	const resolveRemoteTarget = vi.fn(async () => ({ defaultCwd: "/srv/app" }) as SshTargetSnapshot);
	return {
		policy: new ChatToolAuthorizationPolicy({
			sessions: { findById },
			terminalInteractions,
			preflightRemoteGuard,
			assessRemoteSandbox,
			previewDeploymentRemoteStage,
			resolveRemoteTarget,
		}),
		findById,
		preflightSubmit,
		preflightRemoteGuard,
		assessRemoteSandbox,
		previewDeploymentRemoteStage,
		resolveRemoteTarget,
		approve,
		reject,
	};
}

describe("ChatToolAuthorizationPolicy", () => {
	it.each([true, false])("uses ordinary approval for unconfined deployment stages, autoAudit=%s", async (autoAudit) => {
		const context = createPolicy({ autoAudit, sandboxEnabled: false, deploymentStageMode: "full_access", deploymentSessionAuthorized: true });
		context.policy.bindDeploymentRun(run.id, "deployment");
		await expect(context.policy.prepare({ run, toolCallId: "restart", toolName: "deployment_execute_next", args: { stage: "restart" } }))
			.resolves.toMatchObject({ kind: "approval", autoApprove: autoAudit, descriptionMessage: { key: "approval.remote_session_unconfined" } });
	});
	it.each([false, true])("skips sandbox probes and exception approval when disabled, autoAudit=%s", async (autoAudit) => {
		const context = createPolicy({ sandboxEnabled: false, autoAudit });
		for (const sandbox_permissions of [undefined, "workspace_write", "full_access"]) {
			const prepared = await context.policy.prepare({ run: { ...run, serverInteractionMode: "command", terminalSessionId: null },
				toolCallId: "direct", toolName: "remote_server_call", args: { command: "pwd", sandbox_permissions, write_paths: ["/etc/app"] } });
			expect(prepared).toMatchObject({ kind: "approval", autoApprove: autoAudit,
				descriptionMessage: { key: "approval.remote_session_unconfined" },
				executionContext: { access: { mode: "full_access", authorizationSource: "session_setting" } } });
			expect(prepared).not.toHaveProperty("remoteFullAccess");
			expect(prepared).not.toHaveProperty("approvalToolName");
		}
		expect(context.assessRemoteSandbox).not.toHaveBeenCalled();
		expect(context.preflightRemoteGuard).toHaveBeenCalledTimes(3);
	});

	it("keeps Guard blocking unconfined commands before resolving or probing", async () => {
		const context = createPolicy({ sandboxEnabled: false, autoAudit: true, remoteAllowed: false });
		await expect(context.policy.prepare({ run, toolCallId: "blocked", toolName: "remote_server_call", args: { command: "rm -rf /" } }))
			.resolves.toMatchObject({ kind: "block", terminate: true });
		expect(context.assessRemoteSandbox).not.toHaveBeenCalled(); expect(context.resolveRemoteTarget).not.toHaveBeenCalled();
	});
	it("returns a recoverable error when the installation service is unavailable", async () => {
		const context = createPolicy();
		await expect(context.policy.prepare({ run, toolCallId: "install", toolName: "bubblewrap_install", args: {} }))
			.resolves.toMatchObject({ kind: "block", block: true, terminate: false });
		expect(context.preflightRemoteGuard).not.toHaveBeenCalled();
	});

	it.each([
		{ action: "submit", expectation: "finite" },
		{ action: "key", expectation: "finite" },
		{ action: "unknown", expectation: "finite" },
		{ action: "observe", expectation: "unknown" },
	])("returns malformed Terminal arguments to the model before creating an interaction: %j", async (args) => {
		const context = createPolicy();
		await expect(context.policy.prepare({ run, toolCallId: "invalid", toolName: "terminal_interaction", args }))
			.resolves.toMatchObject({ kind: "block", block: true, terminate: false });
		expect(context.preflightSubmit).not.toHaveBeenCalled();
		expect(context.findById).not.toHaveBeenCalled();
	});

	it.each([
		{ action: "submit", input: "pwd", key: "CTRL_C", expectation: "finite" },
		{ action: "key", input: "pwd", key: "CTRL_C", expectation: "finite" },
		{ action: "observe", input: "pwd", expectation: "finite" },
		{ action: "observe", key: "CTRL_C", expectation: "finite" },
		{ action: "observe", input: "pwd", key: "CTRL_C", expectation: "finite" },
	])("rejects contradictory Terminal arguments before preflight or authorization: %j", async (args) => {
		const context = createPolicy({ autoAudit: true });
		await expect(context.policy.prepare({ run, toolCallId: "conflicting", toolName: "terminal_interaction", args }))
			.resolves.toMatchObject({ kind: "block", block: true, terminate: false,
				reason: expect.stringContaining("Regenerate the tool call") });
		expect(context.preflightSubmit).not.toHaveBeenCalled();
		expect(context.findById).not.toHaveBeenCalled();
		expect(context.approve).not.toHaveBeenCalled();
		expect(context.reject).not.toHaveBeenCalled();
	});

	it("lets the model correct a missing Full Access reason while still requiring human approval", async () => {
		const context = createPolicy({ autoAudit: true });
		const commandRun = { ...run, serverInteractionMode: "command" as const, terminalSessionId: null };
		for (const justification of [undefined, "", "   "]) {
			await expect(context.policy.prepare({ run: commandRun, toolCallId: "missing-reason",
				toolName: "remote_server_call", args: { command: "pwd", sandbox_permissions: "full_access", justification } }))
				.resolves.toEqual({ kind: "block", block: true, terminate: false,
					reason: "full_access requires a non-empty justification" });
		}
		expect(context.resolveRemoteTarget).not.toHaveBeenCalled();
		await expect(context.policy.prepare({ run: commandRun, toolCallId: "corrected-reason",
			toolName: "remote_server_call", args: { command: "pwd", sandbox_permissions: "full_access", justification: "Inspect unconfined state" } }))
			.resolves.toMatchObject({ kind: "approval", autoApprove: false, approvalToolName: "remote_sandbox_exception" });
	});

	it.each(["terminal_input_invalid", "terminal_input_too_large"])(
		"returns %s from Terminal preflight as a recoverable tool error",
		async (code) => {
			const context = createPolicy();
			context.preflightSubmit.mockRejectedValue(new TerminalError(code, "Revise the terminal input"));
			await expect(context.policy.prepare({ run, toolCallId: "invalid-input", toolName: "terminal_interaction",
				args: { action: "submit", input: "input", expectation: "finite" } }))
				.resolves.toEqual({ kind: "block", block: true, reason: "Revise the terminal input", terminate: false });
			expect(context.approve).not.toHaveBeenCalled();
			expect(context.reject).not.toHaveBeenCalled();
		},
	);

	it("reads the current Session setting when an SFTP overwrite needs authorization", async () => {
		const context = createPolicy({ autoAudit: true });
		await expect(context.policy.shouldAutoApproveSftpOverwrite(run.sessionId)).resolves.toBe(true);
		const session = await context.findById();
		session.autoAudit = false;
		await expect(context.policy.shouldAutoApproveSftpOverwrite(run.sessionId)).resolves.toBe(false);
		expect(context.findById).toHaveBeenCalledWith(run.sessionId);
	});

	it("allows read-only and deployment-bound tools without treating autoAudit as deployment consent", async () => {
		const context = createPolicy({ autoAudit: true });

		await expect(context.policy.prepare({ run, toolCallId: "read-1", toolName: "read", args: {} })).resolves.toEqual({
			kind: "allow",
		});
		await expect(
			context.policy.prepare({ run, toolCallId: "sftp-1", toolName: "sftp_upload", args: {} }),
		).resolves.toEqual({ kind: "defer_to_tool" });
		for (const toolName of ["deployment_inspect", "deployment_execute_next", "deployment_propose_plan"]) {
			await expect(context.policy.prepare({ run, toolCallId: toolName, toolName, args: {} })).resolves.toEqual({
				kind: "allow",
			});
		}
		expect(context.findById).not.toHaveBeenCalled();
	});

	it("uses autoAudit for ordinary tools in deployment planning and execution", async () => {
		for (const deploymentRunId of [undefined, "deploy-1"]) {
			for (const autoAudit of [false, true]) {
				const context = createPolicy({ autoAudit });
				context.policy.bindDeploymentRun(run.id, deploymentRunId);
				for (const toolName of ["bash", "write"]) {
					await expect(context.policy.prepare({ run, toolCallId: toolName, toolName,
						args: toolName === "bash" ? { command: "git log -5" } : { path: "notes.txt", content: "ok" } }))
						.resolves.toEqual({ kind: "approval", autoApprove: autoAudit });
				}
				await expect(context.policy.prepare({
					run: { ...run, serverInteractionMode: "command", terminalSessionId: null },
					toolCallId: "remote-1", toolName: "remote_server_call", args: { command: "cat /etc/os-release" },
				})).resolves.toMatchObject({ kind: "approval", autoApprove: autoAudit,
					descriptionMessage: { key: "approval.remote_sandboxed_command" } });
				await expect(context.policy.prepare({
					run, toolCallId: "terminal-1", toolName: "terminal_interaction",
					args: { action: "submit", input: "pwd", expectation: "finite" },
				})).resolves.toMatchObject({ kind: "approval", autoApprove: autoAudit });
				expect(context.preflightSubmit).toHaveBeenCalledWith(expect.any(Object), !autoAudit);
				await expect(context.policy.prepare({
					run, toolCallId: "observe-1", toolName: "terminal_interaction",
					args: { action: "observe", expectation: "finite" },
				})).resolves.toEqual({ kind: "allow" });
				context.policy.clearRun(run.id);
				await expect(context.policy.prepare({ run, toolCallId: "bash-after-run", toolName: "bash", args: {} }))
					.resolves.toEqual({ kind: "approval", autoApprove: autoAudit });
			}
		}
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

	it("rejects a justification without full_access in automatic approval mode and lets the model correct its arguments", async () => {
		const context = createPolicy({ autoAudit: true });
		const commandRun = { ...run, serverInteractionMode: "command" as const, terminalSessionId: null };
		const args = { command: "cat /etc/os-release", justification: "User approved this one unconfined check" };

		await expect(context.policy.prepare({
			run: commandRun, toolCallId: "remote-missing-mode", toolName: "remote_server_call", args,
		})).resolves.toMatchObject({
			kind: "block", block: true, terminate: false,
			reason: expect.stringContaining("sandbox_permissions"),
		});
		expect(context.preflightRemoteGuard).toHaveBeenCalledWith(run.sessionId, args.command);
		expect(context.findById).toHaveBeenCalledWith(run.sessionId);

		await expect(context.policy.prepare({
			run: commandRun, toolCallId: "remote-full-access", toolName: "remote_server_call",
			args: { ...args, sandbox_permissions: "full_access" },
		})).resolves.toMatchObject({
			kind: "approval", autoApprove: false,
			approvalToolName: "remote_sandbox_exception",
			remoteFullAccess: { command: args.command, justification: args.justification },
			remoteFullAccessTarget: { defaultCwd: "/srv/app" },
		});
		expect(context.resolveRemoteTarget).toHaveBeenCalledWith("session-1");
	});

	it("keeps an ordinary manually approved remote call in the sandbox", async () => {
		const context = createPolicy({ autoAudit: false });
		const commandRun = { ...run, serverInteractionMode: "command" as const, terminalSessionId: null };
		await expect(context.policy.prepare({
			run: commandRun, toolCallId: "manual-remote", toolName: "remote_server_call",
			args: { command: "cat /etc/os-release", sandbox_permissions: "workspace_write" },
		})).resolves.toMatchObject({
			kind: "approval", autoApprove: false,
			descriptionMessage: { key: "approval.remote_sandboxed_command" },
		});
		expect(await context.policy.prepare({ run: commandRun, toolCallId: "manual-remote-2",
			toolName: "remote_server_call", args: { command: "pwd" } })).not.toHaveProperty("remoteFullAccess");
		expect(context.assessRemoteSandbox).toHaveBeenCalledWith("session-1", [], expect.any(AbortSignal));
	});

	it("marks unavailable sandbox commands as a human-only one-call exception even with automatic approval", async () => {
		const context = createPolicy({ autoAudit: true, remoteRoute: { mode: "full_access",
			reason: "sandbox_unavailable", details: "Landlock unavailable and Bubblewrap missing" } });
		const commandRun = { ...run, serverInteractionMode: "command" as const, terminalSessionId: null };
		await expect(context.policy.prepare({ run: commandRun, toolCallId: "exception-1", toolName: "remote_server_call",
			args: { command: "pwd" } })).resolves.toMatchObject({
			kind: "approval", autoApprove: false, approvalToolName: "remote_sandbox_exception",
			remoteFullAccess: { command: "pwd", justification: "Landlock unavailable and Bubblewrap missing" },
			descriptionMessage: { key: "approval.remote_sandbox_exception",
				values: { reason: "Landlock unavailable and Bubblewrap missing" } },
		});
	});

	it("uses autoAudit for sandboxed deployment remote stages without changing their mode", async () => {
		const commandRun = { ...run, serverInteractionMode: "command" as const, terminalSessionId: null };
		for (const autoAudit of [false, true]) {
			const context = createPolicy({ autoAudit });
			context.policy.bindDeploymentRun(run.id, "deploy-1");
			await expect(context.policy.prepare({ run: commandRun, toolCallId: "restart", toolName: "deployment_execute_next",
				args: { stage: "restart" } })).resolves.toEqual({ kind: "approval", autoApprove: autoAudit,
				descriptionMessage: { key: "approval.deployment_sandboxed_command",
					values: { stage: "restart", command: "cd /srv/app && ./restart.sh" } } });
			expect(context.previewDeploymentRemoteStage).toHaveBeenCalledWith("session-1", "deploy-1", "restart");
		}
		const exception = createPolicy({ autoAudit: true, deploymentStageMode: "full_access" });
		exception.policy.bindDeploymentRun(run.id, "deploy-1");
		await expect(exception.policy.prepare({ run: commandRun, toolCallId: "restart", toolName: "deployment_execute_next",
			args: { stage: "restart" } })).resolves.toEqual({ kind: "allow" });
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
			onDecision: expect.any(Function),
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
		context.policy.recordDecision(prepared, true);
		expect(context.approve).toHaveBeenCalledWith("run-1", "terminal-1");
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
