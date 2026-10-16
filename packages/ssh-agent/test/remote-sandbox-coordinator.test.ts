import { testSshTarget } from "./test-ssh-target.ts";
import { describe, expect, it, vi } from "vitest";
import type { RemoteSandboxBackend } from "../src/application/services/remote-sandbox-provider.ts";
import { sandboxFailure } from "../src/domain/remote-sandbox.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";
import { RemoteSandboxCoordinator } from "../src/infrastructure/sandbox/remote-sandbox-coordinator.ts";
import { wrapRemoteCommand } from "../src/infrastructure/sandbox/shell-command.ts";

const target = testSshTarget({ sandboxWritableRoots: ["/srv/app"] });
const facts = { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5,
	launcherVersion: "3", sandboxRoot: "/srv/app" } as const;
const execution = { command: "confined command", sandbox: facts, confirmation: "confirmed\n" };
const terminal = { command: "confined terminal", sandbox: facts, confirmation: "confirmed" };

function backend(prepare: RemoteSandboxBackend["prepare"]): RemoteSandboxBackend {
	return { getCapabilities: vi.fn(async () => facts), refreshCapabilities: vi.fn(async () => facts), prepare: vi.fn(prepare), prepareTerminal: vi.fn(async () => terminal) };
}

describe("remote sandbox backend selection", () => {
	it("keeps ordinary queries and explicit refreshes on their respective backend entry points", async () => {
		const constrained = backend(async () => execution);
		const sandbox = new RemoteSandboxCoordinator([constrained]);
		const signal = new AbortController().signal;
		await sandbox.getCapabilities(target, signal);
		expect(constrained.getCapabilities).toHaveBeenCalledOnce();
		expect(constrained.refreshCapabilities).not.toHaveBeenCalled();
		await sandbox.refreshCapabilities(target, signal);
		expect(constrained.getCapabilities).toHaveBeenCalledOnce();
		expect(constrained.refreshCapabilities).toHaveBeenCalledOnce();
	});

	it("uses the next backend only after an explicit capability verdict", async () => {
		const first = backend(async () => { throw sandboxFailure("sandbox_partial_enforcement", "ABI too old"); });
		const second = backend(async () => execution);
		const sandbox = new RemoteSandboxCoordinator([first, second]);
		const result = await sandbox.prepare({ target, cwd: "/srv/app", command: "true", policy: { mode: "workspace_write" }, signal: new AbortController().signal });
		expect(result).toBe(execution);
		expect(first.prepare).toHaveBeenCalledOnce();
		expect(second.prepare).toHaveBeenCalledOnce();
	});

	it("stops on a preparation failure and never dispatches through another backend", async () => {
		const first = backend(async () => { throw sandboxFailure("sandbox_launcher_upload_failed", "Deployment failed"); });
		const second = backend(async () => execution);
		const sandbox = new RemoteSandboxCoordinator([first, second]);
		await expect(sandbox.prepare({ target, cwd: "/srv/app", command: "true", policy: { mode: "workspace_write" }, signal: new AbortController().signal }))
			.rejects.toMatchObject({ failure: { code: "sandbox_launcher_upload_failed" } });
		expect(second.prepare).not.toHaveBeenCalled();
	});

	it("keeps command mode confined when every backend is unavailable", async () => {
		const unavailable = backend(async () => { throw sandboxFailure("sandbox_unavailable", "No kernel support"); });
		const sandbox = new RemoteSandboxCoordinator([unavailable]);
		await expect(sandbox.prepare({ target, cwd: "/srv/app", command: "true", policy: { mode: "workspace_write" }, signal: new AbortController().signal }))
			.rejects.toMatchObject({ failure: { code: "sandbox_unavailable" } });
		expect(() => new RemoteSandboxCoordinator([])).toThrow("At least one remote sandbox backend must be configured");
	});

	it("reports a missing Bubblewrap installation only after Landlock is unavailable", async () => {
		const first = backend(async () => { throw sandboxFailure("sandbox_unavailable", "No Landlock"); });
		first.getCapabilities = vi.fn(async () => { throw sandboxFailure("sandbox_unavailable", "No Landlock"); });
		const second = backend(async () => { throw sandboxFailure("sandbox_bubblewrap_not_installed", "Missing Bubblewrap"); });
		second.getCapabilities = vi.fn(async () => { throw sandboxFailure("sandbox_bubblewrap_not_installed", "Missing Bubblewrap"); });
		const sandbox = new RemoteSandboxCoordinator([first, second]);
		await expect(sandbox.getCapabilities(target, new AbortController().signal))
			.rejects.toMatchObject({ failure: { code: "sandbox_bubblewrap_not_installed" } });
		await expect(sandbox.prepare({ target, cwd: "/srv/app", command: "true",
			policy: { mode: "workspace_write" }, signal: new AbortController().signal }))
			.rejects.toMatchObject({ failure: { code: "sandbox_bubblewrap_not_installed" } });
	});

	it("does not allow Terminal fallback if any attempted backend rejects the target platform or architecture", async () => {
		const first = backend(async () => execution);
		first.prepareTerminal = vi.fn(async () => { throw sandboxFailure("sandbox_unsupported_architecture", "Unsupported CPU"); });
		const second = backend(async () => execution);
		second.prepareTerminal = vi.fn(async () => { throw sandboxFailure("sandbox_unavailable", "Namespace unavailable"); });
		const sandbox = new RemoteSandboxCoordinator([first, second]);
		await expect(sandbox.prepareTerminal({ target, signal: new AbortController().signal }))
			.rejects.toMatchObject({ failure: { code: "sandbox_unsupported_architecture" } });
		expect(second.prepareTerminal).toHaveBeenCalledOnce();
	});

	it("routes explicitly authorized Full Access around constrained backends", async () => {
		const constrained = backend(async () => { throw new Error("should not run"); });
		const sandbox = new RemoteSandboxCoordinator([constrained]);
		const result = await sandbox.prepare({ target, cwd: "/srv/app", command: "echo okay", policy: { mode: "full_access" }, signal: new AbortController().signal });
		expect(result).toEqual({ command: wrapRemoteCommand("/srv/app", "echo okay"),
			sandbox: { mode: "full_access", backend: "none", enforcement: "none" } });
		expect(constrained.prepare).not.toHaveBeenCalled();
	});
});
