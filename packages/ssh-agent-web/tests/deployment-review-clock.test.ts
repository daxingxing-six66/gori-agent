import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeploymentRun } from "../features/deploy/model/deployment";

const hooks = vi.hoisted(() => ({ invalidate: vi.fn(), effect: null as null | (() => void | (() => void)) }));
vi.mock("react", () => ({
	useState: () => [0, hooks.invalidate],
	useEffect: (effect: () => void | (() => void)) => { hooks.effect = effect; },
}));
import { useDeploymentReview } from "../features/deploy/runtime/use-deployment-review";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); hooks.invalidate.mockClear(); });

function recovering(): DeploymentRun {
	return {
		id: "deploy", sessionId: "session", workspaceId: "workspace", status: "recovering", createdAt: 1, updatedAt: 2,
		plan: {
			profilePath: "/project/deploy.md", profileHash: "hash", project: "API", module: { id: "api", name: "API" },
			target: { host: "test.invalid" }, targetBinding: { port: 22, hostKeyFingerprint: "SHA256:test", credentialId: "key", credentialAuthVersion: 1, remoteUser: "test" },
			remoteAccess: { mode: "full_access", reason: "deployment_policy" },
			build: { cwd: "/project", command: "build", artifact: "/project/app.jar" }, upload: { remotePath: "/srv/app.jar" }, restart: { command: "restart" },
		},
		stages: { prepare: { status: "success", log: "" }, build: { status: "failed", log: "compile error" }, upload: { status: "pending", log: "" }, restart: { status: "pending", log: "" }, verify: { status: "pending", log: "" } },
		fullAccessApprovals: { restart: { id: "approval", stage: "restart", command: "restart", status: "approved", requestedAt: 1, resolvedAt: 2, expiresAt: 3000 } },
	};
}

describe("deployment review expiry", () => {
	it("invalidates at permission expiry without polling the conversation", () => {
		vi.useFakeTimers(); vi.setSystemTime(1000);
		const run = recovering();
		expect(useDeploymentReview(run)).toBeNull();
		const cleanup = hooks.effect!();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(1999);
		expect(hooks.invalidate).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2);
		expect(hooks.invalidate).toHaveBeenCalledOnce();
		expect(useDeploymentReview(run)?.pendingExceptions).toEqual(["restart"]);
		if (cleanup) cleanup();
		hooks.effect!();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels the old expiry on unmount or Session replacement", () => {
		vi.useFakeTimers(); vi.setSystemTime(1000);
		useDeploymentReview(recovering());
		const cleanup = hooks.effect!();
		if (cleanup) cleanup();
		vi.advanceTimersByTime(5000);
		expect(hooks.invalidate).not.toHaveBeenCalled();
	});

	it("does not schedule timers for an absent or finished deployment", () => {
		vi.useFakeTimers();
		for (const run of [null, { ...recovering(), status: "cancelled" as const }]) {
			expect(useDeploymentReview(run)).toBeNull();
			expect(hooks.effect!()).toBeUndefined();
		}
		expect(vi.getTimerCount()).toBe(0);
	});
});
