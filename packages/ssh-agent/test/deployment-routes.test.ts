import { describe, expect, it, vi } from "vitest";
import { handleDeploymentRoute } from "../src/api/deployment-routes.ts";
import type { DeploymentService } from "../src/application/services/deployment-service.ts";

const segments = ["api", "sessions", "session-1", "deployments"];

describe("deployment HTTP route", () => {
	it("validates the prepare request before calling the runtime", async () => {
		const prepare = vi.fn();
		const service = { prepare } as unknown as DeploymentService;
		await expect(handleDeploymentRoute(service, new Request("http://local/api/sessions/session-1/deployments", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: "deploy-a.md", moduleId: "api", extra: true }),
		}), segments)).rejects.toMatchObject({ code: "deployment_request_invalid", status: 400 });
		expect(prepare).not.toHaveBeenCalled();
	});

	it("binds the session, profile file, and module to preparation", async () => {
		const prepare = vi.fn(async () => ({ id: "run-1" }));
		const service = { prepare } as unknown as DeploymentService;
		const response = await handleDeploymentRoute(service, new Request("http://local/api/sessions/session-1/deployments", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: "deploy-a.md", moduleId: "api" }),
		}), segments);
		expect(response?.status).toBe(201);
		expect(prepare).toHaveBeenCalledWith("session-1", "deploy-a.md", "api");
	});

	it("routes an exact deployment Full Access decision to the current Session", async () => {
		const decideFullAccess = vi.fn(() => ({ id: "run-1" }));
		const service = { decideFullAccess } as unknown as DeploymentService;
		const response = await handleDeploymentRoute(service, new Request("http://local/api/sessions/session-1/deployments/run-1/approvals/restart/approval-1/approve", { method: "POST" }),
			[...segments, "run-1", "approvals", "restart", "approval-1", "approve"]);
		expect(response?.status).toBe(200);
		expect(decideFullAccess).toHaveBeenCalledWith("session-1", "run-1", "restart", "approval-1", true);
	});

	it("routes recovery approval and rejection to the exact Session, run and proposal", async () => {
		const decideRecovery = vi.fn(async (_sessionId: string, _runId: string, _proposalId: string, approved: boolean) =>
			({ id: "run-1", decision: approved }));
		const service = { decideRecovery } as unknown as DeploymentService;
		for (const [action, approved] of [["approve", true], ["reject", false]] as const) {
			const response = await handleDeploymentRoute(service,
				new Request(`http://local/api/sessions/session-1/deployments/run-1/recovery/proposal-1/${action}`, { method: "POST" }),
				[...segments, "run-1", "recovery", "proposal-1", action]);
			expect(response?.status).toBe(200);
			expect(await response?.json()).toEqual({ id: "run-1", decision: approved });
			expect(decideRecovery).toHaveBeenLastCalledWith("session-1", "run-1", "proposal-1", approved);
		}
		expect(await handleDeploymentRoute(service,
			new Request("http://local/api/sessions/session-1/deployments/run-1/recovery/proposal-1/execute", { method: "POST" }),
			[...segments, "run-1", "recovery", "proposal-1", "execute"])).toBeNull();
	});

	it("returns bounded deployment history scoped to the Session", async () => {
		const listHistory = vi.fn(() => ({ runs: [{ id: "run-2", stages: { build: { status: "success", log: "built" } } }], hasMore: true, nextCursor: "next-page" }));
		const service = { listHistory } as unknown as DeploymentService;
		const response = await handleDeploymentRoute(service, new Request("http://local/api/sessions/session-1/deployments/history?limit=2&cursor=previous-page"), [...segments, "history"]);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({ runs: [{ id: "run-2", stages: { build: { status: "success", log: "built" } } }], hasMore: true, nextCursor: "next-page" });
		expect(listHistory).toHaveBeenCalledWith("session-1", 2, "previous-page");
		await expect(handleDeploymentRoute(service, new Request("http://local/api/sessions/session-1/deployments/history?limit=51"), [...segments, "history"])).rejects.toMatchObject({ code: "deployment_request_invalid" });
	});

	it("refuses the former REST confirmation path without starting a deployment", async () => {
		const service = {} as DeploymentService;
		await expect(handleDeploymentRoute(service, new Request("http://local/api/sessions/session-1/deployments/run-1/confirm", { method: "POST" }), [...segments, "run-1", "confirm"])).rejects.toMatchObject({ code: "deployment_agent_required", status: 409 });
	});
});
