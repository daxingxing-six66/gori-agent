import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function readCredentialKey(dataDirectory: string, databasePath: string, configured?: string): Uint8Array {
	if (configured?.trim()) return decodeCredentialKey(configured.trim());
	const keyPath = join(dataDirectory, "credential-key");
	if (!existsSync(keyPath)) {
		if (databasePath !== ":memory:" && existsSync(databasePath)) {
			throw new Error("Database exists but its key is missing. Restore credential-key or set SSH_AGENT_CREDENTIAL_KEY_BASE64.");
		}
		mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
		try {
			writeFileSync(keyPath, randomBytes(32).toString("base64"), { flag: "wx", mode: 0o600 });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
	}
	return decodeCredentialKey(readFileSync(keyPath, "utf8").trim());
}

function decodeCredentialKey(value: string): Uint8Array {
	const decoded = Buffer.from(value, "base64");
	if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
		throw new Error("Credential key must be canonical base64 for exactly 32 bytes; restore the saved key or check SSH_AGENT_CREDENTIAL_KEY_BASE64.");
	}
	return decoded;
}
