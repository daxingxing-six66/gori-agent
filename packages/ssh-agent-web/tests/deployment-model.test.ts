import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentApi } from "../features/deploy/api/deployment-api";
import { isDeploymentDiscovery, isDeploymentRun } from "../features/deploy/model/deployment";
import { addDeploymentHistoryRun, applyDeploymentHistoryPage, emptyDeploymentHistory } from "../features/deploy/model/deployment-history";

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
		expect(isDeploymentDiscovery({ host: "example.org", profiles: [], errors: [], latest: run })).toBe(true);
		expect(isDeploymentDiscovery({ host: "example.org", profiles: [{ file: "x" }], errors: [], latest: run })).toBe(false);
		expect(isDeploymentDiscovery({ host: "example.org", profiles: [{ file: "x", project: "p", target: { host: "example.org", name: 123 }, modules: [] }], errors: [], latest: run })).toBe(false);
		expect(isDeploymentDiscovery({ host: "example.org", profiles: [], errors: [null], latest: run })).toBe(false);
	});

	it("requires exact Full Access approvals in deployment responses", () => {
		const approval = (stage: "restart" | "verify", command: string) => ({ id: `${stage}-1`, stage, command, status: "pending", requestedAt: 1 });
		const full = { ...run, plan: { ...run.plan, remoteAccess: { mode: "full_access", reason: "sandbox_unavailable" } },
			fullAccessApprovals: { restart: approval("restart", "systemctl restart app") } };
		expect(isDeploymentRun(full)).toBe(true);
		expect(isDeploymentRun({ ...full, fullAccessApprovals: { restart: approval("restart", "different command") } })).toBe(false);
		expect(isDeploymentRun({ ...full, fullAccessApprovals: undefined })).toBe(false);
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

	it("keeps the oldest loaded page cursor during SSE and first-page refresh", () => {
		if (!isDeploymentRun(run)) throw new Error("Invalid test fixture");
		const newest = { ...run, id: "newest", createdAt: 30, updatedAt: 30 };
		const middle = { ...run, id: "middle", createdAt: 20, updatedAt: 20 };
		const oldest = { ...run, id: "oldest", createdAt: 10, updatedAt: 10 };
		let history = applyDeploymentHistoryPage(emptyDeploymentHistory(), { runs: [newest], nextCursor: "page-2" });
		history = applyDeploymentHistoryPage(history, { runs: [middle], nextCursor: "page-3" }, "page-2");
		history = addDeploymentHistoryRun(history, { ...newest, updatedAt: 31, status: "running" });
		history = applyDeploymentHistoryPage(history, { runs: [newest], nextCursor: "page-2" });
		expect(history.nextCursor).toBe("page-3");
		expect(history.runs.find((item) => item.id === "newest")?.status).toBe("running");
		history = applyDeploymentHistoryPage(history, { runs: [oldest], nextCursor: null }, "page-3");
		expect(history.runs.map((item) => item.id)).toEqual(["newest", "middle", "oldest"]);
		expect(applyDeploymentHistoryPage(history, { runs: [newest], nextCursor: "page-2" }).nextCursor).toBeNull();
	});
});
