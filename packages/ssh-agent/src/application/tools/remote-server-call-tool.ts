import { type AgentTool, AgentToolError } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { SessionId } from "../../domain/ids.ts";
import type { RemoteSandboxFacts } from "../../domain/remote-sandbox.ts";
import type { SshFailure } from "../../domain/ssh-failure.ts";
import { backendMessage } from "../../i18n/message.ts";
import { descriptorForPublicFailure } from "../../i18n/public-error.ts";
import {
	COMMAND_EXECUTION_DEFAULTS,
	type CommandOperationResult,
	type CommandOperationService,
} from "../services/command-operation-service.ts";
import type { ToolUpdateDetails } from "../tool-update-protocol.ts";
import { RemoteCommandExecutionPlan, snapshotRemoteCommandRequest } from "./remote-command-execution-plan.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import type { RemoteSandboxRoute } from "../services/remote-sandbox-routing.ts";
import { isToolArguments, toolRequestError, type PreparedToolAuthorization, type ToolAuthorizationInput } from "./tool-authorization.ts";

const remoteServerCallParameters = Type.Object({
	sandbox_permissions: Type.Optional(Type.Union([Type.Literal("workspace_write"), Type.Literal("full_access")], {
		description: "While Session sandboxing is enabled, defaults to workspace_write. Automatic approval controls whether a sandboxed command needs human confirmation; it does not change confinement. Explicit full_access requires justification and a separate human approval. Never retry automatically after a sandbox denial.",
	})),
	justification: Type.Optional(Type.String({ minLength: 1, description: "While Session sandboxing is enabled, why this exact call needs to bypass filesystem confinement; required with explicit sandbox_permissions=full_access" })),
	write_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Known absolute remote write destinations. While Session sandboxing is enabled, declare only paths known before execution; omitted or unknown script effects run in the sandbox first. A known destination outside the writable roots requires a separate human approval." })),
	command: Type.String({ minLength: 1, description: "Shell command to execute on the remote Linux server" }),
	cwd: Type.Optional(
		Type.String({ minLength: 1, description: "Absolute remote working directory, ~, or a path under ~/" }),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: COMMAND_EXECUTION_DEFAULTS.maxCommandTimeoutMs,
			description: "Execution timeout in milliseconds",
		}),
	),
});

export type RemoteServerCallParameters = Static<typeof remoteServerCallParameters>;

export type RemoteServerCallStatus = "completed" | "failed" | "cancelled" | "blocked" | "uncertain";

export interface RemoteServerCallDetails extends ToolUpdateDetails {
	operationId: string;
	status: RemoteServerCallStatus;
	failure?: SshFailure;
	exitCode?: number;
	exitSignal?: string;
	outputTruncated: boolean;
	sandbox?: RemoteSandboxFacts;
}

export const remoteServerCallDefinition = {
	name: "remote_server_call",
	label: "Remote server command",
	description:
		"Execute a shell command in the current SSH Workspace. The Session determines the server, credential and whether sandboxing is enabled; never ask for connection details. When the user disables sandboxing for this Session, commands run directly under SSH account permissions and ordinary approval, with Guard still enforced. Sandbox probes and preparation are skipped. The following confinement and exception rules apply only while sandboxing is enabled. With an available Landlock or Bubblewrap backend, commands run in the filesystem sandbox regardless of whether approval is automatic or manual. Content writes are confined to this Session's selected writable directories, /tmp and /dev/null; a per-command cwd does not expand that boundary. Declare known absolute write_paths so an out-of-scope destination can receive a separate human approval for one full_access command. If no usable sandbox exists, one full_access command also requires human approval. If Bubblewrap is absent, use bubblewrap_inspect then propose bubblewrap_install for human approval when installation is appropriate. An explicitly requested full_access call requires justification and human approval. Unknown script effects run sandboxed first; after a permission failure, inspect partial effects and request a new human-approved full_access call only if needed. Metadata changes, network and IPC are outside the restricted filesystem policy.",
	parameters: remoteServerCallParameters,
};

export interface RemoteCommandAuthorization {
	autoApprove(): Promise<boolean>;
	sandboxEnabled?(): Promise<boolean>;
	readOnly?(): Promise<boolean>;
	preflightGuard(sessionId: string, command: string): Promise<{ allowed: boolean; reason?: string }>;
	assessSandbox?: (sessionId: string, declaredWritePaths: readonly string[], signal: AbortSignal) =>
		Promise<{ readonly target: SshTargetSnapshot; readonly route: RemoteSandboxRoute }>;
	resolveTarget?: (sessionId: string) => Promise<SshTargetSnapshot>;
}

export async function prepareRemoteCommandAuthorization(
	input: ToolAuthorizationInput, authorization: RemoteCommandAuthorization,
): Promise<PreparedToolAuthorization> {
	if (!isToolArguments(input.args) || typeof input.args.command !== "string")
		throw toolRequestError("remote_server_call requires a command");
	// Snapshot before awaiting Guard/probes/approval; execution must use the request we assessed.
	const request = snapshotRemoteCommandRequest(input.args as RemoteServerCallParameters);
	const callInput = { ...input, run: { ...input.run } };
	const command = request.command;
	const decision = await authorization.preflightGuard(callInput.run.sessionId, command);
	if (!decision.allowed) return { kind: "block", block: true, terminate: true,
		reason: decision.reason ?? "Command blocked by Workspace Guard" };
	const readOnly = await authorization.readOnly?.() === true;
	if (readOnly && request.sandbox_permissions === "full_access")
		throw toolRequestError("Full Access is forbidden in read-only mode. Use confined commands to inspect logs; writes are limited to /tmp.");
	if (await authorization.sandboxEnabled?.() === false) {
		const plan = new RemoteCommandExecutionPlan({ agentRunId: callInput.run.id,
			sessionId: callInput.run.sessionId, toolCallId: callInput.toolCallId, request,
			access: { mode: "full_access", justification: "Session sandbox disabled by user", authorizationSource: "session_setting" },
			expectedTarget: await authorization.resolveTarget?.(callInput.run.sessionId) });
		return { kind: "approval", autoApprove: await authorization.autoApprove(), executionContext: plan,
			descriptionMessage: backendMessage("approval.remote_session_unconfined", { command }) };
	}
	if (request.sandbox_permissions === "full_access") {
		if (typeof request.justification !== "string" || !request.justification.trim())
			throw toolRequestError("full_access requires a non-empty justification");
		const target = await authorization.resolveTarget?.(callInput.run.sessionId);
		return fullAccessAuthorization(callInput, request, request.justification, target,
			backendMessage("approval.remote_full_access", { justification: request.justification }));
	}
	if (request.justification !== undefined) throw toolRequestError(
		"justification alone does not disable the sandbox. To request one human-approved unconfined command, set sandbox_permissions to full_access and provide justification; otherwise omit justification.",
	);
	const declaredWritePaths = request.write_paths ?? [];
	const assessed = await authorization.assessSandbox?.(
		callInput.run.sessionId, declaredWritePaths, input.signal ?? AbortSignal.timeout(30_000),
	);
	if (readOnly && (!assessed || assessed.route.mode === "full_access"))
		throw toolRequestError(`Read-only mode cannot bypass confinement: ${assessed?.route.mode === "full_access" ? assessed.route.details : "No sandbox assessment is available"}. No command was executed.`);
	if (assessed?.route.mode === "full_access") return fullAccessAuthorization(
		callInput, request, assessed.route.details, assessed.target,
		backendMessage("approval.remote_sandbox_exception", { reason: assessed.route.details }),
	);
	const plan = new RemoteCommandExecutionPlan({ agentRunId: callInput.run.id,
			sessionId: callInput.run.sessionId, toolCallId: callInput.toolCallId, request,
			access: { mode: "workspace_write" }, expectedTarget: assessed?.target });
	return { kind: "approval", autoApprove: await authorization.autoApprove(), executionContext: plan,
		descriptionMessage: backendMessage("approval.remote_sandboxed_command") };
}

function fullAccessAuthorization(input: ToolAuthorizationInput, request: RemoteCommandExecutionPlan["request"], justification: string,
	target: SshTargetSnapshot | undefined, descriptionMessage: ReturnType<typeof backendMessage>): PreparedToolAuthorization {
	const plan = new RemoteCommandExecutionPlan({ agentRunId: input.run.id,
		sessionId: input.run.sessionId, toolCallId: input.toolCallId, request,
		access: { mode: "full_access", justification }, expectedTarget: target });
	return { kind: "approval", autoApprove: false, approvalToolName: "remote_sandbox_exception",
		executionContext: plan, remoteFullAccess: plan.fullAccessRequest(),
		...(plan.expectedTarget === undefined ? {} : { remoteFullAccessTarget: plan.expectedTarget }), descriptionMessage };
}

export function createRemoteServerCallTool(options: {
	sessionId: SessionId;
	agentRunId?: string;
	operations: Pick<CommandOperationService, "submit">;
	abortRun?: () => void;
}): AgentTool<typeof remoteServerCallParameters, RemoteServerCallDetails> {
	return {
		...remoteServerCallDefinition,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, _onUpdate, executionContext) => {
			// Standalone callers have no Chat plan; Command Service resolves the current Session policy.
			const plan = executionContext ?? (options.agentRunId === undefined && params.sandbox_permissions !== "full_access"
				? new RemoteCommandExecutionPlan({ sessionId: options.sessionId, toolCallId,
					request: params, access: { mode: "workspace_write" } }) : undefined);
			if (!(plan instanceof RemoteCommandExecutionPlan) ||
				!plan.matches(options.agentRunId, options.sessionId, toolCallId, params))
				throw toolRequestError("Remote command execution plan is missing or does not match this tool call. The command was not executed.");
			const request = plan.request;
			const result = await options.operations.submit({
				toolCallId,
				sessionId: options.sessionId,
				command: request.command,
				agentRunId: plan.agentRunId,
				sandboxPermissions: plan.access.mode,
				...(executionContext === undefined ? {} : { expectedSandboxEnabled: plan.access.mode !== "full_access" || plan.access.authorizationSource !== "session_setting" }),
				...(plan.access.mode === "full_access" ? { justification: plan.access.justification } : {}),
				...(request.cwd === undefined ? {} : { cwd: request.cwd }),
				...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
				...(plan.expectedTarget === undefined ? {} : { expectedTarget: plan.expectedTarget }),
				...(signal === undefined ? {} : { signal }),
				...(options.abortRun === undefined ? {} : { abortRun: options.abortRun }),
			});
			return finish(result);
		},
	};
}

function finish(result: CommandOperationResult): {
	content: Array<{ type: "text"; text: string }>;
	details: RemoteServerCallDetails;
} {
	const operation = result.operation;
	if (operation.failure) throw toolFailure(operation, operation.failure, result.outputTail);
	const details: RemoteServerCallDetails = {
		operationId: operation.id,
		status: "completed",
		...(operation.exitCode === undefined ? {} : { exitCode: operation.exitCode }),
		...(operation.exitSignal === undefined ? {} : { exitSignal: operation.exitSignal }),
		outputTruncated: operation.outputTruncated,
			sandbox: operation.sandbox,
		...(result.outputTail.length === 0
			? { presentationMessage: backendMessage("ssh.command_completed_no_output") }
			: {}),
	};
	const suffix = operation.outputTruncated ? "\n[Earlier output was truncated; this is the final 64 KiB tail.]" : "";
	return {
		content: [
			{
				type: "text",
				text:
					result.outputTail.length > 0
						? `${result.outputTail}${suffix}`
						: "Command completed successfully with no output.",
			},
		],
		details,
	};
}

function toolFailure(
	operation: CommandOperationResult["operation"],
	failure: SshFailure,
	outputTail: string,
): AgentToolError<RemoteServerCallDetails> {
	const output = outputTail.length > 0 ? `\nRemote output tail:\n${outputTail}` : "";
	const presentationMessage =
		descriptorForPublicFailure(failure.code, failure.message) ?? backendMessage("ssh.unexpected_internal_error");
	const presentationContentSuffix = [
		`\nError code: ${failure.code}`,
		`\nCategory: ${failure.category}`,
		`\nPhase: ${failure.phase}`,
		`\nRetryable: ${failure.retryable}`,
		output,
	].join("");
	return new AgentToolError({
		message: failure.message,
		content: [{ type: "text", text: `${formatFailure(failure)}${output}` }],
		details: {
			operationId: operation.id,
			status: statusForFailure(failure),
			failure,
			...(operation.exitCode === undefined ? {} : { exitCode: operation.exitCode }),
			...(operation.exitSignal === undefined ? {} : { exitSignal: operation.exitSignal }),
			outputTruncated: operation.outputTruncated,
			sandbox: operation.sandbox,
			presentationMessage,
			presentationContentSuffix,
		},
		terminate: failure.code === "guard_blocked",
	});
}

function formatFailure(failure: SshFailure): string {
	return [
		failure.message,
		`Error code: ${failure.code}`,
		`Category: ${failure.category}`,
		`Phase: ${failure.phase}`,
		`Retryable: ${failure.retryable}`,
	].join("\n");
}

function statusForFailure(failure: SshFailure): Exclude<RemoteServerCallStatus, "completed"> {
	if (failure.code === "guard_blocked") return "blocked";
	if (failure.code === "execution_result_uncertain") return "uncertain";
	if (
		failure.code === "execution_cancelled" ||
		failure.code === "cancelled_before_dispatch" ||
		failure.code === "queue_timeout"
	)
		return "cancelled";
	return "failed";
}
