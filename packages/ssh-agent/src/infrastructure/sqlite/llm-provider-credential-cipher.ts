import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Credential } from "@earendil-works/pi-ai";
import { ManagementError } from "../../domain/errors.ts";

export interface EncryptedLlmProviderCredential {
	nonce: Uint8Array;
	ciphertext: Uint8Array;
	authTag: Uint8Array;
}

export class LlmProviderCredentialCipher {
	private readonly key: Uint8Array;

	constructor(key: Uint8Array) {
		if (key.byteLength !== 32) throw new Error("Credential encryption key must contain exactly 32 bytes");
		this.key = new Uint8Array(key);
	}

	encrypt(providerId: string, revision: number, credential: Credential): EncryptedLlmProviderCredential {
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
		cipher.setAAD(Buffer.from(aad(providerId, revision), "utf8"));
		const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential), "utf8"), cipher.final()]);
		return { nonce, ciphertext, authTag: cipher.getAuthTag() };
	}

	decrypt(providerId: string, revision: number, encrypted: EncryptedLlmProviderCredential): Credential {
		try {
			const decipher = createDecipheriv("aes-256-gcm", this.key, encrypted.nonce);
			decipher.setAAD(Buffer.from(aad(providerId, revision), "utf8"));
			decipher.setAuthTag(encrypted.authTag);
			const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
			const parsed: unknown = JSON.parse(plaintext);
			if (!isCredential(parsed)) throw new Error("Invalid LLM Provider Credential payload");
			return parsed;
		} catch (error) {
			throw new ManagementError(
				"secret_store_failed",
				"LLM Provider Credential could not be decrypted",
				undefined,
				error instanceof Error ? error : undefined,
			);
		}
	}
}

function aad(providerId: string, revision: number): string {
	return `llm-provider:${providerId}:${revision}`;
}

function isCredential(value: unknown): value is Credential {
	if (value === null || typeof value !== "object" || !("type" in value)) return false;
	if (value.type === "api_key") {
		if ("key" in value && value.key !== undefined && typeof value.key !== "string") return false;
		if (!("env" in value) || value.env === undefined) return true;
		return (
			typeof value.env === "object" &&
			value.env !== null &&
			!Array.isArray(value.env) &&
			Object.values(value.env).every((entry) => typeof entry === "string")
		);
	}
	return (
		value.type === "oauth" &&
		"refresh" in value &&
		typeof value.refresh === "string" &&
		"access" in value &&
		typeof value.access === "string" &&
		"expires" in value &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}
