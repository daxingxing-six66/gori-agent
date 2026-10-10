import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import type { FullAccessRequest } from "../services/remote-sandbox-approval-store.ts";
import type { RemoteServerCallParameters } from "./remote-server-call-tool.ts";

type CommandAccess =
	| { readonly mode: "workspace_write" }
	| { readonly mode: "full_access"; readonly justification: string; readonly authorizationSource?: "session_setting" };

type CommandRequest = Omit<Readonly<RemoteServerCallParameters>, "write_paths"> & {
	readonly write_paths?: readonly string[];
};

/** Per-call handoff from authorization to execution. A Full Access plan still needs a consumable grant. */
export class RemoteCommandExecutionPlan {
	readonly agentRunId?: string;
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly request: CommandRequest;
	readonly access: CommandAccess;
	readonly expectedTarget?: Readonly<SshTargetSnapshot>;

	constructor(options: {
		agentRunId?: string;
		sessionId: string;
		toolCallId: string;
		request: CommandRequest;
		access: CommandAccess;
		expectedTarget?: SshTargetSnapshot;
	}) {
		this.agentRunId = options.agentRunId;
		this.sessionId = options.sessionId;
		this.toolCallId = options.toolCallId;
		this.request = snapshotRemoteCommandRequest(options.request);
		this.access = Object.freeze({ ...options.access });
		this.expectedTarget = options.expectedTarget === undefined ? undefined : Object.freeze({ ...options.expectedTarget });
		Object.freeze(this);
	}

	matches(agentRunId: string | undefined, sessionId: string, toolCallId: string, request: RemoteServerCallParameters): boolean {
		return this.agentRunId === agentRunId && this.sessionId === sessionId && this.toolCallId === toolCallId &&
			requestSignature(this.request) === requestSignature(request);
	}

	fullAccessRequest(): FullAccessRequest | undefined {
		if (this.access.mode !== "full_access" || this.access.authorizationSource === "session_setting" || this.agentRunId === undefined) return undefined;
		return Object.freeze({ agentRunId: this.agentRunId, sessionId: this.sessionId, toolCallId: this.toolCallId,
			command: this.request.command, cwd: this.request.cwd, timeoutMs: this.request.timeoutMs,
			justification: this.access.justification });
	}
}

export function snapshotRemoteCommandRequest(request: CommandRequest): CommandRequest {
	return Object.freeze({ ...request,
		...(request.write_paths === undefined ? {} : { write_paths: Object.freeze([...request.write_paths]) }) });
}

function requestSignature(request: CommandRequest): string {
	return JSON.stringify([request.command, request.cwd, request.timeoutMs,
		request.sandbox_permissions, request.justification, request.write_paths]);
}
