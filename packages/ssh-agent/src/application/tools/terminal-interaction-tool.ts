import { sandboxFactRoots } from "../../domain/sandbox-writable-roots.ts";
import { type AgentTool, AgentToolError } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import {
	TerminalError,
	type TerminalSandboxFacts,
	type TerminalInteractionRequestAction,
	type TerminalObservationExpectation,
} from "../../domain/terminal.ts";
import { backendMessage } from "../../i18n/message.ts";
import { descriptorForPublicFailure } from "../../i18n/public-error.ts";
import type {
	TerminalInteractionResult,
	TerminalInteractionService,
} from "../services/terminal-interaction-service.ts";
import type { ToolUpdateDetails } from "../tool-update-protocol.ts";
import { isToolArguments, toolRequestError, withToolAvailability,
	type PreparedToolAuthorization, type ToolAuthorizationInput } from "./tool-authorization.ts";

const expectation = Type.Union([Type.Literal("finite"), Type.Literal("interactive"), Type.Literal("streaming")]);

export const terminalInteractionParameters = Type.Object(
	{
		action: Type.Union([Type.Literal("submit"), Type.Literal("key"), Type.Literal("observe")], {
			description: "submit writes complete input and Enter; key sends CTRL_C; observe writes nothing",
		}),
		input: Type.Optional(Type.String({
			minLength: 1, description: "Required only for submit; omit for key and observe; omit the final Enter key",
		})),
		key: Type.Optional(Type.Literal("CTRL_C", {
			description: "Required only when action is key; omit for submit and observe",
		})),
		expectation,
	},
	{ additionalProperties: false },
);

export type TerminalInteractionParameters = Static<typeof terminalInteractionParameters>;

export interface TerminalInteractionDetails extends ToolUpdateDetails {
	readonly interactionId: string;
	readonly observationId: string;
	readonly terminalSessionId: string;
	readonly status: "completed" | "failed";
	readonly expectation: TerminalObservationExpectation;
	readonly observationKind: "transcript" | "screen";
	readonly boundaryReason: string;
	readonly startSequence: number;
	readonly endSequence: number;
	readonly truncated: boolean;
	readonly sandbox?: TerminalSandboxFacts;
}

export const terminalInteractionDefinition = {
	name: "terminal_interaction",
	label: "Terminal interaction",
	description:
		"Interact with the current long-lived remote PTY. Submit complete input, send CTRL_C, or observe output. Observation boundaries do not prove remote process completion.",
	parameters: terminalInteractionParameters,
};

export function restrictTerminalWorkflow(tool: AgentTool, deploymentRun: boolean): AgentTool {
	return withToolAvailability(tool, (args) => {
		if (deploymentRun && isToolArguments(args) && args.action === "key")
			throw toolRequestError("Terminal control keys are unavailable during deployment");
	});
}

export async function prepareTerminalAuthorization(input: ToolAuthorizationInput, options: {
	autoApprove(): Promise<boolean>;
	interactions: Pick<TerminalInteractionService, "preflightSubmit" | "approve" | "reject">;
}): Promise<PreparedToolAuthorization> {
	if (!isToolArguments(input.args) ||
		(input.args.expectation !== "finite" && input.args.expectation !== "interactive" && input.args.expectation !== "streaming"))
		throw toolRequestError("terminal_interaction parameters are invalid");
	if (input.run.terminalSessionId === null)
		throw new Error("Terminal-mode Chat Run is missing its TerminalSession binding");
	const params = input.args as TerminalInteractionParameters;
	const action = terminalInteractionAction(params);
	if (action.type !== "submit") return { kind: "allow" };
	const autoApprove = await options.autoApprove();
	const decision = await options.interactions.preflightSubmit({
		sessionId: input.run.sessionId, terminalSessionId: input.run.terminalSessionId,
		agentRunId: input.run.id, toolCallId: input.toolCallId, action, expectation: params.expectation,
	}, !autoApprove);
	if (!decision.allowed) return { kind: "block", block: true, terminate: true,
		reason: decision.matchedRule?.reason ?? "Command blocked by Workspace Guard" };
	return { kind: "approval", autoApprove, onDecision: (approved) => {
		if (approved) options.interactions.approve(input.run.id, input.toolCallId);
		else options.interactions.reject(input.run.id, input.toolCallId);
	} };
}

export function createTerminalInteractionTool(options: {
	readonly sessionId: string;
	readonly terminalSessionId: string;
	readonly agentRunId: string;
	readonly interactions: TerminalInteractionService;
	readonly sandbox: TerminalSandboxFacts;
}): AgentTool<typeof terminalInteractionParameters, TerminalInteractionDetails> {
	return {
		...terminalInteractionDefinition,
		description: `${terminalInteractionDefinition.description} Current session: ${sandboxSummary(options.sandbox)}`,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal) => {
			try {
				const result = await options.interactions.execute(
					{
						sessionId: options.sessionId,
						terminalSessionId: options.terminalSessionId,
						agentRunId: options.agentRunId,
						toolCallId,
						action: terminalInteractionAction(params),
						expectation: params.expectation,
					},
					signal,
				);
				await options.interactions.markDelivered(result);
				return toolResult(result, options.sandbox);
			} catch (error) {
				const presentationMessage = terminalFailureMessage(error);
				throw new AgentToolError({
					message: error instanceof Error ? error.message : "Terminal interaction failed",
					content: [
						{ type: "text", text: error instanceof Error ? error.message : "Terminal interaction failed" },
						{ type: "text", text: sandboxSummary(options.sandbox) },
					],
					details: {
						interactionId: "unknown",
						observationId: "unknown",
						terminalSessionId: options.terminalSessionId,
						status: "failed",
						expectation: params.expectation,
						observationKind: params.expectation === "streaming" ? "screen" : "transcript",
						boundaryReason: "failed",
						startSequence: 0,
						endSequence: 0,
						truncated: false,
						sandbox: options.sandbox,
						presentationMessage,
						presentationContentSuffix: `\n${sandboxSummary(options.sandbox)}`,
					},
					terminate: false,
				});
			}
		},
	};
}

export function terminalInteractionAction(params: TerminalInteractionParameters): TerminalInteractionRequestAction {
	if (params.action === "submit") {
		if (params.key !== undefined) {
			throw toolRequestError(
				'Contradictory terminal_interaction parameters: action="submit" does not accept key. ' +
				'To submit input, omit key. No terminal input was sent. Regenerate the tool call.',
			);
		}
		if (typeof params.input !== "string" || params.input.length === 0) {
			throw toolRequestError("Terminal submit requires a non-empty input");
		}
		return { type: "submit", input: params.input };
	}
	if (params.action === "key") {
		if (params.input !== undefined) {
			throw toolRequestError(
				'Contradictory terminal_interaction parameters: action="key" does not accept input. ' +
				'To submit input, use action="submit" and omit key; to send CTRL_C, omit input. ' +
				'No terminal input was sent. Regenerate the tool call.',
			);
		}
		if (params.key !== "CTRL_C") throw toolRequestError("Terminal key action requires key CTRL_C");
		return { type: "key", key: params.key };
	}
	if (params.action === "observe") {
		if (params.input !== undefined || params.key !== undefined) {
			throw toolRequestError(
				'Contradictory terminal_interaction parameters: action="observe" does not accept input or key. ' +
				'To observe output, omit both; to submit input, use action="submit" and omit key; ' +
				'to send CTRL_C, use action="key" and omit input. No terminal input was sent. Regenerate the tool call.',
			);
		}
		return { type: "observe" };
	}
	throw toolRequestError("terminal_interaction parameters are invalid");
}

function toolResult(result: TerminalInteractionResult, sandbox: TerminalSandboxFacts): {
	content: Array<{ type: "text"; text: string }>;
	readonly details: TerminalInteractionDetails;
} {
	const observation = result.observation;
	const hasObservationText = observation.agentViewText.length > 0;
	const text = hasObservationText
		? observation.agentViewText
		: "No terminal text was observed before this observation boundary.";
	return {
		content: [{ type: "text", text }, { type: "text", text: sandboxSummary(sandbox) }],
		details: {
			interactionId: result.interaction.id,
			observationId: observation.id,
			terminalSessionId: observation.terminalSessionId,
			status: "completed",
			expectation: result.interaction.expectation,
			observationKind: observation.kind,
			boundaryReason: observation.boundaryReason,
			startSequence: observation.startSequence,
			endSequence: observation.endSequence,
			truncated: observation.truncated,
			sandbox,
			...(hasObservationText ? {} : { presentationMessage: backendMessage("terminal.no_observation_text"), presentationContentSuffix: `\n${sandboxSummary(sandbox)}` }),
		},
	};
}

function sandboxSummary(sandbox: TerminalSandboxFacts): string {
	if (sandbox.mode === "workspace_write") return sandbox.backend === "landlock"
		? `Terminal sandbox: Landlock ABI ${sandbox.abi}; writable roots ${sandboxFactRoots(sandbox).join(", ")}.`
		: `Terminal sandbox: Bubblewrap ${sandbox.bubblewrapVersion}; writable roots ${sandboxFactRoots(sandbox).join(", ")}.`;
	return "source" in sandbox
		? sandbox.source === "session_setting"
			? "Terminal sandbox: disabled by the user for this Session; SSH account permissions apply without filesystem confinement."
			: "Terminal sandbox: Landlock unavailable; SSH account permissions apply without filesystem confinement."
		: `Terminal sandbox: Full Access confirmed ${new Date(sandbox.approvedAt).toISOString()}.`;
}

function terminalFailureMessage(error: unknown) {
	if (error instanceof TerminalError) {
		return descriptorForPublicFailure(error.code, error.message) ?? backendMessage("terminal.operation_failed");
	}
	if (error instanceof SshAgentError) {
		return (
			descriptorForPublicFailure(error.failure.code, error.failure.message) ??
			backendMessage("terminal.operation_failed")
		);
	}
	return backendMessage("terminal.operation_failed");
}
