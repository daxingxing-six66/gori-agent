import { describe, expect, it, vi } from "vitest";
import { RemoteCommandExecutionPlan } from "../src/application/tools/remote-command-execution-plan.ts";
import { createRemoteServerCallTool, prepareRemoteCommandAuthorization, type RemoteServerCallParameters } from "../src/application/tools/remote-server-call-tool.ts";
import { withToolAvailability } from "../src/application/tools/tool-authorization.ts";
import type { CommandOperationResult } from "../src/application/services/command-operation-service.ts";
import type { ChatRun } from "../src/domain/chat.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";

const run: ChatRun = { id: "run", sessionId: "session", workspaceId: "workspace", requestId: "request",
	providerId: "provider", modelId: "model", thinkingLevel: "off", serverInteractionMode: "command",
	terminalSessionId: null, status: "running", createdAt: 1, updatedAt: 1 };
const target: SshTargetSnapshot = { workspaceId: "workspace", workspaceRevision: 1, hostname: "example.test", port: 22,
	hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: "SHA256:test", credentialId: "credential", credentialAuthVersion: 1,
	remoteUser: "test", defaultCwd: "/srv/app", connectTimeoutMs: 1000, keepaliveIntervalMs: 1000, keepaliveMaxCount: 3 };
const args: RemoteServerCallParameters = { command: "echo ok", cwd: "/srv/app", timeoutMs: 1000, write_paths: ["/srv/app/log"] };

function fixture() {
	const submit = vi.fn(async (): Promise<CommandOperationResult> => ({ operation: {
		id: "operation", sessionId: "session", workspaceId: "workspace", toolCallId: "tool", command: args.command,
		timeoutMs: 1000, status: "completed", queueDeadlineAt: 1000, createdAt: 1, outputBytes: 0, outputTruncated: false,
	}, outputTail: "ok" }));
	const tool = createRemoteServerCallTool({ sessionId: run.sessionId, agentRunId: run.id, operations: { submit } });
	const plan = new RemoteCommandExecutionPlan({ agentRunId: run.id, sessionId: run.sessionId, toolCallId: "tool",
		request: args, access: { mode: "workspace_write" }, expectedTarget: target });
	return { submit, tool, plan };
}

describe("remote command authorization handoff", () => {
	it("requires the plan for Chat calls and does not accept model-supplied permission context", async () => {
		const f = fixture();
		for (const context of [undefined, { ...f.plan }]) {
			await expect(f.tool.execute("tool", args, undefined, undefined, context)).rejects.toMatchObject({ terminate: false });
		}
		expect(f.submit).not.toHaveBeenCalled();
	});

	it.each([
		{ command: "changed" }, { cwd: "/etc" }, { timeoutMs: 2000 }, { sandbox_permissions: "full_access" as const },
		{ justification: "changed" }, { write_paths: ["/etc/config"] },
	])("rejects parameters changed after approval: %j", async (change) => {
		const f = fixture();
		await expect(f.tool.execute("tool", { ...args, ...change }, undefined, undefined, f.plan))
			.rejects.toMatchObject({ terminate: false, message: expect.stringContaining("does not match") });
		expect(f.submit).not.toHaveBeenCalled();
	});

	it.each([{ agentRunId: "other" }, { sessionId: "other" }, { toolCallId: "other" }])(
		"rejects a plan belonging to another call: %j", async (change) => {
			const f = fixture();
			const other = new RemoteCommandExecutionPlan({ ...f.plan, request: args, ...change });
			await expect(f.tool.execute("tool", args, undefined, undefined, other)).rejects.toMatchObject({ terminate: false });
			expect(f.submit).not.toHaveBeenCalled();
		},
	);

	it("forwards the approved plan through an availability wrapper and submits its selected mode and target", async () => {
		const f = fixture();
		const plan = new RemoteCommandExecutionPlan({ ...f.plan, request: args,
			access: { mode: "full_access", justification: "Declared destination is outside the sandbox" } });
		const wrapped = withToolAvailability(f.tool, () => {});
		await wrapped.execute("tool", args, undefined, undefined, plan);
		expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: run.id, command: args.command,
			cwd: args.cwd, timeoutMs: args.timeoutMs, sandboxPermissions: "full_access",
			justification: plan.access.mode === "full_access" ? plan.access.justification : undefined, expectedTarget: target }));
	});

	it("snapshots arguments before asynchronous checks and freezes the selected target", async () => {
		const mutableArgs = { ...args, write_paths: [...(args.write_paths ?? [])] };
		const mutableRun = { ...run };
		const mutableTarget = { ...target };
		const prepared = await prepareRemoteCommandAuthorization({ run: mutableRun, toolCallId: "tool", toolName: "remote_server_call", args: mutableArgs }, {
			preflightGuard: async () => {
				mutableArgs.command = "changed"; mutableArgs.write_paths.push("/etc/changed");
				mutableRun.id = "changed-run"; mutableRun.sessionId = "changed-session";
				return { allowed: true };
			},
			assessSandbox: async (session, paths) => {
				expect(session).toBe(run.sessionId);
				expect(paths).toEqual(args.write_paths);
				return { target: mutableTarget, route: { mode: "workspace_write", facts: {
					mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5, launcherVersion: "3", sandboxRoot: "/srv/app" } } };
			},
			autoApprove: async () => { mutableTarget.defaultCwd = "/etc"; return true; },
		});
		if (prepared.kind !== "approval" || !(prepared.executionContext instanceof RemoteCommandExecutionPlan))
			throw new Error("Missing execution plan");
		const plan = prepared.executionContext;
		expect(plan.agentRunId).toBe(run.id);
		expect(plan.sessionId).toBe(run.sessionId);
		expect(plan.request).toEqual(args);
		expect(plan.expectedTarget).toEqual(target);
		for (const value of [plan, plan.request, plan.request.write_paths, plan.access, plan.expectedTarget])
			expect(Object.isFrozen(value)).toBe(true);
		const f = fixture();
		await expect(f.tool.execute("tool", mutableArgs, undefined, undefined, plan)).rejects.toMatchObject({ terminate: false });
		expect(f.submit).not.toHaveBeenCalled();
	});
});
