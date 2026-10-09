import { describe, expect, it } from "vitest";
import type { DeploymentRun } from "../features/deploy/model/deployment";
import { openFreshDeployment, refreshSelectedDeployment } from "../features/deploy/runtime/use-deployment";

const oldRun: DeploymentRun = {
	id: "old", sessionId: "session", workspaceId: "workspace", createdAt: 1, updatedAt: 1, status: "success",
	plan: {
		profilePath: "/project/.gori/deploy-example.md", profileHash: "hash", project: "example",
		remoteAccess: { mode: "workspace_write" }, target: { host: "example.org" },
		targetBinding: { port: 22, hostKeyFingerprint: "SHA256:test", credentialId: "credential", credentialAuthVersion: 1, remoteUser: "user", writableRoot: "/srv/app" },
		module: { id: "api", name: "API" }, build: { cwd: "/project", command: "build", artifact: "/project/app.tar.gz" },
		upload: { remotePath: "/srv/app/app.tar.gz" }, restart: { command: "restart" },
	},
	stages: {
		prepare: { status: "success", log: "" }, build: { status: "success", log: "" },
		upload: { status: "success", log: "" }, restart: { status: "success", log: "" },
		verify: { status: "skipped", log: "" },
	},
};

describe("deployment panel selection", () => {
	it("starts each explicit /deploy with no selected history run and a new panel revision", () => {
		const first = openFreshDeployment({ mode: "history", run: oldRun, freshOpenRevision: 0 });
		expect(first).toEqual({ mode: "current", run: null, freshOpenRevision: 1 });
		expect(refreshSelectedDeployment(first, oldRun, [oldRun])).toBe(first);

		const second = openFreshDeployment(first);
		expect(second).toEqual({ mode: "current", run: null, freshOpenRevision: 2 });
		expect(refreshSelectedDeployment(second, oldRun, [oldRun])).toBe(second);
	});

	it("still refreshes a history selection by matching run ID", () => {
		const selected = { mode: "history" as const, run: oldRun, freshOpenRevision: 1 };
		const updated = { ...oldRun, updatedAt: 2 };
		expect(refreshSelectedDeployment(selected, null, [updated]).run).toEqual(updated);
		expect(refreshSelectedDeployment(selected, { ...oldRun, id: "other", updatedAt: 3 }, []).run).toBe(oldRun);
		expect(refreshSelectedDeployment(selected, { ...oldRun, updatedAt: 3 }, [updated]).run?.updatedAt).toBe(3);
	});
});
