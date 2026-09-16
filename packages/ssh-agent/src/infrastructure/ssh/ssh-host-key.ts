import { createHash } from "node:crypto";
import type { ServerHostKeyAlgorithm } from "ssh2";

export const SUPPORTED_SSH_HOST_KEY_ALGORITHMS = [
	"ssh-ed25519",
	"ecdsa-sha2-nistp256",
	"ecdsa-sha2-nistp384",
	"ecdsa-sha2-nistp521",
	"rsa-sha2-512",
	"rsa-sha2-256",
	"ssh-rsa",
	"ssh-dss",
] as const satisfies readonly ServerHostKeyAlgorithm[];

const supportedAlgorithms = new Set<ServerHostKeyAlgorithm>(SUPPORTED_SSH_HOST_KEY_ALGORITHMS);

export function isSupportedSshHostKeyAlgorithm(value: string): value is ServerHostKeyAlgorithm {
	return supportedAlgorithms.has(value as ServerHostKeyAlgorithm);
}

export function fingerprintSshHostKey(key: Uint8Array): string {
	return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}
