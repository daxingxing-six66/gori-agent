import { DeploymentError } from "../domain/deployment.ts";

/** Classify only known path failures, retaining the exact path and syscall category. */
export function deploymentFileSystemError(error: unknown, code: string, field: string, path: string): never {
	const errno = error instanceof Error && "code" in error ? error.code : undefined;
	const reasons: Record<string, string> = {
		ENOENT: "does not exist; it must exist before this operation",
		ENOTDIR: "contains a parent component that is not a directory",
		EACCES: "cannot be accessed by the backend account (permission denied)",
		EPERM: "cannot be accessed by the backend account (operation not permitted)",
		ELOOP: "cannot be resolved because of a symbolic-link loop",
	};
	if (typeof errno !== "string" || reasons[errno] === undefined) throw error;
	throw new DeploymentError(code, `${field}: ${path} ${reasons[errno]} [${errno}]`, 409,
		{ field, details: { path, filesystemCode: errno } });
}
