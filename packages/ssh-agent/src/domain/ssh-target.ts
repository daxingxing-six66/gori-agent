import type { CredentialId, WorkspaceId } from "./ids.ts";

export interface SshTargetSnapshot {
	workspaceId: WorkspaceId;
	workspaceRevision: number;
	hostname: string;
	port: number;
	hostKeyAlgorithm: string;
	hostKeyFingerprint: string;
	credentialId: CredentialId;
	credentialAuthVersion: number;
	remoteUser: string;
	defaultCwd: string;
	connectTimeoutMs: number;
	keepaliveIntervalMs: number;
	keepaliveMaxCount: number;
}

export type SshConnectionKey = Omit<
	SshTargetSnapshot,
	"workspaceRevision" | "defaultCwd" | "connectTimeoutMs" | "keepaliveIntervalMs" | "keepaliveMaxCount"
>;

export function connectionKeyFor(target: SshTargetSnapshot): SshConnectionKey {
	return {
		workspaceId: target.workspaceId,
		hostname: target.hostname,
		port: target.port,
		hostKeyAlgorithm: target.hostKeyAlgorithm,
		hostKeyFingerprint: target.hostKeyFingerprint,
		credentialId: target.credentialId,
		credentialAuthVersion: target.credentialAuthVersion,
		remoteUser: target.remoteUser,
	};
}

export function serializeConnectionKey(key: SshConnectionKey): string {
	return JSON.stringify([
		key.workspaceId,
		key.hostname,
		key.port,
		key.hostKeyAlgorithm,
		key.hostKeyFingerprint,
		key.credentialId,
		key.credentialAuthVersion,
		key.remoteUser,
	]);
}
