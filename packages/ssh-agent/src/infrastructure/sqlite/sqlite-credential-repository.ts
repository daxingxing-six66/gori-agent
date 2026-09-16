import type { DatabaseSync } from "node:sqlite";
import type {
	CredentialRepository,
	CredentialSecretStore,
} from "../../application/repositories/credential-repository.ts";
import type { Credential, CredentialSecret } from "../../domain/credential.ts";
import { ManagementError } from "../../domain/errors.ts";
import type { CredentialId, WorkspaceId } from "../../domain/ids.ts";
import type { CredentialCipher } from "./credential-cipher.ts";
import { type CredentialRow, credentialFromRow } from "./rows.ts";

const CREDENTIAL_COLUMNS = `id, workspace_id, display_name, type, remote_user, public_key_fingerprint,
	has_passphrase, auth_version, revision, created_at, updated_at`;

export class SqliteCredentialRepository implements CredentialRepository {
	private readonly database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	async findById(workspaceId: WorkspaceId, id: CredentialId): Promise<Credential | undefined> {
		const row = this.database
			.prepare(`SELECT ${CREDENTIAL_COLUMNS} FROM credentials WHERE workspace_id = ? AND id = ?`)
			.get(workspaceId, id);
		return row === undefined ? undefined : credentialFromRow(row as unknown as CredentialRow);
	}

	async listByWorkspaceId(workspaceId: WorkspaceId): Promise<Credential[]> {
		const rows = this.database
			.prepare(
				`SELECT ${CREDENTIAL_COLUMNS} FROM credentials
				WHERE workspace_id = ? ORDER BY display_name, id`,
			)
			.all(workspaceId);
		return rows.map((row) => credentialFromRow(row as unknown as CredentialRow));
	}

	async insert(credential: Credential, active: boolean): Promise<void> {
		this.database
			.prepare(`INSERT INTO credentials (
				id, workspace_id, display_name, type, remote_user, public_key_fingerprint, has_passphrase,
				is_active, auth_version, revision, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				credential.id,
				credential.workspaceId,
				credential.displayName,
				credential.type,
				credential.remoteUser,
				credential.type === "private_key" ? (credential.publicKeyFingerprint ?? null) : null,
				credential.type === "private_key" && credential.hasPassphrase ? 1 : 0,
				active ? 1 : 0,
				credential.authVersion,
				credential.revision,
				credential.createdAt,
				credential.updatedAt,
			);
	}

	async update(credential: Credential, expectedRevision: number): Promise<boolean> {
		const result = this.database
			.prepare(`UPDATE credentials SET
				display_name = ?, remote_user = ?, public_key_fingerprint = ?, has_passphrase = ?,
				auth_version = ?, revision = ?, updated_at = ?
			WHERE workspace_id = ? AND id = ? AND revision = ?`)
			.run(
				credential.displayName,
				credential.remoteUser,
				credential.type === "private_key" ? (credential.publicKeyFingerprint ?? null) : null,
				credential.type === "private_key" && credential.hasPassphrase ? 1 : 0,
				credential.authVersion,
				credential.revision,
				credential.updatedAt,
				credential.workspaceId,
				credential.id,
				expectedRevision,
			);
		return result.changes === 1;
	}

	async activate(workspaceId: WorkspaceId, id: CredentialId): Promise<boolean> {
		if (
			this.database.prepare("SELECT 1 FROM credentials WHERE workspace_id = ? AND id = ?").get(workspaceId, id) ===
			undefined
		) {
			return false;
		}
		this.database
			.prepare("UPDATE credentials SET is_active = 0 WHERE workspace_id = ? AND is_active = 1")
			.run(workspaceId);
		return (
			this.database
				.prepare("UPDATE credentials SET is_active = 1 WHERE workspace_id = ? AND id = ?")
				.run(workspaceId, id).changes === 1
		);
	}

	async delete(workspaceId: WorkspaceId, id: CredentialId, expectedRevision: number): Promise<boolean> {
		return (
			this.database
				.prepare("DELETE FROM credentials WHERE workspace_id = ? AND id = ? AND revision = ?")
				.run(workspaceId, id, expectedRevision).changes === 1
		);
	}
}

interface CredentialSecretRow {
	auth_version: number;
	secret_type: CredentialSecret["type"];
	nonce: Uint8Array;
	ciphertext: Uint8Array;
	auth_tag: Uint8Array;
}

export class SqliteCredentialSecretStore implements CredentialSecretStore {
	private readonly database: DatabaseSync;
	private readonly cipher: CredentialCipher;

	constructor(database: DatabaseSync, cipher: CredentialCipher) {
		this.database = database;
		this.cipher = cipher;
	}

	async put(credentialId: CredentialId, authVersion: number, secret: CredentialSecret): Promise<void> {
		try {
			const encrypted = this.cipher.encrypt(credentialId, authVersion, secret);
			this.database
				.prepare(`INSERT INTO credential_secrets (
					credential_id, auth_version, secret_type, nonce, ciphertext, auth_tag
				) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(credential_id) DO UPDATE SET
					auth_version = excluded.auth_version,
					secret_type = excluded.secret_type,
					nonce = excluded.nonce,
					ciphertext = excluded.ciphertext,
					auth_tag = excluded.auth_tag`)
				.run(credentialId, authVersion, encrypted.type, encrypted.nonce, encrypted.ciphertext, encrypted.authTag);
		} catch (error) {
			throw new ManagementError(
				"secret_store_failed",
				"Credential secret could not be stored",
				undefined,
				error instanceof Error ? error : undefined,
			);
		}
	}

	async get(credentialId: CredentialId, authVersion: number): Promise<CredentialSecret | undefined> {
		const row = this.database
			.prepare(`SELECT auth_version, secret_type, nonce, ciphertext, auth_tag
				FROM credential_secrets WHERE credential_id = ? AND auth_version = ?`)
			.get(credentialId, authVersion);
		if (row === undefined) return undefined;
		const secret = row as unknown as CredentialSecretRow;
		return this.cipher.decrypt(credentialId, secret.auth_version, {
			type: secret.secret_type,
			nonce: secret.nonce,
			ciphertext: secret.ciphertext,
			authTag: secret.auth_tag,
		});
	}

	async deleteAll(credentialId: CredentialId): Promise<void> {
		this.database.prepare("DELETE FROM credential_secrets WHERE credential_id = ?").run(credentialId);
	}
}
