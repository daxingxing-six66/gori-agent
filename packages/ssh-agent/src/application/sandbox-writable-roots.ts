import { ManagementError } from "../domain/errors.ts";
import { validSandboxWritableRoots } from "../domain/sandbox-writable-roots.ts";

/** All management entry points share the same list validation. */
export function requireSandboxWritableRoots(value: readonly string[]): string[] {
	const roots = value;
	// Remote realpath owns normalization: resolving dot segments locally can change symlink meaning.
	if (!validSandboxWritableRoots(roots)) {
		throw new ManagementError("validation_error", "sandboxWritableRoots must contain 1 to 16 distinct absolute directories other than /", "sandboxWritableRoots");
	}
	return [...roots];
}
