import { posix } from "node:path";
import { SshAgentError, type SshFailureCode } from "./ssh-failure.ts";

/** ABI 3 adds TRUNCATE; ABI 5 also handles device IOCTL. Keep in sync with main.c. */
export const GORI_MIN_LANDLOCK_ABI = 5;
export const GORI_LANDLOCK_LAUNCHER_VERSION = "3";
export type RemoteSandboxMode = "workspace_write" | "full_access";

export interface RemoteSandboxPolicy {
	mode: RemoteSandboxMode;
}

export interface RemoteSandboxFacts {
	mode: RemoteSandboxMode;
	backend: "landlock" | "bubblewrap" | "none";
	enforcement: "full" | "partial" | "none";
	abi?: number;
	launcherVersion?: string;
	/** Installed Bubblewrap version, when Bubblewrap was selected. */
	bubblewrapVersion?: string;
	sandboxRoot?: string;
	/** A stderr hint, never proof of a kernel denial. */
	denialSuspected?: boolean;
	commandMayHaveRun?: boolean;
}

/** Only an explicit lack of backend capability permits trying another backend. */
export function isSandboxBackendUnavailable(error: unknown): error is SshAgentError {
	if (!(error instanceof SshAgentError)) return false;
	return error.failure.code === "sandbox_unavailable" ||
		error.failure.code === "sandbox_partial_enforcement" ||
		error.failure.code === "sandbox_unsupported_platform" ||
		error.failure.code === "sandbox_unsupported_architecture";
}

/** Prefer a specific Terminal failure, such as missing Bubblewrap, over generic backend unavailability. */
export function isGenericTerminalSandboxFailure(error: unknown): boolean {
	return error instanceof SshAgentError &&
		(error.failure.code === "sandbox_unavailable" || error.failure.code === "sandbox_partial_enforcement");
}

export function validRemoteSandboxRoot(value: string): boolean {
	return value.startsWith("/") && !value.includes("\0") && !value.includes("\n") && value.length <= 4096 && posix.normalize(value) !== "/";
}

/** Stored and enforced roots must be the canonical result of remote realpath. */
export function canonicalRemoteSandboxRoot(value: string): boolean {
	return validRemoteSandboxRoot(value) && !value.endsWith("/") && posix.normalize(value) === value;
}

export function sandboxFailure(code: SshFailureCode, message: string): SshAgentError {
	return new SshAgentError({ code, category: "sandbox", phase: "sandbox_prepare", message, retryable: false,
		safeDetails: { commandMayHaveRun: false } });
}
