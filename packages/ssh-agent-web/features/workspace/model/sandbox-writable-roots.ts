export const MAX_SANDBOX_WRITABLE_ROOTS = 16;

export function normalizeRemoteDirectory(path: string): string {
	const segments: string[] = [];
	for (const part of path.split("/")) {
		if (part === "..") segments.pop();
		else if (part !== "" && part !== ".") segments.push(part);
	}
	return `/${segments.join("/")}`;
}

export function isRemoteDirectory(path: string): boolean {
	return path.startsWith("/") && !path.includes("\0") && !path.includes("\n") && path.length <= 4096;
}

export function isRemoteSandboxRoot(path: string): boolean {
	return isRemoteDirectory(path) && normalizeRemoteDirectory(path) !== "/";
}

export function isCanonicalRemoteSandboxRoot(path: string): boolean {
	return isRemoteSandboxRoot(path) && normalizeRemoteDirectory(path) === path;
}

export function validSandboxWritableRoots(value: unknown, allowEmpty = false): value is string[] {
	return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= MAX_SANDBOX_WRITABLE_ROOTS &&
		value.every((root) => typeof root === "string" && isRemoteSandboxRoot(root)) && new Set(value).size === value.length;
}

export function configuredSandboxWritableRoots(config: { sandboxWritableRoots?: string[]; remoteDefaultCwd?: string }): string[] {
	const cwd = config.remoteDefaultCwd ?? "/";
	return [...(config.sandboxWritableRoots ?? (isRemoteSandboxRoot(cwd) ? [cwd] : []))];
}

export function validSandboxFactRoots(facts: { sandboxRoot?: unknown; sandboxRoots?: unknown }): boolean {
	return typeof facts.sandboxRoot === "string" && isCanonicalRemoteSandboxRoot(facts.sandboxRoot) &&
		(facts.sandboxRoots === undefined || (validSandboxWritableRoots(facts.sandboxRoots) && facts.sandboxRoots.every(isCanonicalRemoteSandboxRoot) && facts.sandboxRoots[0] === facts.sandboxRoot));
}

export function sandboxFactRoots(facts: { sandboxRoot: string; sandboxRoots?: string[] }): string[] {
	return facts.sandboxRoots ?? [facts.sandboxRoot];
}
