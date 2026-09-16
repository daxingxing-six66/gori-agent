import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CredentialSecret } from "../../domain/credential.ts";
import { ManagementError } from "../../domain/errors.ts";
import type { CredentialId } from "../../domain/ids.ts";

export interface EncryptedCredentialSecret {
	type: CredentialSecret["type"];
	nonce: Uint8Array;
	ciphertext: Uint8Array;
	authTag: Uint8Array;
}

export class CredentialCipher {
	private readonly key: Uint8Array;

	constructor(key: Uint8Array) {
		if (key.byteLength !== 32) throw new Error("Credential encryption key must contain exactly 32 bytes");
		this.key = new Uint8Array(key);
	}

	encrypt(credentialId: CredentialId, authVersion: number, secret: CredentialSecret): EncryptedCredentialSecret {
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
		cipher.setAAD(Buffer.from(`${credentialId}:${authVersion}`, "utf8"));
		const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
		return { type: secret.type, nonce, ciphertext, authTag: cipher.getAuthTag() };
	}

	decrypt(credentialId: CredentialId, authVersion: number, encrypted: EncryptedCredentialSecret): CredentialSecret {
		try {
			const decipher = createDecipheriv("aes-256-gcm", this.key, encrypted.nonce);
			decipher.setAAD(Buffer.from(`${credentialId}:${authVersion}`, "utf8"));
			decipher.setAuthTag(encrypted.authTag);
			const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
			const parsed: unknown = JSON.parse(plaintext);
			if (!isCredentialSecret(parsed) || parsed.type !== encrypted.type) throw new Error("Invalid secret payload");
			return parsed;
		} catch (error) {
			throw new ManagementError(
				"secret_store_failed",
				"Credential secret could not be decrypted",
				undefined,
				error instanceof Error ? error : undefined,
			);
		}
	}
}

function isCredentialSecret(value: unknown): value is CredentialSecret {
	if (value === null || typeof value !== "object" || !("type" in value)) return false;
	if (value.type === "password") return "password" in value && typeof value.password === "string";
	if (value.type !== "private_key" || !("privateKey" in value) || typeof value.privateKey !== "string") return false;
	return !("passphrase" in value) || value.passphrase === undefined || typeof value.passphrase === "string";
}
