import { describe, expect, it } from "vitest";
import type { DeploymentRun } from "../features/deploy/model/deployment";
import { newestDeploymentRun } from "../features/deploy/model/deployment-history";

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

describe("deployment task snapshot selection", () => {
 it("keeps SSE facts when an earlier REST request resolves after them", () => {
  const current = { ...oldRun, updatedAt: 4, status: "running" as const };
  expect(newestDeploymentRun(current, oldRun)).toBe(current);
  expect(newestDeploymentRun(oldRun, current)).toBe(current);
 });
 it("handles discussion-only and legacy history without inventing a Run", () => {
  expect(newestDeploymentRun(null, undefined)).toBeNull();
  expect(newestDeploymentRun(undefined, oldRun)).toBe(oldRun);
 });
});
