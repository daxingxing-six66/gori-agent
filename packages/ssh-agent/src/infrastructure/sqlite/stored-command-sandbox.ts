import { canonicalRemoteSandboxRoot, GORI_MIN_LANDLOCK_ABI, type RemoteSandboxFacts, type RemoteSandboxMode } from "../../domain/remote-sandbox.ts";

/** Decodes persisted execution evidence, including pre-backend and pre-confirmation records. */
export function readStoredCommandSandbox(json: string): RemoteSandboxFacts {
	const value: unknown = JSON.parse(json);
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidFacts();
	const facts = value as Record<string, unknown>;
	const { mode, enforcement, commandMayHaveRun, denialSuspected } = facts;
	if ((mode !== "workspace_write" && mode !== "full_access") ||
		(enforcement !== "full" && enforcement !== "none") || typeof commandMayHaveRun !== "boolean" ||
		(denialSuspected !== undefined && typeof denialSuspected !== "boolean")) throw invalidFacts();
	const state: ExecutionState = { mode, enforcement, commandMayHaveRun,
		...(denialSuspected === undefined ? {} : { denialSuspected }) };
	if (facts.backend === "none") return readWithoutBackend(facts, state);
	return readPreparedBackend(facts, state);
}

interface ExecutionState {
	mode: RemoteSandboxMode;
	enforcement: "full" | "none";
	commandMayHaveRun: boolean;
	denialSuspected?: boolean;
}

function readWithoutBackend(facts: Record<string, unknown>, state: ExecutionState): RemoteSandboxFacts {
	const { mode, enforcement, commandMayHaveRun, denialSuspected } = state;
	if (enforcement !== "none" || (mode === "workspace_write" && (commandMayHaveRun || denialSuspected !== undefined)) ||
		(mode === "full_access" && denialSuspected === true) ||
		!onlyKeys(facts, ["mode", "backend", "enforcement", "commandMayHaveRun", "denialSuspected"])) throw invalidFacts();
	return { ...state, backend: "none" };
}

function readPreparedBackend(facts: Record<string, unknown>, state: ExecutionState): RemoteSandboxFacts {
	const { mode, enforcement, commandMayHaveRun, denialSuspected } = state;
	if (mode !== "workspace_write" || typeof facts.sandboxRoot !== "string" || !canonicalRemoteSandboxRoot(facts.sandboxRoot) ||
		(enforcement === "full" && !commandMayHaveRun) || (enforcement === "none" && denialSuspected !== undefined) ||
		!onlyKeys(facts, ["mode", "backend", "enforcement", "abi", "launcherVersion", "bubblewrapVersion", "sandboxRoot", "commandMayHaveRun", "denialSuspected"])) throw invalidFacts();
	const backend = readBackendMetadata(facts);
	return { ...state, ...backend, sandboxRoot: facts.sandboxRoot };
}

function readBackendMetadata(facts: Record<string, unknown>): Pick<RemoteSandboxFacts, "backend" | "abi" | "launcherVersion" | "bubblewrapVersion"> {
	if (facts.backend === "landlock") {
		if (typeof facts.abi !== "number" || !Number.isSafeInteger(facts.abi) || facts.abi < GORI_MIN_LANDLOCK_ABI ||
			typeof facts.launcherVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(facts.launcherVersion) ||
			facts.bubblewrapVersion !== undefined) throw invalidFacts();
		return { backend: "landlock", abi: facts.abi, launcherVersion: facts.launcherVersion };
	}
	if (facts.backend === "bubblewrap") {
		if (facts.abi !== undefined || facts.launcherVersion !== undefined || typeof facts.bubblewrapVersion !== "string" ||
			!/^\d+\.\d+\.\d+$/.test(facts.bubblewrapVersion)) throw invalidFacts();
		return { backend: "bubblewrap", bubblewrapVersion: facts.bubblewrapVersion };
	}
	throw invalidFacts();
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function invalidFacts(): Error { return new Error("Invalid stored command sandbox facts"); }
