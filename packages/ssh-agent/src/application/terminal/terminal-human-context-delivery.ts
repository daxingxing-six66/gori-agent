import type { AssistantMessage, AssistantMessageEventStream, Context } from "@earendil-works/pi-ai";
import type { ChatRun } from "../../domain/chat.ts";
import { canonicalRuntimeJson, isRuntimeContextMessage, runtimeContextMessage } from "../../domain/runtime-context.ts";
import type { TerminalHumanHandoffReceipt } from "../../domain/terminal-human.ts";

/** Only the actual request and its successful response can acknowledge a handoff. */
export class TerminalHumanContextDelivery {
	readonly #run: Pick<ChatRun, "id" | "sessionId" | "terminalSessionId">;
	readonly #acknowledge: (receipt: TerminalHumanHandoffReceipt) => Promise<void>;
	#response: Promise<{ message: AssistantMessage; receipt?: TerminalHumanHandoffReceipt } | undefined> | undefined;

	constructor(run: Pick<ChatRun, "id" | "sessionId" | "terminalSessionId">,
		acknowledge: (receipt: TerminalHumanHandoffReceipt) => Promise<void>) {
		this.#run = run;
		this.#acknowledge = acknowledge;
	}

	track(context: Context, stream: AssistantMessageEventStream): AssistantMessageEventStream {
		const receipt = this.#receipt(context);
		this.#response = stream.result().then(message =>
			message.stopReason === "stop" || message.stopReason === "toolUse" ? { message, receipt } : undefined,
			() => undefined);
		return stream;
	}

	async acknowledge(message: AssistantMessage): Promise<void> {
		const response = await this.#response;
		if (response?.message === message && response.receipt) await this.#acknowledge(response.receipt);
	}

	#receipt(context: Context): TerminalHumanHandoffReceipt | undefined {
		const message = [...context.messages].reverse().find(message =>
			isRuntimeContextMessage(message) && message.runtimeContext.channel === "terminal-human");
		if (!message || !isRuntimeContextMessage(message)) return;
		const { version: _version, revision, ...snapshot } = message.runtimeContext;
		const data = snapshot.data;
		if (!snapshot.active || snapshot.scope !== this.#run.sessionId || data.currentTerminal !== true ||
			data.sessionId !== this.#run.sessionId || typeof data.terminalSessionId !== "string" ||
			data.terminalSessionId !== this.#run.terminalSessionId ||
			typeof data.id !== "string" || data.endReason !== "handoff" ||
			typeof data.endSequence !== "number" || !Number.isSafeInteger(data.endSequence) || data.endSequence < 0) return;
		// Metadata alone is insufficient: the provider must receive the matching quoted body too.
		const expected = runtimeContextMessage(snapshot, revision, message.runtimeEventId, message.timestamp);
		if (canonicalRuntimeJson(message.content) !== canonicalRuntimeJson(expected.content)) return;
		return { sessionId: this.#run.sessionId, terminalSessionId: data.terminalSessionId,
			agentRunId: this.#run.id, activityId: data.id, endSequence: data.endSequence };
	}
}
