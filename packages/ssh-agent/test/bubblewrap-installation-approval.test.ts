import { testSshTarget } from "./test-ssh-target.ts";
import { describe, expect, it, vi } from "vitest";
import { BUBBLEWRAP_INSTALL_JUSTIFICATION, BUBBLEWRAP_INSTALL_TIMEOUT_MS, bubblewrapInstallCommand } from
	"../src/application/services/bubblewrap-installation-service.ts";
import { BubblewrapInstallationService } from "../src/application/services/bubblewrap-installation-service.ts";
import { ChatToolAuthorizationPolicy } from "../src/application/services/chat-tool-authorization-policy.ts";
import { RemoteSandboxApprovalStore } from "../src/application/services/remote-sandbox-approval-store.ts";
import type { TerminalInteractionService } from "../src/application/services/terminal-interaction-service.ts";
import type { ChatRun } from "../src/domain/chat.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";
import { sandboxFailure } from "../src/domain/remote-sandbox.ts";
import type { CommandOperationService } from "../src/application/services/command-operation-service.ts";
import type { RemoteCommandBroker } from "../src/application/ssh-channel-broker.ts";

const run = { id: "run-1", sessionId: "session-1", serverInteractionMode: "command" } as ChatRun;
const plan = { packageManager: "apt-get", useSudo: true, refreshIndex: true } as const;
const target = testSshTarget({ workspaceId: "workspace-1", workspaceRevision: 1, hostname: "one.example",
	port: 22, credentialId: "credential-1", credentialAuthVersion: 1, remoteUser: "operator",
	sandboxWritableRoots: ["/srv/app"] });
const terminalInteractions = {
	preflightSubmit: vi.fn(), approve: vi.fn(), reject: vi.fn(),
} as unknown as Pick<TerminalInteractionService, "preflightSubmit" | "approve" | "reject">;

describe("Bubblewrap installation approval", () => {
	it("permits installation only for the distinct missing backend verdict", async () => {
		const probe = vi.fn().mockRejectedValueOnce(sandboxFailure("sandbox_bubblewrap_not_installed", "missing"))
			.mockRejectedValueOnce(sandboxFailure("sandbox_unavailable", "installed but unusable"))
			.mockResolvedValueOnce({ mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5,
				launcherVersion: "3", sandboxRoot: "/srv/app" });
		const service = new BubblewrapInstallationService({
			targets: { resolve: async () => target },
			sandbox: { getCapabilities: probe, refreshCapabilities: probe },
			broker: { execute: vi.fn() } as RemoteCommandBroker,
			operations: {} as CommandOperationService,
		});
		const signal = new AbortController().signal;
		await expect(service.requireInstallation(run.sessionId, signal)).resolves.toEqual(target);
		await expect(service.requireInstallation(run.sessionId, signal))
			.rejects.toMatchObject({ failure: { code: "sandbox_unavailable" } });
		await expect(service.requireInstallation(run.sessionId, signal)).rejects.toThrow("already available");
	});

	it("does not ask approval to inspect but binds one human installation approval to one exact command", async () => {
		const approvals = new RemoteSandboxApprovalStore();
		const requireInstallation = vi.fn(async () => target);
		const guard = vi.fn(async () => ({ allowed: true }));
		const policy = new ChatToolAuthorizationPolicy({
			sessions: { findById: vi.fn(async () => ({ autoAudit: true })) } as never,
			terminalInteractions, sandboxApprovals: approvals,
			preflightRemoteGuard: guard, requireBubblewrapInstallation: requireInstallation,
		});
		expect(await policy.prepare({ run, toolCallId: "inspect", toolName: "bubblewrap_inspect", args: {} }))
			.toEqual({ kind: "allow" });
		const prepared = await policy.prepare({ run, toolCallId: "install", toolName: "bubblewrap_install", args: plan });
		const command = bubblewrapInstallCommand(plan);
		expect(command).toBe("set -e; sudo -n apt-get update; sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap");
		expect(prepared).toMatchObject({ kind: "approval", autoApprove: false,
			remoteFullAccess: { command, cwd: "/", timeoutMs: BUBBLEWRAP_INSTALL_TIMEOUT_MS,
				justification: BUBBLEWRAP_INSTALL_JUSTIFICATION },
			remoteFullAccessTarget: target,
			descriptionMessage: { key: "approval.bubblewrap_install", values: { command } } });
		expect(requireInstallation).toHaveBeenCalledOnce();
		expect(guard).toHaveBeenCalledWith("session-1", command);
		policy.recordDecision(prepared, true);
		const approved = { agentRunId: run.id, toolCallId: "install", sessionId: run.sessionId, command,
			cwd: "/", timeoutMs: BUBBLEWRAP_INSTALL_TIMEOUT_MS, justification: BUBBLEWRAP_INSTALL_JUSTIFICATION };
		expect(approvals.consume(approved, { ...target, hostname: "two.example" })).toBe(false);
		policy.recordDecision(prepared, true);
		expect(approvals.consume(approved, target)).toBe(true);
		expect(approvals.consume(approved, target)).toBe(false);
	});

	it("executes only the generated installation command and probes the sandbox again", async () => {
		const getCapabilities = vi.fn().mockRejectedValueOnce(sandboxFailure("sandbox_bubblewrap_not_installed", "missing"));
		const refreshCapabilities = vi.fn().mockResolvedValueOnce({ mode: "workspace_write", backend: "bubblewrap", enforcement: "full",
				bubblewrapVersion: "0.12.0", sandboxRoot: "/srv/app" });
		const submit = vi.fn(async () => ({ operation: { failure: undefined }, outputTail: "installed" }));
		const service = new BubblewrapInstallationService({ targets: { resolve: async () => target },
			sandbox: { getCapabilities, refreshCapabilities }, broker: { execute: vi.fn() } as RemoteCommandBroker,
			operations: { submit } as unknown as CommandOperationService });
		await expect(service.install({ sessionId: run.sessionId, agentRunId: run.id, toolCallId: "install",
			plan, signal: new AbortController().signal })).resolves.toContain("Active sandbox: bubblewrap");
		expect(submit).toHaveBeenCalledWith(expect.objectContaining({
			command: bubblewrapInstallCommand(plan), cwd: "/", sandboxPermissions: "full_access",
			expectedTarget: target, agentRunId: run.id, toolCallId: "install",
		}));
		expect(getCapabilities).toHaveBeenCalledOnce();
		expect(refreshCapabilities).toHaveBeenCalledOnce();
	});

	it("returns package output to the model after an installation failure", async () => {
		const probe = vi.fn().mockRejectedValue(sandboxFailure("sandbox_bubblewrap_not_installed", "missing"));
		const submit = vi.fn(async () => ({ operation: { failure: { message: "package manager failed" } },
			outputTail: "repository unavailable" }));
		const service = new BubblewrapInstallationService({ targets: { resolve: async () => target },
			sandbox: { getCapabilities: probe, refreshCapabilities: probe }, broker: { execute: vi.fn() } as RemoteCommandBroker,
			operations: { submit } as unknown as CommandOperationService });
		await expect(service.install({ sessionId: run.sessionId, agentRunId: run.id, toolCallId: "install",
			plan, signal: new AbortController().signal })).rejects.toThrow("repository unavailable");
		expect(probe).toHaveBeenCalledOnce();
	});

	it("never issues an installation grant after rejection or when the Guard blocks the package command", async () => {
		const approvals = new RemoteSandboxApprovalStore();
		const policy = new ChatToolAuthorizationPolicy({
			sessions: { findById: vi.fn() } as never, terminalInteractions, sandboxApprovals: approvals,
			preflightRemoteGuard: async () => ({ allowed: false, reason: "blocked" }),
			requireBubblewrapInstallation: async () => target,
		});
		const prepared = await policy.prepare({ run, toolCallId: "install", toolName: "bubblewrap_install", args: plan });
		expect(prepared).toMatchObject({ kind: "block", reason: "blocked" });
		policy.recordDecision(prepared, true);
		expect(approvals.consume({ agentRunId: run.id, toolCallId: "install", sessionId: run.sessionId,
			command: bubblewrapInstallCommand(plan), cwd: "/", timeoutMs: BUBBLEWRAP_INSTALL_TIMEOUT_MS,
			justification: BUBBLEWRAP_INSTALL_JUSTIFICATION })).toBe(false);
	});
});
