import { type AgentTool, AgentToolError } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { SessionId } from "../../domain/ids.ts";
import type { SshFailure } from "../../domain/ssh-failure.ts";
import { backendMessage } from "../../i18n/message.ts";
import { descriptorForPublicFailure } from "../../i18n/public-error.ts";
import {
	COMMAND_EXECUTION_DEFAULTS,
	type CommandOperationResult,
	type CommandOperationService,
} from "../services/command-operation-service.ts";
import type { ToolUpdateDetails } from "../tool-update-protocol.ts";

const remoteServerCallParameters = Type.Object({
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
}

export const remoteServerCallDefinition = {
	name: "remote_server_call",
	label: "Remote server command",
	description:
		"Execute a shell command in the current SSH Workspace. The Session determines the server and credential; never ask for connection details.",
	parameters: remoteServerCallParameters,
};

export function createRemoteServerCallTool(options: {
	sessionId: SessionId;
	operations: CommandOperationService;
	abortRun?: () => void;
}): AgentTool<typeof remoteServerCallParameters, RemoteServerCallDetails> {
	return {
		...remoteServerCallDefinition,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal) => {
			const result = await options.operations.submit({
				toolCallId,
				sessionId: options.sessionId,
				command: params.command,
				...(params.cwd === undefined ? {} : { cwd: params.cwd }),
				...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
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
