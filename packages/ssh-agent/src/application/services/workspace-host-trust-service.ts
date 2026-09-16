import type { Clock, WorkspaceId } from "../../domain/ids.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import type { VerifiedHostKey, Workspace } from "../../domain/workspace.ts";
import type { HostKeyProbe } from "../host-key-probe.ts";
import type { WorkspaceHostTrustRepository } from "../repositories/workspace-host-trust-repository.ts";

export interface WorkspaceHostTrustService {
	ensureTrusted(workspace: Workspace): Promise<VerifiedHostKey>;
}

export interface DefaultWorkspaceHostTrustServiceOptions {
	hostTrusts: WorkspaceHostTrustRepository;
	probe: HostKeyProbe;
	clock: Clock;
}

export class DefaultWorkspaceHostTrustService implements WorkspaceHostTrustService {
	private readonly hostTrusts: WorkspaceHostTrustRepository;
	private readonly probe: HostKeyProbe;
	private readonly clock: Clock;
	private readonly pending = new Map<WorkspaceId, Promise<VerifiedHostKey>>();

	constructor(options: DefaultWorkspaceHostTrustServiceOptions) {
		this.hostTrusts = options.hostTrusts;
		this.probe = options.probe;
		this.clock = options.clock;
	}

	async ensureTrusted(workspace: Workspace): Promise<VerifiedHostKey> {
		if (workspace.host.hostKey !== null) return workspace.host.hostKey;
		const persisted = await this.hostTrusts.findByWorkspaceId(workspace.id);
		if (persisted !== undefined) return persisted;

		const existing = this.pending.get(workspace.id);
		if (existing !== undefined) return existing;

		const bootstrap = this.bootstrap(workspace);
		this.pending.set(workspace.id, bootstrap);
		try {
			return await bootstrap;
		} finally {
			if (this.pending.get(workspace.id) === bootstrap) this.pending.delete(workspace.id);
		}
	}

	private async bootstrap(workspace: Workspace): Promise<VerifiedHostKey> {
		const observed = await this.probe.probe({
			hostname: workspace.host.hostname,
			port: workspace.host.port,
			timeoutMs: workspace.connection.connectTimeoutMs,
		});
		const trusted: VerifiedHostKey = { ...observed, verifiedAt: this.clock.now() };
		if (await this.hostTrusts.insertIfAbsent(workspace.id, trusted)) return trusted;

		const concurrent = await this.hostTrusts.findByWorkspaceId(workspace.id);
		if (
			concurrent !== undefined &&
			concurrent.algorithm === trusted.algorithm &&
			concurrent.fingerprint === trusted.fingerprint
		) {
			return concurrent;
		}
		throw new SshAgentError({
			code: "host_key_mismatch",
			category: "host_trust",
			phase: "verify_host",
			message: "SSH host key changed while the Workspace trust was being established",
			retryable: false,
			workspaceId: workspace.id,
			...(concurrent === undefined
				? {}
				: {
						safeDetails: {
							expectedAlgorithm: concurrent.algorithm,
							expectedFingerprint: concurrent.fingerprint,
							observedAlgorithm: trusted.algorithm,
							observedFingerprint: trusted.fingerprint,
						},
					}),
		});
	}
}
