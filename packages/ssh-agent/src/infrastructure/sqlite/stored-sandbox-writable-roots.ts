import { validSandboxWritableRoots } from "../../domain/sandbox-writable-roots.ts";

/** Nullable only for legacy repository callers; [] explicitly means unconfigured. */
export function readStoredSandboxWritableRoots(json: string | null): string[] | undefined {
	if (json === null) return undefined;
	const value: unknown = JSON.parse(json);
	// Preserve historical spelling, including dot segments through remote symlinks.
	const roots = value;
	if (!validSandboxWritableRoots(roots, true)) throw new Error("Invalid persisted sandbox writable directories");
	return roots;
}
