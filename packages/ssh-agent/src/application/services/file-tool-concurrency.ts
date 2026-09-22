import { basename, join, normalize, posix, sep } from "node:path";
import { type AgentTool, type AgentToolCall, type ExecutionEnv, getOrThrow } from "@earendil-works/pi-agent-core";

interface PathAccess {
	side: "local" | "remote";
	path: string;
	write: boolean;
}

const parallelTools = new Set(["read", "sftp_upload", "sftp_download"]);

/** Applies only within one assistant batch. Does not lock files across runs or processes. */
export function configureFileToolConcurrency(tools: AgentTool[], env: Pick<ExecutionEnv, "absolutePath">): AgentTool[] {
	const restriction: NonNullable<AgentTool["requiresSequentialExecution"]> = (calls, signal) =>
		fileToolBatchRequiresSequence(calls, env, signal);
	return tools.map((tool) => parallelTools.has(tool.name)
		? { ...tool, executionMode: "parallel", requiresSequentialExecution: restriction }
		: { ...tool, executionMode: "sequential" });
}

export async function fileToolBatchRequiresSequence(
	calls: readonly AgentToolCall[],
	env: Pick<ExecutionEnv, "absolutePath">,
	signal?: AbortSignal,
): Promise<boolean> {
	const previous: PathAccess[] = [];
	try {
		for (const call of calls) {
			if (signal?.aborted) return true;
			const accesses = await pathAccesses(call, env, signal);
			if (!accesses) return true;
			if (accesses.some((next) => previous.some((prior) =>
				prior.side === next.side && (prior.write || next.write) && pathsOverlap(prior, next)))) return true;
			previous.push(...accesses);
		}
		return false;
	} catch {
		// Invalid arguments/resolution errors are reported by normal tool execution.
		return true;
	}
}

async function pathAccesses(
	call: AgentToolCall,
	env: Pick<ExecutionEnv, "absolutePath">,
	signal?: AbortSignal,
): Promise<PathAccess[] | undefined> {
	const args: unknown = call.arguments;
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const values = args as Record<string, unknown>;
	const local = async (value: unknown) => normalize(getOrThrow(await env.absolutePath(pathValue(value), signal)));
	if (call.name === "read") {
		const raw = pathValue(values.path);
		// read supports spelling fallbacks (Unicode spaces, @, NFD and curly quotes).
		// Ambiguous spellings remain serial rather than guessing its eventual target.
		if (raw.startsWith("@") || /[\u00a0\u2000-\u200a\u202f\u205f\u3000'’]/u.test(raw)) return undefined;
		return [{ side: "local", path: await local(raw), write: false }];
	}
	if (call.name === "sftp_upload") {
		const source = await local(values.sourceFilePath);
		return [
			{ side: "local", path: source, write: false },
			{ side: "remote", path: posix.join(remotePath(values.targetPath), basename(source)), write: true },
		];
	}
	if (call.name === "sftp_download") {
		const source = remotePath(values.remoteFilePath);
		return [
			{ side: "remote", path: source, write: false },
			{ side: "local", path: join(await local(values.targetPath), posix.basename(source)), write: true },
		];
	}
	return undefined;
}

function pathValue(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("Invalid tool path");
	return value;
}

function remotePath(value: unknown): string {
	const path = pathValue(value);
	if (!posix.isAbsolute(path)) throw new Error("Expected an absolute remote path");
	return posix.normalize(path);
}

function pathsOverlap(left: PathAccess, right: PathAccess): boolean {
	const separator = left.side === "local" ? sep : "/";
	const key = (path: string) => {
		let result = path;
		if (left.side === "local") {
			result = result.normalize("NFC");
			if (process.platform === "win32" || process.platform === "darwin") result = result.toLowerCase();
		}
		return result.endsWith(separator) ? result : result + separator;
	};
	const a = key(left.path);
	const b = key(right.path);
	return a.startsWith(b) || b.startsWith(a);
}
