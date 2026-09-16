import type { CreateCredentialInput, Credential } from "../domain/credential.ts";
import type { CredentialId, WorkspaceId } from "../domain/ids.ts";
import { requireDisplayName, requireNonEmpty } from "./validation.ts";

export interface BuildCredentialOptions {
	id: CredentialId;
	workspaceId: WorkspaceId;
	input: CreateCredentialInput;
	now: number;
}

export function buildCredential(options: BuildCredentialOptions): Credential {
	const { input } = options;
	const displayName = requireDisplayName(input.displayName);
	const remoteUser = requireNonEmpty(input.remoteUser, "remoteUser", 128);
	if (input.secret.type === "private_key") {
		requireNonEmpty(input.secret.privateKey, "privateKey", 1024 * 1024);
		if (input.secret.passphrase !== undefined) requireNonEmpty(input.secret.passphrase, "passphrase", 4096);
	} else {
		requireNonEmpty(input.secret.password, "password", 4096);
	}

	const base = {
		id: options.id,
		workspaceId: options.workspaceId,
		displayName,
		remoteUser,
		authVersion: 1,
		revision: 1,
		createdAt: options.now,
		updatedAt: options.now,
	};
	return input.secret.type === "private_key"
		? { ...base, type: "private_key", hasPassphrase: input.secret.passphrase !== undefined }
		: { ...base, type: "password" };
}
