import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentApi } from "../features/deploy/api/deployment-api";
import { isDeploymentDiscussion, isDeploymentDiscovery, isDeploymentRun } from "../features/deploy/model/deployment";
import { mergeDeploymentHistory } from "../features/deploy/model/deployment-history";

afterEach(() => vi.unstubAllGlobals());

const run = {
	id: "run-1", sessionId: "session-1", workspaceId: "workspace-1", createdAt: 1, updatedAt: 1, status: "preparing",
	plan: {
		profilePath: "/tmp/project/.gori/deploy-example.org.md", profileHash: "hash", project: "test", remoteAccess: { mode: "workspace_write" }, target: { host: "example.org" }, module: { id: "api", name: "API" },
		targetBinding: { port: 22, remoteUser: "test", hostKeyFingerprint: "SHA256:test", credentialId: "credential-1", credentialAuthVersion: 1, writableRoot: "/srv/app" },
		build: { cwd: "/tmp/project", command: "npm run build", artifact: "/tmp/project/app.tar.gz" },
		upload: { remotePath: "/srv/app/app.tar.gz" }, restart: { command: "systemctl restart app" },
	},
	stages: Object.fromEntries(["prepare", "build", "upload", "restart", "verify"].map((name) => [name, { status: "pending", log: "" }])),
};

describe("deployment HTTP boundary", () => {
	it("accepts complete state and rejects malformed nested plan and stages", () => {
		expect(isDeploymentRun(run)).toBe(true);
		expect(isDeploymentRun({ ...run, plan: { ...run.plan, build: null } })).toBe(false);
		expect(isDeploymentRun({ ...run, plan: { ...run.plan, verify: null } })).toBe(false);
		expect(isDeploymentRun({ ...run, updatedAt: null })).toBe(false);
		expect(isDeploymentRun({ ...run, createdAt: null })).toBe(false);
		expect(isDeploymentRun({ ...run, stages: { ...run.stages, upload: { status: "running" } } })).toBe(false);
		expect(isDeploymentRun({ ...run, status: "failed", stages: { ...run.stages, restart: {
			status: "failed", log: "denied", exitCode: 1, failureCode: "sandbox_denied", safeDetails: { denialSuspected: true },
		} } })).toBe(true);
		expect(isDeploymentRun({ ...run, status: "failed", stages: { ...run.stages, restart: {
			status: "failed", log: "denied", safeDetails: { nested: { unsafe: true } },
		} } })).toBe(false);
		expect(isDeploymentRun({ ...run, plan: { ...run.plan, target: { host: "example.org", name: 123 } } })).toBe(false);
		expect(isDeploymentRun({ ...run, plan: { ...run.plan, targetBinding: { ...run.plan.targetBinding, workspaceRevision: "bad" } } })).toBe(false);
		expect(isDeploymentRun({ ...run, stages: { ...run.stages, upload: { status: "running", log: "", progress: { current: "5", total: 10 } } } })).toBe(false);
		expect(isDeploymentRun({ ...run, createdAt: 1, updatedAt: 3, startedAt: 2, agentRunId: "chat-run", status: "running" })).toBe(true);
		expect(isDeploymentRun({ ...run, createdAt: 1, updatedAt: 2, startedAt: 3, agentRunId: "chat-run", status: "running" })).toBe(false);
		expect(isDeploymentRun({ ...run, agentRunId: "chat-run", status: "running" })).toBe(false);
		expect(isDeploymentRun({ ...run, startedAt: 2, updatedAt: 2, status: "running" })).toBe(false);
		expect(isDeploymentRun({ ...run, createdAt: 1, updatedAt: 3, startedAt: 2, finishedAt: 3, agentRunId: "chat-run", status: "running" })).toBe(false);
		expect(isDeploymentRun({ ...run, createdAt: 1, updatedAt: 3, startedAt: 2, agentRunId: "chat-run", status: "failed" })).toBe(false);
		expect(isDeploymentDiscovery({ host: "example.org", profiles: [], errors: [], latest: run, activeDiscussion: null })).toBe(true);
		expect(isDeploymentDiscovery({ host: "example.org", profiles: [], errors: [], latest: run })).toBe(false);
		expect(isDeploymentDiscovery({ host: "example.org", profiles: [{ file: "x" }], errors: [], latest: run })).toBe(false);
		expect(isDeploymentDiscovery({ host: "example.org", profiles: [{ file: "x", project: "p", target: { host: "example.org", name: 123 }, modules: [] }], errors: [], latest: run })).toBe(false);
		expect(isDeploymentDiscovery({ host: "example.org", profiles: [], errors: [null], latest: run })).toBe(false);
	});

	it("validates persisted deployment discussion snapshots before projecting them", async () => {
		const discussion = {
			id: "discussion-1", sessionId: "session-1", workspaceId: "workspace-1", status: "discussing", revision: 1,
			profileFile: "deploy-example.org.md", profileHash: "a".repeat(64), projectRoot: "/tmp/project", project: "test",
			module: { id: "api", name: "API" },
			targetBinding: { hostname: "example.org", port: 22, workspaceRevision: 1, hostKeyAlgorithm: "ssh-ed25519",
				hostKeyFingerprint: "SHA256:test", credentialId: "credential-1", credentialAuthVersion: 1,
				remoteUser: "test", writableRoot: "/srv/app" },
			createdAt: 1, updatedAt: 1,
		};
		expect(isDeploymentDiscussion(discussion)).toBe(true);
		expect(isDeploymentDiscussion({ ...discussion, revision: "1" })).toBe(false);
		expect(isDeploymentDiscussion({ ...discussion, unexpected: true })).toBe(false);
		expect(isDeploymentDiscussion({ ...discussion, profileHash: "hash" })).toBe(false);
		expect(isDeploymentDiscussion({ ...discussion, profileFile: "../deploy-other.md" })).toBe(false);
		expect(isDeploymentDiscussion({ ...discussion, projectRoot: "../project" })).toBe(false);
		expect(isDeploymentDiscussion({ ...discussion, targetBinding: { ...discussion.targetBinding, port: "22" } })).toBe(false);
		expect(isDeploymentDiscussion({ ...discussion, targetBinding: { ...discussion.targetBinding, writableRoot: "/srv/../other" } })).toBe(false);
		expect(isDeploymentDiscussion({ ...discussion, status: "proposed" })).toBe(false);
		expect(isDeploymentDiscussion({ ...discussion, status: "proposed", deploymentRunId: "run-1" })).toBe(true);
		expect(isDeploymentDiscovery({ host: "example.org", profiles: [], errors: [], latest: null, activeDiscussion: discussion })).toBe(true);
		expect(isDeploymentDiscovery({ host: "example.org", profiles: [], errors: [], latest: null, activeDiscussion: { ...discussion, status: "cancelled" } })).toBe(false);
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(Response.json(discussion))
			.mockResolvedValueOnce(Response.json({ ...discussion, sessionId: "another-session" }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(deploymentApi.beginDiscussion("session-1", discussion.profileFile, discussion.module.id)).resolves.toMatchObject({ id: discussion.id });
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions/session-1/deployments/discussions");
		await expect(deploymentApi.cancelDiscussion("session-1", discussion.id)).rejects.toThrow("Invalid deployment discussion response");
	});

	it("requires exact Full Access approvals in deployment responses", () => {
		const approval = (stage: "restart" | "verify", command: string) => ({ id: `${stage}-1`, stage, command, status: "pending", requestedAt: 1 });
		const full = { ...run, plan: { ...run.plan, remoteAccess: { mode: "full_access", reason: "sandbox_unavailable" } },
			fullAccessApprovals: { restart: approval("restart", "systemctl restart app") } };
		expect(isDeploymentRun(full)).toBe(true);
		expect(isDeploymentRun({ ...full, plan: { ...full.plan, remoteAccess: { mode: "full_access", reason: "deployment_policy" } } })).toBe(true);
		expect(isDeploymentRun({ ...full, plan: { ...full.plan, remoteAccess: { mode: "full_access", reason: "unknown" } } })).toBe(false);
		expect(isDeploymentRun({ ...full, fullAccessApprovals: { restart: approval("restart", "different command") } })).toBe(false);
		expect(isDeploymentRun({ ...full, fullAccessApprovals: undefined })).toBe(false);
	});

	it("accepts per-stage sandbox exceptions and rejects missing or extra approvals", () => {
		const { build: _build, upload: _upload, ...common } = run.plan;
		const restart = { command: "install app.conf /etc/app.conf", writePaths: ["/etc/app.conf"],
			access: { mode: "full_access", reason: "sandbox_scope_exceeded" } };
		const verify = { command: "test -f /srv/app/app.tar.gz", writePaths: ["/srv/app/app.tar.gz"],
			access: { mode: "workspace_write" } };
		const approval = (stage: "restart" | "verify", command: string) => ({
			id: `${stage}-1`, stage, command, status: "pending", requestedAt: 1,
			toolName: "remote_sandbox_exception", reason: "sandbox_scope_exceeded",
		});
		const plan = { ...common, version: 2, remoteAccess: restart.access, restart, verify,
			buildSteps: [{ cwd: "/tmp/project", command: "npm run build" }],
			artifacts: [{ source: "/tmp/project/app.tar.gz", remotePath: "/srv/app/app.tar.gz" }] };
		const mixed = { ...run, plan, fullAccessApprovals: { restart: approval("restart", restart.command) } };
		expect(isDeploymentRun(mixed)).toBe(true);
		expect(isDeploymentRun({ ...mixed, fullAccessApprovals: undefined })).toBe(false);
		expect(isDeploymentRun({ ...mixed, fullAccessApprovals: { ...mixed.fullAccessApprovals,
			verify: approval("verify", verify.command) } })).toBe(false);
		expect(isDeploymentRun({ ...mixed, fullAccessApprovals: { restart: {
			...mixed.fullAccessApprovals.restart, reason: "sandbox_unavailable" } } })).toBe(false);
		expect(isDeploymentRun({ ...mixed, plan: { ...plan, remoteAccess: { mode: "workspace_write" } } })).toBe(false);
		expect(isDeploymentRun({ ...mixed, plan: { ...plan, restart: { ...restart, writePaths: ["/etc/../app.conf"] } } })).toBe(false);

		const fullVerify = { ...verify, access: restart.access };
		const both = { ...mixed, plan: { ...plan, verify: fullVerify }, fullAccessApprovals: {
			restart: approval("restart", restart.command), verify: approval("verify", verify.command),
		} };
		expect(isDeploymentRun(both)).toBe(true);
		expect(isDeploymentRun({ ...both, fullAccessApprovals: { restart: both.fullAccessApprovals.restart } })).toBe(false);
	});

	it("accepts v2 multi-artifact plans and rejects malformed generated inputs", () => {
		const { build: _oldBuild, upload: _oldUpload, ...common } = run.plan;
		const planned = {
			...run,
			planningAgentRunId: "planning-run-1",
			planningProposalHash: "a".repeat(64),
			plan: {
				...common,
				version: 2,
				buildSteps: [{ cwd: "/tmp/project", command: "mvn package -pl api" }],
				artifacts: [
					{ source: "/tmp/project/common.jar", remotePath: "/srv/app/lib/common.jar" },
					{ source: "/tmp/project/api.jar", remotePath: "/srv/app/api.jar" },
				],
			},
		};
		expect(isDeploymentRun(planned)).toBe(true);
		expect(isDeploymentRun({ ...planned, plan: { ...planned.plan, artifacts: [] } })).toBe(false);
		expect(isDeploymentRun({ ...planned, plan: { ...planned.plan, buildSteps: Array.from({ length: 9 }, () => planned.plan.buildSteps[0]) } })).toBe(false);
		expect(isDeploymentRun({ ...planned, plan: { ...planned.plan, artifacts: [planned.plan.artifacts[0], planned.plan.artifacts[0]] } })).toBe(false);
		expect(isDeploymentRun({ ...planned, plan: { ...planned.plan, artifacts: [{ source: "../outside.jar", remotePath: "/srv/app/out.jar" }] } })).toBe(false);
		expect(isDeploymentRun({ ...planned, plan: { ...planned.plan, artifacts: [{ source: "/tmp/project/app.jar", remotePath: "/srv/app/../secret.jar" }] } })).toBe(false);
		expect(isDeploymentRun({ ...planned, plan: { ...planned.plan, build: run.plan.build } })).toBe(false);
		expect(isDeploymentRun({ ...planned, planningProposalHash: "short" })).toBe(false);
		expect(isDeploymentRun({ ...run, planningAgentRunId: "planning-run-1" })).toBe(false);
		const repair = { id: "repair-1", stage: "build", reason: "Change the build goal", baseRevision: 1,
			status: "pending", agentRunId: "agent-1", proposedAt: 4,
			plan: { ...planned.plan, buildSteps: [{ cwd: "/tmp/project", command: "mvn package -pl api -am" }] } };
		const recovering = { ...planned, status: "recovering", agentRunId: "agent-1", agentRunHistory: ["agent-1"],
			createdAt: 1, startedAt: 2, updatedAt: 5, planRevision: 1, initialPlan: planned.plan,
			stages: { ...planned.stages, build: { status: "failed", log: "compile error", error: "Build exited" } },
			stageAttempts: { build: [{ agentRunId: "agent-1", planRevision: 1, result: { status: "failed", log: "compile error" } }] },
			recoveries: [repair] };
		expect(isDeploymentRun(recovering)).toBe(true);
		expect(isDeploymentRun({ ...recovering, recoveries: [{ ...repair, baseRevision: 2 }] })).toBe(false);
		expect(isDeploymentRun({ ...recovering, recoveries: [{ ...repair, plan: { ...repair.plan, target: { host: "other.org" } } }] })).toBe(false);
		expect(isDeploymentRun({ ...recovering, recoveries: [{ ...repair, plan: { ...repair.plan, restart: { command: "systemctl restart other" } } }] })).toBe(false);
		expect(isDeploymentRun({ ...recovering, stageAttempts: { build: [{ agentRunId: "agent-1", planRevision: 1, result: { status: "running", log: "" } }] } })).toBe(false);
		expect(isDeploymentRun({ ...recovering, agentRunHistory: ["agent-1", "agent-1"] })).toBe(false);
		const sandboxedPlan = { ...planned.plan,
			restart: { ...planned.plan.restart, access: { mode: "workspace_write" } },
		};
		const scopeRepairPlan = { ...sandboxedPlan,
			remoteAccess: { mode: "full_access", reason: "sandbox_scope_exceeded" },
			restart: { ...sandboxedPlan.restart, access: { mode: "full_access", reason: "sandbox_scope_exceeded" } },
		};
		const scopeRecovery = { ...recovering, plan: sandboxedPlan, initialPlan: sandboxedPlan,
			recoveries: [{ ...repair, stage: "restart", plan: scopeRepairPlan }] };
		expect(isDeploymentRun(scopeRecovery)).toBe(true);
		expect(isDeploymentRun({ ...scopeRecovery, recoveries: [{ ...scopeRecovery.recoveries[0], stage: "build" }] })).toBe(false);
	});

	it("validates paged history and binds each snapshot to the requested Session", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(Response.json({ runs: [run], hasMore: true, nextCursor: "next-page" }))
			.mockResolvedValueOnce(Response.json({ runs: [{ ...run, sessionId: "another-session" }], hasMore: false, nextCursor: null }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(deploymentApi.history("session-1", "earlier-page")).resolves.toMatchObject({ nextCursor: "next-page", runs: [{ id: "run-1" }] });
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions/session-1/deployments/history?limit=50&cursor=earlier-page");
		await expect(deploymentApi.history("session-1")).rejects.toThrow("Invalid deployment history response");
	});

	it("keeps cached Run facts at their newest revision", () => {
		if (!isDeploymentRun(run)) throw new Error("Invalid fixture");
		const newer = { ...run, updatedAt: 31, status: "running" as const };
		expect(mergeDeploymentHistory([newer], [run])).toEqual([newer]);
	});
});
