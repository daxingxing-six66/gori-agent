import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";

/** Complete synthetic identity; individual tests override only the facts under test. */
export function testSshTarget(overrides: Partial<SshTargetSnapshot> = {}): SshTargetSnapshot {
	return { workspaceId: "workspace", workspaceRevision: 1, hostname: "fixture.invalid", port: 22,
		hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: "SHA256:fixture", credentialId: "credential",
		credentialAuthVersion: 1, remoteUser: "fixture", sandboxWritableRoots: ["/srv/app"],
		connectTimeoutMs: 1_000, keepaliveIntervalMs: 1_000, keepaliveMaxCount: 3, ...overrides };
}
