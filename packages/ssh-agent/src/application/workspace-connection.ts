import { ManagementError } from "../domain/errors.ts";
import { DEFAULT_WORKSPACE_CONNECTION_OPTIONS, type CreateWorkspaceInput } from "../domain/workspace.ts";
import { requireNonEmpty } from "./validation.ts";

export type TestWorkspaceConnectionInput = Pick<CreateWorkspaceInput, "host" | "credential" | "connection">;

export function validateWorkspaceConnection(input: Pick<CreateWorkspaceInput, "host" | "connection">) {
	const hostname = requireNonEmpty(input.host.hostname, "host.hostname", 253);
	if (!Number.isSafeInteger(input.host.port) || input.host.port < 1 || input.host.port > 65_535) {
		throw new ManagementError("validation_error", "host.port must be between 1 and 65535", "host.port");
	}
	const connection = { ...DEFAULT_WORKSPACE_CONNECTION_OPTIONS, ...input.connection };
	for (const [field, value] of Object.entries(connection)) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new ManagementError("validation_error", `${field} must be a non-negative integer`, `connection.${field}`);
		}
	}
	return { host: { hostname, port: input.host.port }, connection };
}
