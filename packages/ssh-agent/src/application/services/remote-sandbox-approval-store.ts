import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";

export interface FullAccessRequest {
	agentRunId: string;
	toolCallId: string;
	sessionId: string;
	command: string;
	cwd?: string;
	timeoutMs?: number;
	justification: string;
}

/** Only the human approval path grants access. A grant authorizes one exact request. */
export class RemoteSandboxApprovalStore {
	readonly #grants = new Map<string, Map<string, { signature: string; target?: string }>>();

	approve(request: FullAccessRequest, target?: SshTargetSnapshot): void {
		const runGrants = this.#grants.get(request.agentRunId) ?? new Map<string, { signature: string; target?: string }>();
		runGrants.set(request.toolCallId, { signature: this.signature(request),
			...(target === undefined ? {} : { target: targetSignature(target) }) });
		this.#grants.set(request.agentRunId, runGrants);
	}

	consume(request: FullAccessRequest, actualTarget?: SshTargetSnapshot): boolean {
		const runGrants = this.#grants.get(request.agentRunId);
		const grant = runGrants?.get(request.toolCallId);
		runGrants?.delete(request.toolCallId);
		if (runGrants?.size === 0) this.#grants.delete(request.agentRunId);
		return grant !== undefined && grant.signature === this.signature(request) &&
			(grant.target === undefined || (actualTarget !== undefined && grant.target === targetSignature(actualTarget)));
	}

	clearRun(agentRunId: string): void {
		this.#grants.delete(agentRunId);
	}

	private signature(request: FullAccessRequest): string {
		return JSON.stringify([request.sessionId, request.command, request.cwd, request.timeoutMs, request.justification]);
	}
}

function targetSignature(target: SshTargetSnapshot): string {
	return JSON.stringify([target.workspaceId, target.workspaceRevision, target.hostname, target.port,
		target.hostKeyAlgorithm, target.hostKeyFingerprint, target.credentialId, target.credentialAuthVersion,
		target.remoteUser, target.sandboxWritableRoots ?? []]);
}
