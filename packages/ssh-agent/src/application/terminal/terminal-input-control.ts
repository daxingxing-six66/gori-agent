import { createHash } from "node:crypto";
import type { TerminalInputControl, TerminalHumanInputRequest } from "../../domain/terminal-human.ts";
import { TerminalError } from "../../domain/terminal.ts";
import { TERMINAL_DEFAULTS } from "./terminal-defaults.ts";

/** Mutated only inside the owning Actor's queue. Input digests never leave memory. */
export class TerminalInputArbiter {
	#view: TerminalInputControl = { mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 };
	#lastInput: { sequence: number; digest: string } | null = null;
	#observeRequired = false;

	get view(): TerminalInputControl { return this.#view; }

	claim(attachmentId: string): void {
		if (this.#view.mode === "agent") return;
		if (this.#view.attachmentId !== attachmentId) this.#change("human", attachmentId, null);
	}

	release(attachmentId: string): void {
		if (this.#view.attachmentId === attachmentId) this.#change("idle", null, null);
	}

	bind(runId: string, observeRequired: boolean): void {
		if (this.#view.mode === "agent" && this.#view.agentRunId !== runId)
			throw new TerminalError("terminal_interaction_busy", "Another Agent Run owns the terminal", { status: 409 });
		if (this.#view.agentRunId === runId) return;
		this.#change("agent", null, runId);
		this.#observeRequired = observeRequired;
	}

	unbind(runId: string): void {
		if (this.#view.agentRunId === runId) this.#change("idle", null, null);
	}

	requireAgent(runId: string, writing = false): void {
		if (this.#view.mode !== "agent" || this.#view.agentRunId !== runId)
			throw new TerminalError("terminal_control_conflict", "This Agent Run does not own terminal input", { status: 409 });
		if (writing && this.#observeRequired)
			throw new TerminalError("terminal_observe_required", "Human activity changed the terminal. Call observe and receive its result before sending input. No input was sent.", { status: 409 });
	}

	observed(runId: string): void { this.requireAgent(runId); this.#observeRequired = false; }

	/** Returns false for an exact retry of the last acknowledged batch. */
	accept(terminalId: string, attachmentId: string, request: TerminalHumanInputRequest): boolean {
		if (request.terminalSessionId !== terminalId || this.#view.mode !== "human" ||
			this.#view.attachmentId !== attachmentId || this.#view.epoch !== request.controlEpoch)
			throw new TerminalError("terminal_control_conflict", "Terminal input ownership changed; input was not sent", { status: 409 });
		if (!Number.isSafeInteger(request.inputSequence) || request.inputSequence < 1 ||
			request.bytes.byteLength === 0 || request.bytes.byteLength > TERMINAL_DEFAULTS.input.maxBytes)
			throw new TerminalError("terminal_input_invalid", "Terminal input batch is empty, invalid or too large");
		const digest = createHash("sha256").update(request.bytes).digest("hex");
		if (this.#lastInput?.sequence === request.inputSequence && this.#lastInput.digest === digest) return false;
		if (request.inputSequence !== (this.#lastInput?.sequence ?? 0) + 1)
			throw new TerminalError("terminal_input_out_of_order", "Terminal input batch is out of order; input was not sent", { status: 409 });
		this.#lastInput = { sequence: request.inputSequence, digest };
		return true;
	}

	#change(mode: TerminalInputControl["mode"], attachmentId: string | null, agentRunId: string | null): void {
		this.#view = { mode, attachmentId, agentRunId, epoch: this.#view.epoch + 1 };
		this.#lastInput = null;
	}
}
