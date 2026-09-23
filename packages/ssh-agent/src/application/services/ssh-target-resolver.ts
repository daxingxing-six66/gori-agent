import type { SessionId, WorkspaceId } from "../../domain/ids.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import type { CredentialRepository } from "../repositories/credential-repository.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import type { WorkspaceRepository } from "../repositories/workspace-repository.ts";
import type { WorkspaceHostTrustService } from "./workspace-host-trust-service.ts";

export interface SshTargetResolver {
	resolve(sessionId: SessionId): Promise<SshTargetSnapshot>;
}

export interface WorkspaceSshTargetResolver {
	resolveWorkspace(workspaceId: WorkspaceId): Promise<SshTargetSnapshot>;
}

export class DefaultSshTargetResolver implements SshTargetResolver, WorkspaceSshTargetResolver {
	private readonly sessions: SessionRepository;
	private readonly workspaces: WorkspaceRepository;
	private readonly credentials: CredentialRepository;
	private readonly hostTrust: WorkspaceHostTrustService;

	constructor(options: {
		sessions: SessionRepository;
		workspaces: WorkspaceRepository;
		credentials: CredentialRepository;
		hostTrust: WorkspaceHostTrustService;
	}) {
		this.sessions = options.sessions;
		this.workspaces = options.workspaces;
		this.credentials = options.credentials;
		this.hostTrust = options.hostTrust;
	}

	async resolve(sessionId: SessionId): Promise<SshTargetSnapshot> {
		const session = await this.sessions.findById(sessionId);
		if (!session) {
			throw new SshAgentError({
				code: "session_not_found",
				category: "request",
				phase: "resolve_target",
				message: "SSH session no longer exists",
				retryable: false,
				sessionId,
			});
		}
		return await this.resolveWorkspaceTarget(session.workspaceId, sessionId);
	}

	async resolveWorkspace(workspaceId: WorkspaceId): Promise<SshTargetSnapshot> {
		return await this.resolveWorkspaceTarget(workspaceId);
	}

	private async resolveWorkspaceTarget(workspaceId: WorkspaceId, sessionId?: SessionId): Promise<SshTargetSnapshot> {
		const workspace = await this.workspaces.findById(workspaceId);
		if (!workspace) {
			throw new SshAgentError({
				code: "workspace_not_found",
				category: "workspace",
				phase: "resolve_target",
				message: "SSH workspace no longer exists",
				retryable: false,
				...(sessionId === undefined ? {} : { sessionId }),
				workspaceId,
			});
		}
		const credential = await this.credentials.findById(workspace.id, workspace.activeCredentialId);
		if (!credential) {
			throw new SshAgentError({
				code: "credential_not_found",
				category: "workspace",
				phase: "resolve_target",
				message: "The active SSH credential no longer exists",
				retryable: false,
				...(sessionId === undefined ? {} : { sessionId }),
				workspaceId: workspace.id,
			});
		}
		const hostKey = await this.hostTrust.ensureTrusted(workspace);
		return {
			workspaceId: workspace.id,
			workspaceRevision: workspace.revision,
			hostname: workspace.host.hostname,
			port: workspace.host.port,
			hostKeyAlgorithm: hostKey.algorithm,
			hostKeyFingerprint: hostKey.fingerprint,
			credentialId: credential.id,
			credentialAuthVersion: credential.authVersion,
			remoteUser: credential.remoteUser,
			defaultCwd: workspace.remoteDefaultCwd ?? "/",
			connectTimeoutMs: workspace.connection.connectTimeoutMs,
			keepaliveIntervalMs: workspace.connection.keepaliveIntervalMs,
			keepaliveMaxCount: workspace.connection.keepaliveMaxCount,
		};
	}
}
