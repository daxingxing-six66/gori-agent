/** Input ownership is independent of browser geometry ownership. */
export interface TerminalInputControl {
	readonly mode: "idle" | "human" | "agent";
	readonly attachmentId: string | null;
	readonly agentRunId: string | null;
	readonly epoch: number;
}

export interface TerminalHumanInputRequest {
	readonly terminalSessionId: string;
	readonly controlEpoch: number;
	readonly inputSequence: number;
	readonly bytes: Uint8Array;
}

/** Only canonical visible text belongs here. Never store keyboard bytes. */
export interface TerminalHumanActivity {
	readonly id: string;
	readonly sessionId: string;
	readonly terminalSessionId: string;
	readonly startSequence: number;
	readonly endSequence: number;
	readonly inputCount: number;
	readonly inputBytes: number;
	readonly writeStatus: "writing" | "written" | "uncertain";
	readonly transcript: string;
	readonly screenText: string;
	readonly truncated: boolean;
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly finishedAt: number | null;
	readonly endReason: "handoff" | "closed" | "lost" | null;
}
