import { describe, expect, it, vi } from "vitest";
import type { RemoteSandboxProber } from "../src/application/services/remote-sandbox-provider.ts";
import { evaluateRemoteSandboxRoute } from "../src/application/services/remote-sandbox-routing.ts";
import { sandboxFailure } from "../src/domain/remote-sandbox.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";

const target = { defaultCwd: "/srv/app" } as SshTargetSnapshot;
const signal = new AbortController().signal;
const facts = { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5,
	launcherVersion: "3", sandboxRoot: "/srv/app" } as const;

function prober(probe: RemoteSandboxProber["probe"]): RemoteSandboxProber {
	return { probe: vi.fn(probe) };
}

describe("remote sandbox route preflight", () => {
	it("keeps known in-root, temporary and null-device writes sandboxed", async () => {
		const sandbox = prober(async () => facts);
		await expect(evaluateRemoteSandboxRoute({ sandbox, target, signal,
			declaredWritePaths: ["/srv/app/releases/api", "/tmp/staging", "/dev/null"] }))
			.resolves.toEqual({ mode: "workspace_write", facts });
		expect(sandbox.probe).toHaveBeenCalledWith(target, signal);
	});

	it("requires a marked exception for a known path outside the writable roots", async () => {
		const sandbox = prober(async () => facts);
		await expect(evaluateRemoteSandboxRoute({ sandbox, target, signal,
			declaredWritePaths: ["/srv/app/../other/output"] }))
			.resolves.toMatchObject({ mode: "full_access", reason: "write_path_outside_sandbox" });
	});

	it.each(["sandbox_unavailable", "sandbox_partial_enforcement", "sandbox_bubblewrap_not_installed",
		"sandbox_unsupported_platform", "sandbox_unsupported_architecture"] as const)(
		"requires a marked exception for %s", async (code) => {
			const sandbox = prober(async () => { throw sandboxFailure(code, "No available sandbox"); });
			await expect(evaluateRemoteSandboxRoute({ sandbox, target, signal }))
				.resolves.toEqual({ mode: "full_access", reason: "sandbox_unavailable", details: "No available sandbox" });
		},
	);

	it("requires a marked exception when no provider is configured", async () => {
		await expect(evaluateRemoteSandboxRoute({ target, signal }))
			.resolves.toMatchObject({ mode: "full_access", reason: "sandbox_unavailable" });
	});

	it("requires a marked exception when the configured sandbox root cannot be used", async () => {
		const sandbox = prober(async () => { throw sandboxFailure("sandbox_root_unavailable", "Root unavailable"); });
		await expect(evaluateRemoteSandboxRoute({ sandbox, target, signal }))
			.resolves.toEqual({ mode: "full_access", reason: "sandbox_unavailable", details: "Root unavailable" });
	});

	it("keeps probe and launcher faults closed instead of treating them as absent protection", async () => {
		const sandbox = prober(async () => { throw sandboxFailure("sandbox_probe_failed", "Probe failed"); });
		await expect(evaluateRemoteSandboxRoute({ sandbox, target, signal }))
			.rejects.toMatchObject({ failure: { code: "sandbox_probe_failed" } });
	});

	it("rejects malformed declared paths before choosing a route", async () => {
		const sandbox = prober(async () => facts);
		await expect(evaluateRemoteSandboxRoute({ sandbox, target, signal, declaredWritePaths: ["../etc"] }))
			.rejects.toMatchObject({ failure: { code: "invalid_request" } });
		expect(sandbox.probe).not.toHaveBeenCalled();
		await expect(evaluateRemoteSandboxRoute({ target, signal, declaredWritePaths: ["../etc"] }))
			.rejects.toMatchObject({ failure: { code: "invalid_request" } });
	});

	it("rejects a probe result without a canonical writable root", async () => {
		const sandbox = prober(async () => ({ ...facts, sandboxRoot: "/" }));
		await expect(evaluateRemoteSandboxRoute({ sandbox, target, signal }))
			.rejects.toMatchObject({ failure: { code: "sandbox_probe_failed" } });
	});

	it("rejects a probe result that does not confirm a protecting backend", async () => {
		const sandbox = prober(async () => ({ ...facts, backend: "none" }));
		await expect(evaluateRemoteSandboxRoute({ sandbox, target, signal }))
			.rejects.toMatchObject({ failure: { code: "sandbox_probe_failed" } });
	});
});
