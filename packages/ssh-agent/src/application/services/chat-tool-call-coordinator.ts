import type { BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { ChatRun } from "../../domain/chat.ts";
import { type BackendMessageDescriptor, backendMessage } from "../../i18n/message.ts";
import type { ApprovalDecision, ChatApprovalService } from "./chat-approval-service.ts";
import type { ChatToolAuthorizationPolicy } from "./chat-tool-authorization-policy.ts";

type ToolAuthorizationPolicy = Pick<
	ChatToolAuthorizationPolicy,
	"prepare" | "recordDecision" | "shouldAutoApproveSftpOverwrite"
>;
type ApprovalService = Pick<ChatApprovalService, "request">;

export class ChatToolCallCoordinator {
	readonly #authorization: ToolAuthorizationPolicy;
	readonly #approvals: ApprovalService;
	readonly #assistantMessageIds = new Map<string, Map<string, string>>();

	constructor(options: { authorization: ToolAuthorizationPolicy; approvals: ApprovalService }) {
		this.#authorization = options.authorization;
		this.#approvals = options.approvals;
	}

	async beforeToolCall(
		input: {
			run: ChatRun;
			assistantMessageId: string;
			toolCallId: string;
			toolName: string;
			args: unknown;
			onApprovalRejection(): void;
		},
		signal?: AbortSignal,
	): Promise<BeforeToolCallResult | undefined> {
		const prepared = await this.#authorization.prepare({
			run: input.run,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			args: input.args,
		});
		if (prepared.kind === "allow") return undefined;
		if (prepared.kind === "defer_to_tool") {
			const runContexts = this.#assistantMessageIds.get(input.run.id) ?? new Map<string, string>();
			runContexts.set(input.toolCallId, input.assistantMessageId);
			this.#assistantMessageIds.set(input.run.id, runContexts);
			return undefined;
		}
		if (prepared.kind === "block") return prepared;
		const decision = await this.#approvals.request(
			{
				run: input.run,
				assistantMessageId: input.assistantMessageId,
				toolCallId: input.toolCallId,
				toolName: input.toolName,
				description: `Tool ${input.toolName} requests permission to execute. Continue?`,
				descriptionMessage: toolExecutionApprovalMessage(input.toolName),
				autoApprove: prepared.autoApprove,
			},
			signal,
		);
		this.#authorization.recordDecision(prepared, decision.approved);
		if (decision.approved) return undefined;
		if (decision.reason === "user_rejected" || decision.reason === "timeout") input.onApprovalRejection();
		return rejectionResult(decision);
	}

	async requestSftpOverwriteApproval(
		input: {
			run: ChatRun;
			toolName: "sftp_upload" | "sftp_download";
			toolCallId: string;
			description: string;
			descriptionMessage?: BackendMessageDescriptor;
			onApprovalRejection(): void;
		},
		signal: AbortSignal,
	): Promise<ApprovalDecision> {
		const runContexts = this.#assistantMessageIds.get(input.run.id);
		if (!runContexts) throw new Error("SFTP Tool approval context is unavailable");
		const assistantMessageId = runContexts.get(input.toolCallId);
		if (!assistantMessageId) throw new Error("SFTP Tool approval context is unavailable");
		try {
			const autoApprove = await this.#authorization.shouldAutoApproveSftpOverwrite(input.run.sessionId);
			if (signal.aborted) return { approved: false, reason: "run_cancelled" };
			const decision = await this.#approvals.request(
				{
					run: input.run,
					assistantMessageId,
					toolCallId: input.toolCallId,
					toolName: input.toolName,
					description: input.description,
					...(input.descriptionMessage === undefined ? {} : { descriptionMessage: input.descriptionMessage }),
					autoApprove,
				},
				signal,
			);
			if (!decision.approved && (decision.reason === "user_rejected" || decision.reason === "timeout")) {
				input.onApprovalRejection();
			}
			return decision;
		} finally {
			runContexts.delete(input.toolCallId);
			if (runContexts.size === 0) this.#assistantMessageIds.delete(input.run.id);
		}
	}

	clearRun(runId: string): void {
		this.#assistantMessageIds.delete(runId);
	}

	close(): void {
		this.#assistantMessageIds.clear();
	}
}

function toolExecutionApprovalMessage(toolName: string): BackendMessageDescriptor {
	if (
		toolName === "read" ||
		toolName === "write" ||
		toolName === "bash" ||
		toolName === "remote_server_call" ||
		toolName === "terminal_interaction" ||
		toolName === "sftp_upload" ||
		toolName === "sftp_download"
	) {
		return backendMessage(`approval.tool_execution.${toolName}`);
	}
	return backendMessage("approval.tool_execution", { toolName });
}

function rejectionResult(decision: Extract<ApprovalDecision, { approved: false }>): BeforeToolCallResult {
	const reason =
		decision.reason === "user_rejected"
			? "Tool execution was rejected by the user. The tool was not executed."
			: decision.reason === "timeout"
				? "Tool approval timed out. The tool was not executed."
				: decision.reason === "run_cancelled"
					? "Tool execution was cancelled because the Chat Run was cancelled."
					: "Tool execution was not performed because the server restarted while approval was pending.";
	return {
		block: true,
		reason,
		...((decision.reason === "user_rejected" || decision.reason === "timeout") && { terminate: true }),
	};
}
