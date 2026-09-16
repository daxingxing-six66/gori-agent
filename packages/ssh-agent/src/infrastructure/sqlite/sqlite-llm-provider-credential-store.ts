import type { DatabaseSync } from "node:sqlite";
import type { AuthOperationOptions, Credential, CredentialInfo } from "@earendil-works/pi-ai";
import type {
	LlmProviderCredentialStore,
	PutLlmProviderCredentialInput,
	PutLlmProviderCredentialResult,
} from "../../application/repositories/llm-provider-credential-store.ts";
import { ManagementError } from "../../domain/errors.ts";
import type { Clock } from "../../domain/ids.ts";
import type { DeleteLlmProviderCredentialInput, LlmProviderCredential } from "../../domain/llm-provider.ts";
import type { LlmProviderCredentialCipher } from "./llm-provider-credential-cipher.ts";
import type { SqliteTransactionRunner } from "./sqlite-transaction-runner.ts";

interface LlmProviderCredentialRow {
	provider_id: string;
	credential_type: "api_key" | "oauth";
	revision: number;
	created_at: number;
	updated_at: number;
}

interface LlmProviderCredentialSecretRow extends LlmProviderCredentialRow {
	nonce: Uint8Array;
	ciphertext: Uint8Array;
	auth_tag: Uint8Array;
}

export interface SqliteLlmProviderCredentialStoreOptions {
	database: DatabaseSync;
	cipher: LlmProviderCredentialCipher;
	transactions: SqliteTransactionRunner;
	clock: Clock;
}

export class SqliteLlmProviderCredentialStore implements LlmProviderCredentialStore {
	private readonly database: DatabaseSync;
	private readonly cipher: LlmProviderCredentialCipher;
	private readonly transactions: SqliteTransactionRunner;
	private readonly clock: Clock;

	constructor(options: SqliteLlmProviderCredentialStoreOptions) {
		this.database = options.database;
		this.cipher = options.cipher;
		this.transactions = options.transactions;
		this.clock = options.clock;
	}

	async getMetadata(providerId: string): Promise<LlmProviderCredential | undefined> {
		return metadataFromRow(this.findMetadata(providerId));
	}

	async listMetadata(): Promise<readonly LlmProviderCredential[]> {
		const rows = this.database
			.prepare(`
				SELECT provider_id, credential_type, revision, created_at, updated_at
				FROM llm_provider_credentials
				ORDER BY provider_id
			`)
			.all() as unknown as LlmProviderCredentialRow[];
		return rows.map((row) => metadataFromRow(row)!);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const row = this.findSecret(providerId);
		if (!row) return undefined;
		const credential = this.decryptRow(row);
		if (credential.type !== row.credential_type) {
			throw new ManagementError("secret_store_failed", "LLM Provider Credential metadata does not match its secret");
		}
		options?.signal?.throwIfAborted();
		return credential;
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const credentials = (await this.listMetadata()).map(({ providerId, type }) => ({ providerId, type }));
		options?.signal?.throwIfAborted();
		return credentials;
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.withSecretError(async () =>
			this.transactions.run(async () => {
				options?.signal?.throwIfAborted();
				const row = this.findSecret(providerId);
				const current = row ? this.decryptRow(row) : undefined;
				const next = await fn(current);
				options?.signal?.throwIfAborted();
				if (next === undefined) return current;
				this.writeCredential(providerId, next, this.clock.now(), this.findMetadata(providerId));
				return next;
			}),
		);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.withSecretError(async () =>
			this.transactions.run(async () => {
				options?.signal?.throwIfAborted();
				this.database.prepare("DELETE FROM llm_provider_credentials WHERE provider_id = ?").run(providerId);
				options?.signal?.throwIfAborted();
			}),
		);
	}

	putCredential(input: PutLlmProviderCredentialInput): PutLlmProviderCredentialResult {
		return this.withSecretWrite(() => {
			const current = this.findMetadata(input.providerId);
			if (current) {
				if (input.expectedRevision !== current.revision) {
					throw new ManagementError(
						"revision_conflict",
						"LLM Provider Credential was modified by another request",
						"expectedRevision",
					);
				}
			} else if (input.expectedRevision !== undefined) {
				throw new ManagementError("not_found", `LLM Provider Credential not found: ${input.providerId}`);
			}
			return {
				credential: this.writeCredential(input.providerId, input.credential, input.updatedAt, current),
				created: current === undefined,
			};
		});
	}

	deleteCredential(input: DeleteLlmProviderCredentialInput): void {
		this.withSecretWrite(() => {
			const current = this.findMetadata(input.providerId);
			if (!current) throw new ManagementError("not_found", `LLM Provider Credential not found: ${input.providerId}`);
			if (current.revision !== input.expectedRevision) {
				throw new ManagementError(
					"revision_conflict",
					"LLM Provider Credential was modified by another request",
					"expectedRevision",
				);
			}
			this.database.prepare("DELETE FROM llm_provider_credentials WHERE provider_id = ?").run(input.providerId);
		});
	}

	removeCredential(providerId: string): void {
		this.withSecretWrite(() => {
			this.database.prepare("DELETE FROM llm_provider_credentials WHERE provider_id = ?").run(providerId);
		});
	}

	private findMetadata(providerId: string): LlmProviderCredentialRow | undefined {
		return this.database
			.prepare(`
				SELECT provider_id, credential_type, revision, created_at, updated_at
				FROM llm_provider_credentials
				WHERE provider_id = ?
			`)
			.get(providerId) as LlmProviderCredentialRow | undefined;
	}

	private findSecret(providerId: string): LlmProviderCredentialSecretRow | undefined {
		return this.database
			.prepare(`
				SELECT
					credential.provider_id,
					credential.credential_type,
					credential.revision,
					credential.created_at,
					credential.updated_at,
					secret.nonce,
					secret.ciphertext,
					secret.auth_tag
				FROM llm_provider_credentials AS credential
				JOIN llm_provider_credential_secrets AS secret USING (provider_id)
				WHERE credential.provider_id = ?
			`)
			.get(providerId) as LlmProviderCredentialSecretRow | undefined;
	}

	private writeCredential(
		providerId: string,
		credential: Credential,
		updatedAt: number,
		current: LlmProviderCredentialRow | undefined,
	): LlmProviderCredential {
		const revision = (current?.revision ?? 0) + 1;
		const createdAt = current?.created_at ?? updatedAt;
		const encrypted = this.cipher.encrypt(providerId, revision, credential);
		this.database
			.prepare(`
				INSERT INTO llm_provider_credentials (
					provider_id, credential_type, revision, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(provider_id) DO UPDATE SET
					credential_type = excluded.credential_type,
					revision = excluded.revision,
					updated_at = excluded.updated_at
			`)
			.run(providerId, credential.type, revision, createdAt, updatedAt);
		this.database
			.prepare(`
				INSERT INTO llm_provider_credential_secrets (
					provider_id, revision, nonce, ciphertext, auth_tag
				) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(provider_id) DO UPDATE SET
					revision = excluded.revision,
					nonce = excluded.nonce,
					ciphertext = excluded.ciphertext,
					auth_tag = excluded.auth_tag
			`)
			.run(providerId, revision, encrypted.nonce, encrypted.ciphertext, encrypted.authTag);
		return { providerId, type: credential.type, revision, createdAt, updatedAt };
	}

	private decryptRow(row: LlmProviderCredentialSecretRow): Credential {
		return this.cipher.decrypt(row.provider_id, row.revision, {
			nonce: row.nonce,
			ciphertext: row.ciphertext,
			authTag: row.auth_tag,
		});
	}

	private async withSecretError<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			this.throwSecretError(error);
		}
	}

	private withSecretWrite<T>(operation: () => T): T {
		try {
			return operation();
		} catch (error) {
			this.throwSecretError(error);
		}
	}

	private throwSecretError(error: unknown): never {
		if (error instanceof ManagementError) throw error;
		throw new ManagementError(
			"secret_store_failed",
			"LLM Provider Credential could not be stored",
			undefined,
			error instanceof Error ? error : undefined,
		);
	}
}

function metadataFromRow(row: LlmProviderCredentialRow | undefined): LlmProviderCredential | undefined {
	return row
		? {
				providerId: row.provider_id,
				type: row.credential_type,
				revision: row.revision,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			}
		: undefined;
}
