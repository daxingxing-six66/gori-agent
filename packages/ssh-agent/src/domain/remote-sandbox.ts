import { posix } from "node:path";
import { SshAgentError, type SshFailureCode } from "./ssh-failure.ts";

/** ABI 3 adds TRUNCATE; ABI 5 also handles device IOCTL. Keep in sync with main.c. */
export const GORI_MIN_LANDLOCK_ABI = 5;
export const GORI_LANDLOCK_LAUNCHER_VERSION = "1";
export type RemoteSandboxMode = "workspace_write" | "full_access";

export interface RemoteSandboxPolicy {
	mode: RemoteSandboxMode;
	sandboxRoot?: string;
}

export interface RemoteSandboxFacts {
	mode: RemoteSandboxMode;
	backend: "landlock" | "none";
	enforcement: "full" | "partial" | "none";
	abi?: number;
	launcherVersion?: string;
	sandboxRoot?: string;
	/** A stderr hint, never proof of a kernel denial. */
	denialSuspected?: boolean;
	commandMayHaveRun?: boolean;
}

export type RemoteSandboxCapability =
	| { status: "full" | "partial"; backend: "landlock"; abi: number; launcherVersion: string }
	| { status: "unavailable"; reason: string };

export function validRemoteSandboxRoot(value: string): boolean {
	return value.startsWith("/") && !value.includes("\0") && !value.includes("\n") && value.length <= 4096 && posix.normalize(value) !== "/";
}

export function sandboxFailure(code: SshFailureCode, message: string): SshAgentError {
	return new SshAgentError({ code, category: "sandbox", phase: "sandbox_prepare", message, retryable: false,
		safeDetails: { commandMayHaveRun: false } });
}
