import type { TerminalHumanActivity, TerminalHumanHandoffReceipt } from "../../domain/terminal-human.ts";
import type { TerminalCanonicalCapture } from "./terminal-session-actor.ts";

/** Actor-local evidence. Content versions and delivery receipts never enter model messages. */
export class TerminalHumanHandoffObservation {
	#frozen: { activity: TerminalHumanActivity; capture: TerminalCanonicalCapture; contentVersion: number } | null = null;
	#deliveredRun: string | null = null;
	#settled = false;

	freeze(activity: TerminalHumanActivity | null, capture: TerminalCanonicalCapture, contentVersion: number): void {
		this.#frozen = activity?.endReason === "handoff" ? { activity, capture, contentVersion } : null;
		this.#deliveredRun = null;
		this.#settled = false;
	}

	acknowledge(receipt: TerminalHumanHandoffReceipt): TerminalCanonicalCapture | null {
		const frozen = this.#frozen, activity = frozen?.activity;
		if (!frozen || !activity || this.#settled || activity.id !== receipt.activityId ||
			activity.sessionId !== receipt.sessionId || activity.terminalSessionId !== receipt.terminalSessionId ||
			activity.endSequence !== receipt.endSequence || activity.screenTruncated !== false || activity.writeStatus !== "written") return null;
		this.#deliveredRun = receipt.agentRunId;
		return frozen.capture;
	}

	reusable(runId: string, contentVersion: number): boolean {
		return !this.#settled && this.#deliveredRun === runId && this.#frozen?.contentVersion === contentVersion;
	}

	observed(): void { this.#settled = true; this.#deliveredRun = null; }
	release(): void { this.#deliveredRun = null; }
}
