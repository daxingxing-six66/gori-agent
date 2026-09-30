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
	readonly #grants = new Map<string, Map<string, string>>();

	approve(request: FullAccessRequest): void {
		const runGrants = this.#grants.get(request.agentRunId) ?? new Map<string, string>();
		runGrants.set(request.toolCallId, this.signature(request));
		this.#grants.set(request.agentRunId, runGrants);
	}

	consume(request: FullAccessRequest): boolean {
		const runGrants = this.#grants.get(request.agentRunId);
		const grant = runGrants?.get(request.toolCallId);
		runGrants?.delete(request.toolCallId);
		if (runGrants?.size === 0) this.#grants.delete(request.agentRunId);
		return grant !== undefined && grant === this.signature(request);
	}

	clearRun(agentRunId: string): void {
		this.#grants.delete(agentRunId);
	}

	private signature(request: FullAccessRequest): string {
		return JSON.stringify([request.sessionId, request.command, request.cwd, request.timeoutMs, request.justification]);
	}
}
