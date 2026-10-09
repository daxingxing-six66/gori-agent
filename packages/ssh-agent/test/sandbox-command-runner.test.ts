import { describe, expect, it, vi } from "vitest";
import type { RemoteCommandBroker } from "../src/application/ssh-channel-broker.ts";
import { SshAgentError } from "../src/domain/ssh-failure.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";
import { SandboxCommandRunner } from "../src/infrastructure/sandbox/sandbox-command-runner.ts";

const input = { target: {} as SshTargetSnapshot, signal: new AbortController().signal,
	command: "test -c /dev/null", stage: "null device", code: "sandbox_prepare_failed" as const };

describe("sandbox preparation diagnostics", () => {
	it("retains stage, exit code and bounded stderr without interpreting remote text as instructions", async () => {
		const runner = new SandboxCommandRunner({ execute: async ({ onStderr }) => {
			await onStderr(Buffer.from("\x1b[31mstat: Permission denied\x1b[0m\n"));
			return { exitCode: 13 };
		} });
		await expect(runner.checked(input)).rejects.toMatchObject({ failure: {
			code: "sandbox_prepare_failed", message: expect.stringContaining('"null device" failed (exitCode=13): stat: Permission denied'),
			safeDetails: { sandboxStage: "null device", exitCode: 13, stderr: "stat: Permission denied", commandMayHaveRun: false },
		} });
	});

	it("preserves typed SSH failures and their cause instead of changing them into absent capability", async () => {
		const original = new SshAgentError({ code: "transport_lost", category: "connection", phase: "execute",
			message: "SSH channel closed", retryable: true });
		const runner = new SandboxCommandRunner({ execute: async () => { throw original; } });
		await expect(runner.checked(input)).rejects.toMatchObject({ cause: original, failure: {
			code: "transport_lost", category: "connection", retryable: true, safeDetails: { sandboxStage: "null device", commandMayHaveRun: false },
		} });
	});

	it("keeps a generic broker exception as a cause with a concrete preparation stage", async () => {
		const original = new Error("SFTP unavailable");
		const runner = new SandboxCommandRunner({ execute: async () => { throw original; } });
		await expect(runner.checked(input)).rejects.toMatchObject({ cause: original, failure: {
			code: "sandbox_prepare_failed", message: expect.stringContaining("SFTP unavailable"),
		} });
	});

	it("limits stdout, bounds stderr and decodes split Unicode chunks", async () => {
		const execute = vi.fn<RemoteCommandBroker["execute"]>(async ({ onStdout, onStderr }) => {
			for (const byte of Buffer.from("应用 \n")) await onStdout(Uint8Array.of(byte));
			await onStderr(Buffer.alloc(20_000, "x"));
			return { exitCode: 0 };
		});
		const runner = new SandboxCommandRunner({ execute });
		const result = await runner.capture(input);
		expect(result.stdout).toBe("应用 \n");
		expect(result.stderr).toHaveLength(4_096 + " [truncated]".length);
		execute.mockImplementationOnce(async ({ onStdout }) => { await onStdout(Buffer.alloc(16_385)); return { exitCode: 0 }; });
		await expect(runner.checked(input)).rejects.toMatchObject({ failure: { code: "sandbox_probe_failed",
			message: expect.stringContaining("stdout exceeded"), safeDetails: { sandboxStage: "null device" } } });
	});

	it("reports an exit signal and does not accept a missing exit status", async () => {
		const execute = vi.fn<RemoteCommandBroker["execute"]>().mockResolvedValueOnce({ exitSignal: "TERM" }).mockResolvedValueOnce({});
		const runner = new SandboxCommandRunner({ execute });
		await expect(runner.checked(input)).rejects.toMatchObject({ failure: { safeDetails: { exitSignal: "TERM" } } });
		await expect(runner.checked(input)).rejects.toThrow("exitCode=unknown");
	});

	it("propagates cancellation even when the broker returns an apparently successful result", async () => {
		const controller = new AbortController();
		const reason = new Error("cancel preparation");
		const runner = new SandboxCommandRunner({ execute: async () => { controller.abort(reason); return { exitCode: 0 }; } });
		await expect(runner.checked({ ...input, signal: controller.signal })).rejects.toBe(reason);
	});
});
