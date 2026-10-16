import { describe, expect, it } from "vitest";
import { validateDeploymentProposal, type DeploymentPlanProposal } from "../src/application/deployment-plan-proposal.ts";
import { validateRecoveryInput } from "../src/application/deployment-recovery-proposal.ts";
import { deploymentFileSystemError } from "../src/application/deployment-file-system-error.ts";
import { authorizationFailure } from "../src/application/tools/tool-authorization.ts";
import { normalizePublicError } from "../src/application/failure-policy.ts";
import { DeploymentError, type DeploymentPlanV2 } from "../src/domain/deployment.ts";

const proposal = (): DeploymentPlanProposal => ({ buildSteps: [{ workdir: ".", command: "mvn package" }],
	artifacts: [{ source: "target/api.jar", target: "/opt/service/lib/api.jar" }], restart: { command: "restart-api" } });
const plan: DeploymentPlanV2 = { version: 2, profilePath: "/project/.gori/deploy-test.md", profileHash: "hash", project: "test",
	target: { host: "fixture.invalid" }, remoteAccess: { mode: "workspace_write" },
	targetBinding: { port: 22, hostKeyFingerprint: "SHA256:test", credentialId: "credential", credentialAuthVersion: 1, remoteUser: "test", sandboxWritableRoots: ["/opt/service"] },
	module: { id: "api", name: "API" }, buildSteps: [{ cwd: "/project", command: "mvn package" }],
	artifacts: [{ source: "/project/target/api.jar", remotePath: "/opt/service/lib/api.jar" }], restart: { command: "restart-api" } };

describe("precise deployment input failures", () => {
	it.each([
		["buildSteps[0].workdir", (p: DeploymentPlanProposal) => { p.buildSteps[0]!.workdir = "/tmp/worktree"; }, "relative"],
		["artifacts[0].source", (p: DeploymentPlanProposal) => { p.artifacts[0]!.source = "../outside.jar"; }, "project"],
		["artifacts[0].target", (p: DeploymentPlanProposal) => { p.artifacts[0]!.target = "relative.jar"; }, "absolute"],
		["restart.command", (p: DeploymentPlanProposal) => { p.restart.command = " "; }, "empty"],
		["restart.writePaths[1]", (p: DeploymentPlanProposal) => { p.restart.writePaths = ["/opt/service", "/opt/../etc"]; }, "normalized"],
		["artifacts[1].target", (p: DeploymentPlanProposal) => { p.artifacts.push({ source: "another.jar", target: p.artifacts[0]!.target }); }, "duplicates artifacts[0].target"],
	] as const)("returns the exact field and correction for %s", (field, mutate, reason) => {
		const input = proposal(); mutate(input);
		expect(() => validateDeploymentProposal(input)).toThrow(expect.objectContaining({ code: "deployment_proposal_invalid", field, message: expect.stringContaining(reason) }));
	});

	it("reports unknown and missing fields separately without executing anything", () => {
		expect(() => validateDeploymentProposal({ ...proposal(), extra: true } as DeploymentPlanProposal))
			.toThrow(expect.objectContaining({ field: "extra", message: expect.stringContaining("unknown field") }));
		expect(() => validateDeploymentProposal({ ...proposal(), buildSteps: undefined } as unknown as DeploymentPlanProposal))
			.toThrow(expect.objectContaining({ field: "buildSteps", message: expect.stringContaining("array") }));
	});

	it("applies the same path rules to a recovery and explains disallowed changes", () => {
		expect(() => validateRecoveryInput({ stage: "build", reason: "repair", buildSteps: [{ workdir: "/tmp/tree", command: "mvn package" }] }, plan, "/project"))
			.toThrow(expect.objectContaining({ field: "buildSteps[0].workdir", message: expect.stringContaining("relative") }));
		expect(() => validateRecoveryInput({ stage: "upload", reason: "repair", artifacts: proposal().artifacts, command: "restart" }, plan, "/project"))
			.toThrow(expect.objectContaining({ code: "deployment_recovery_invalid", field: "command", message: expect.stringContaining("repairing upload") }));
	});

	it("preserves field, path and limits through tool authorization and HTTP normalization", () => {
		const error = new DeploymentError("deployment_upload_outside_profile", "artifacts[0].target: outside /opt/service", 409,
			{ field: "artifacts[0].target", details: { path: "/etc/api.jar", allowedDirectories: ["/opt/service"] } });
		const blocked = authorizationFailure(error);
		if (!blocked) throw new Error("Expected recoverable request failure");
		expect(blocked.terminate).toBe(false);
		expect(JSON.parse(blocked.reason)).toEqual(error.toJSON());
		expect(normalizePublicError(error)).toMatchObject({ field: error.field, details: error.details, message: { values: { reason: error.message } } });
	});

	it.each(["ENOENT", "EACCES", "ENOTDIR"])("retains filesystem reason %s and the exact path", (code) => {
		const error = Object.assign(new Error("underlying syscall"), { code });
		expect(() => deploymentFileSystemError(error, "deployment_workdir_unavailable", "buildSteps[1].workdir", "/project/missing"))
			.toThrow(expect.objectContaining({ field: "buildSteps[1].workdir", details: { path: "/project/missing", filesystemCode: code }, message: expect.stringContaining(`[${code}]`) }));
	});
	it("does not turn an unknown storage fault into a correctable input error", () => {
		const fault = Object.assign(new Error("I/O failure"), { code: "EIO" });
		expect(() => deploymentFileSystemError(fault, "deployment_workdir_unavailable", "buildSteps[0].workdir", "/project")).toThrow(fault);
	});
});
