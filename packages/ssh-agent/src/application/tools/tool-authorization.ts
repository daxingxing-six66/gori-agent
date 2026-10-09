import { type AgentTool, AgentToolError } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type { ChatRun } from "../../domain/chat.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import { TerminalError } from "../../domain/terminal.ts";
import type { BackendMessageDescriptor } from "../../i18n/message.ts";
import type { FullAccessRequest } from "../services/remote-sandbox-approval-store.ts";

export interface ToolAuthorizationInput {
	run: ChatRun;
	toolCallId: string;
	toolName: string;
	args: unknown;
	signal?: AbortSignal;
}

export type PreparedToolAuthorization =
	| { readonly kind: "allow" }
	| { readonly kind: "defer_to_tool" }
	| { readonly kind: "block"; readonly block: true; readonly reason: string; readonly terminate: boolean }
	| {
			readonly kind: "approval";
			readonly autoApprove: boolean;
			readonly executionContext?: unknown;
			readonly remoteFullAccess?: FullAccessRequest;
			readonly remoteFullAccessTarget?: SshTargetSnapshot;
			readonly approvalToolName?: string;
			readonly descriptionMessage?: BackendMessageDescriptor;
			readonly onDecision?: (approved: boolean) => void;
	  };

export function toolRequestError(message: string): AgentToolError {
	return new AgentToolError({ message, content: [{ type: "text", text: message }], details: {}, terminate: false });
}

/** Only known request errors are recoverable. Storage, probe and programming failures stay fatal. */
export function authorizationFailure(error: unknown): Extract<PreparedToolAuthorization, { kind: "block" }> | undefined {
	if (error instanceof AgentToolError) {
		return { kind: "block", block: true, reason: error.message, terminate: error.terminate === true };
	}
	if (
		(error instanceof SshAgentError && error.failure.code === "invalid_request") ||
		(error instanceof TerminalError && (error.code === "terminal_input_invalid" || error.code === "terminal_input_too_large"))
	) {
		return { kind: "block", block: true, reason: error.message, terminate: false };
	}
	return undefined;
}

/** Check before authorization in the Agent loop, and again for callers executing a Tool directly. */
export function withToolAvailability<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
	check: (args: unknown) => void,
): AgentTool<TParameters, TDetails> {
	return {
		...tool,
		prepareArguments: (args) => {
			check(args);
			return tool.prepareArguments ? tool.prepareArguments(args) : args as Static<TParameters>;
		},
		execute: async (id, params, signal, update, executionContext) => {
			check(params);
			return tool.execute(id, params, signal, update,
				...(executionContext === undefined ? [] : [executionContext]));
		},
	};
}

export function unavailableTool(
	definition: Pick<AgentTool, "name" | "description" | "parameters">,
	context = "current server interaction mode",
): AgentTool {
	const fail = () => {
		throw toolRequestError(`${definition.name} is unavailable in the ${context}`);
	};
	return { ...definition, label: definition.name, prepareArguments: fail, execute: async () => fail() };
}

export function isToolArguments(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
