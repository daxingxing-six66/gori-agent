import { validSandboxFactRoots } from "../../domain/sandbox-writable-roots.ts";
import { GORI_MIN_LANDLOCK_ABI } from "../../domain/remote-sandbox.ts";
import type { TerminalSandboxFacts, TerminalSandboxMode } from "../../domain/terminal.ts";

/** Old formats are readable audit facts, never permission to open a new Terminal. */
export function readStoredTerminalSandbox(row: Record<string, unknown>): {
	requestedSandboxMode: TerminalSandboxMode | null;
	sandbox: TerminalSandboxFacts | null;
} {
	const requestedSandboxMode = readMode(row.requested_sandbox_mode);
	const sandbox = readFacts(row.sandbox_json);
	if (sandbox !== null && requestedSandboxMode !== sandbox.mode && !isHistoricalFallback(requestedSandboxMode, sandbox))
		throw new Error("Invalid persisted Terminal sandbox mode");
	if (row.status === "opening" && sandbox !== null) throw new Error("Opening Terminal cannot claim an active sandbox");
	if (row.status === "active" && requestedSandboxMode !== null && sandbox === null)
		throw new Error("Active Terminal sandbox facts are missing");
	return { requestedSandboxMode, sandbox };
}

function readMode(value: unknown): TerminalSandboxMode | null {
	if (value === null || value === "workspace_write" || value === "full_access") return value;
	throw new Error("Invalid persisted Terminal sandbox mode");
}

function readFacts(value: unknown): TerminalSandboxFacts | null {
	if (value === null) return null;
	if (typeof value !== "string") throw invalidFacts();
	let parsed: unknown;
	try { parsed = JSON.parse(value); }
	catch (error) { throw new Error("Invalid persisted Terminal sandbox JSON", { cause: error }); }
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidFacts();
	const fact = parsed as Record<string, unknown>;
	if (fact.mode === "full_access") return readFullAccess(fact);
	if (fact.mode !== "workspace_write" || fact.enforcement !== "full" ||
		typeof fact.sandboxRoot !== "string" || !validSandboxFactRoots(fact)) throw invalidFacts();
	if (fact.backend === "landlock") return readLandlock(fact, fact.sandboxRoot);
	if (fact.backend === "bubblewrap") return readBubblewrap(fact, fact.sandboxRoot);
	throw invalidFacts();
}

function readLandlock(fact: Record<string, unknown>, sandboxRoot: string): TerminalSandboxFacts {
	if (typeof fact.abi !== "number" || !Number.isSafeInteger(fact.abi) || fact.abi < GORI_MIN_LANDLOCK_ABI ||
		typeof fact.launcherVersion !== "string" || !/^[1-9]\d*$/.test(fact.launcherVersion) || Object.keys(fact).length !== (fact.sandboxRoots === undefined ? 6 : 7)) throw invalidFacts();
	return { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: fact.abi,
		launcherVersion: fact.launcherVersion, sandboxRoot, ...(fact.sandboxRoots === undefined ? {} : { sandboxRoots: fact.sandboxRoots as string[] }) };
}

function readBubblewrap(fact: Record<string, unknown>, sandboxRoot: string): TerminalSandboxFacts {
	if (typeof fact.bubblewrapVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(fact.bubblewrapVersion) || Object.keys(fact).length !== (fact.sandboxRoots === undefined ? 5 : 6)) throw invalidFacts();
	return { mode: "workspace_write", backend: "bubblewrap", enforcement: "full", bubblewrapVersion: fact.bubblewrapVersion, sandboxRoot, ...(fact.sandboxRoots === undefined ? {} : { sandboxRoots: fact.sandboxRoots as string[] }) };
}

function readFullAccess(fact: Record<string, unknown>): TerminalSandboxFacts {
	if (fact.backend !== "none" || fact.enforcement !== "none") throw invalidFacts();
	if (fact.source === "session_setting" && positiveInteger(fact.configuredAt) && Object.keys(fact).length === 5)
		return { mode: "full_access", backend: "none", enforcement: "none", source: "session_setting", configuredAt: fact.configuredAt };
	if (positiveInteger(fact.approvedAt) && Object.keys(fact).length === 4)
		return { mode: "full_access", backend: "none", enforcement: "none", approvedAt: fact.approvedAt };
	if ((fact.source === "sandbox_unavailable" || fact.source === "landlock_unavailable") &&
		positiveInteger(fact.detectedAt) && Object.keys(fact).length === 5)
		return { mode: "full_access", backend: "none", enforcement: "none", source: fact.source, detectedAt: fact.detectedAt };
	throw invalidFacts();
}

function isHistoricalFallback(mode: TerminalSandboxMode | null, sandbox: TerminalSandboxFacts): boolean {
	return mode === "workspace_write" && sandbox.mode === "full_access" && "source" in sandbox && sandbox.source !== "session_setting";
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function invalidFacts(): Error { return new Error("Invalid persisted Terminal sandbox facts"); }
