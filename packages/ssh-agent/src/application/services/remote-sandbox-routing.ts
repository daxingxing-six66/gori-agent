import { sandboxFactRoots, validSandboxFactRoots } from "../../domain/sandbox-writable-roots.ts";
import { posix } from "node:path";
import { sandboxFailure } from "../../domain/remote-sandbox.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import type { PreparedSandboxedExecution, RemoteSandboxCapabilityProvider } from "./remote-sandbox-provider.ts";

export type RemoteSandboxRoute =
	| { readonly mode: "workspace_write"; readonly facts: PreparedSandboxedExecution["sandbox"] }
	| { readonly mode: "full_access"; readonly reason: "sandbox_unavailable" | "write_path_outside_sandbox"; readonly details: string };

/**
 * Preflight for command workflows that can ask a human for a sandbox exception.
 * Declared paths must be known write destinations, not a guess based on cwd:
 * arbitrary shell scripts may write elsewhere and must first run confined.
 */
export async function evaluateRemoteSandboxRoute(input: {
	readonly sandbox?: Pick<RemoteSandboxCapabilityProvider, "getCapabilities">;
	readonly target: SshTargetSnapshot;
	readonly signal: AbortSignal;
	readonly declaredWritePaths?: readonly string[];
}): Promise<RemoteSandboxRoute> {
	input.signal.throwIfAborted();
	const declaredPaths = (input.declaredWritePaths ?? []).map((originalPath) => {
		if (!originalPath.startsWith("/") || originalPath.includes("\0") || originalPath.includes("\n") || originalPath.length > 4096) {
			throw sandboxFailure("invalid_request", "Declared remote write paths must be absolute Linux paths without NUL or newline");
		}
		return { originalPath, path: posix.normalize(originalPath) };
	});
	if (!input.sandbox) return {
		mode: "full_access", reason: "sandbox_unavailable", details: "No remote sandbox provider is configured",
	};

	let facts: PreparedSandboxedExecution["sandbox"];
	try {
		facts = await input.sandbox.getCapabilities(input.target, input.signal);
	} catch (error) {
		input.signal.throwIfAborted();
		if (!(error instanceof SshAgentError)) throw error;
		if (isUnavailableForRouting(error.failure.code)) return {
			mode: "full_access", reason: "sandbox_unavailable", details: error.failure.message,
		};
		if (error.failure.code === "sandbox_root_invalid" || error.failure.code === "sandbox_root_unavailable") return {
			mode: "full_access", reason: "sandbox_unavailable", details: error.failure.message,
		};
		// Broken probes, launcher uploads and uncertain remote state are not evidence
		// that the server lacks a usable sandbox. Keep those failures closed.
		throw error;
	}
	input.signal.throwIfAborted();
	if (facts.mode !== "workspace_write" || facts.enforcement !== "full" || facts.backend === "none") {
		throw sandboxFailure("sandbox_probe_failed", "Remote sandbox probe did not confirm full confinement");
	}
	const roots = sandboxFactRoots(facts);
	if (!validSandboxFactRoots(facts)) {
		throw sandboxFailure("sandbox_probe_failed", "Remote sandbox probe did not return a canonical writable root");
	}
	for (const { originalPath, path } of declaredPaths) {
		if (!roots.some((root) => isWithin(path, root)) && !isWithin(path, "/tmp") && path !== "/dev/null") return {
			mode: "full_access", reason: "write_path_outside_sandbox",
			details: `Declared write path ${originalPath} is outside the sandbox writable roots`,
		};
	}
	return { mode: "workspace_write", facts };
}

function isUnavailableForRouting(code: SshAgentError["failure"]["code"]): boolean {
	return code === "sandbox_unavailable" || code === "sandbox_partial_enforcement" ||
		code === "sandbox_bubblewrap_not_installed" || code === "sandbox_unsupported_platform" ||
		code === "sandbox_unsupported_architecture";
}

function isWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}
