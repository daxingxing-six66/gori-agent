import { canonicalRemoteSandboxRoot, validRemoteSandboxRoot } from "./remote-sandbox.ts";

export const MAX_SANDBOX_WRITABLE_ROOTS = 16;

/** Compatibility for configurations written before writable directories were separate from cwd. */
export function defaultSandboxWritableRoots(remoteDefaultCwd: string): string[] {
	return validRemoteSandboxRoot(remoteDefaultCwd) ? [remoteDefaultCwd] : [];
}

export function validSandboxWritableRoots(value: unknown, allowEmpty = false): value is string[] {
	return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= MAX_SANDBOX_WRITABLE_ROOTS &&
		value.every((root) => typeof root === "string" && validRemoteSandboxRoot(root)) &&
		new Set(value).size === value.length;
}

export function sameSandboxWritableRoots(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((root, index) => root === expected[index]);
}

/** Old execution evidence contains only sandboxRoot; new evidence also carries the complete list. */
export function sandboxFactRoots(facts: { sandboxRoot?: string; sandboxRoots?: readonly string[] }): readonly string[] {
	return facts.sandboxRoots ?? (facts.sandboxRoot === undefined ? [] : [facts.sandboxRoot]);
}

export function validSandboxFactRoots(facts: { sandboxRoot?: unknown; sandboxRoots?: unknown }): boolean {
	return typeof facts.sandboxRoot === "string" && canonicalRemoteSandboxRoot(facts.sandboxRoot) &&
		(facts.sandboxRoots === undefined || (validSandboxWritableRoots(facts.sandboxRoots) && facts.sandboxRoots.every(canonicalRemoteSandboxRoot) && facts.sandboxRoots[0] === facts.sandboxRoot));
}
