import { Buffer } from "node:buffer";
import type { TerminalBoundaryReason, TerminalObservationExpectation } from "../../domain/terminal.ts";
import { TERMINAL_DEFAULTS } from "./terminal-defaults.ts";
import type { TerminalSequencedEvent } from "./terminal-replay-ring.ts";
import type { TerminalCanonicalCapture, TerminalSessionActor } from "./terminal-session-actor.ts";

export interface CapturedTerminalObservation {
	readonly sequence: number;
	readonly geometry: { readonly rows: number; readonly cols: number };
	readonly kind: "transcript" | "screen";
	readonly boundaryReason: TerminalBoundaryReason;
	readonly text: string;
	readonly rawByteCount: number;
	readonly truncated: boolean;
}

export class TerminalObservationCancelledError extends Error {
	constructor() {
		super("TerminalInteraction was cancelled with the Chat Run");
		this.name = "TerminalObservationCancelledError";
	}
}

export async function captureTerminalObservation(
	actor: TerminalSessionActor,
	baseline: TerminalCanonicalCapture,
	expectation: TerminalObservationExpectation,
	signal?: AbortSignal,
): Promise<CapturedTerminalObservation> {
	let rawByteCount = 0;
	let quietTimer: ReturnType<typeof setTimeout> | undefined;
	let promptTimer: ReturnType<typeof setTimeout> | undefined;
	let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
	let maximumTimer: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	let resolveBoundary: (reason: TerminalBoundaryReason) => void = () => undefined;
	let rejectBoundary: (error: unknown) => void = () => undefined;
	const boundary = new Promise<TerminalBoundaryReason>((resolve, reject) => {
		resolveBoundary = resolve;
		rejectBoundary = reject;
	});
	const settle = (reason: TerminalBoundaryReason): void => {
		if (settled) return;
		settled = true;
		resolveBoundary(reason);
	};
	const checkPrompt = (): void => {
		void actor.captureCanonical().then((capture) => {
			if (hasPrompt(capture.screenText)) settle("prompt");
		});
	};
	const onEvent = (event: TerminalSequencedEvent): void => {
		if (event.sequence <= baseline.sequence) return;
		if (
			event.type === "terminal.status" &&
			(event.newStatus === "closed" || event.newStatus === "lost" || event.newStatus === "failed")
		) {
			settle("channel_closed");
			return;
		}
		if (event.type !== "terminal.output") return;
		rawByteCount += event.bytes.byteLength;
		if (rawByteCount >= TERMINAL_DEFAULTS.observation.maxRawBytes) {
			settle("output_limit");
			return;
		}
		if (expectation === "streaming") return;
		if (promptTimer !== undefined) clearTimeout(promptTimer);
		promptTimer = setTimeout(checkPrompt, TERMINAL_DEFAULTS.observation.promptSettleMs);
		if (quietTimer !== undefined) clearTimeout(quietTimer);
		quietTimer = setTimeout(
			() => settle("quiet"),
			expectation === "finite"
				? TERMINAL_DEFAULTS.observation.finiteQuietMs
				: TERMINAL_DEFAULTS.observation.interactiveQuietMs,
		);
	};
	const eventConnection = await actor.connectObservationEvents(baseline.sequence, onEvent);
	for (const event of eventConnection.replay.events) onEvent(event);
	const abort = (): void => rejectBoundary(new TerminalObservationCancelledError());
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	if (expectation === "streaming") {
		snapshotTimer = setTimeout(() => settle("snapshot"), TERMINAL_DEFAULTS.observation.streamingSnapshotMs);
	}
	maximumTimer = setTimeout(
		() => settle("timeout"),
		expectation === "finite"
			? TERMINAL_DEFAULTS.observation.finiteMaxWaitMs
			: expectation === "interactive"
				? TERMINAL_DEFAULTS.observation.interactiveMaxWaitMs
				: TERMINAL_DEFAULTS.observation.streamingMaxWaitMs,
	);
	try {
		const boundaryReason = await boundary;
		const capture = await actor.captureCanonical();
		const kind = expectation === "streaming" ? "screen" : "transcript";
		const source = kind === "screen" ? capture.screenText : transcriptAfter(baseline.allText, capture.allText);
		const limited = limitAgentView(source);
		return {
			sequence: capture.sequence,
			geometry: capture.geometry,
			kind,
			boundaryReason,
			text: limited.text,
			rawByteCount,
			truncated: limited.truncated,
		};
	} finally {
		eventConnection.disconnect();
		if (quietTimer !== undefined) clearTimeout(quietTimer);
		if (promptTimer !== undefined) clearTimeout(promptTimer);
		if (snapshotTimer !== undefined) clearTimeout(snapshotTimer);
		if (maximumTimer !== undefined) clearTimeout(maximumTimer);
		signal?.removeEventListener("abort", abort);
	}
}

function transcriptAfter(before: string, after: string): string {
	return after.startsWith(before) ? after.slice(before.length).replace(/^\n+/, "") : after;
}

function limitAgentView(text: string): { readonly text: string; readonly truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= TERMINAL_DEFAULTS.observation.maxAgentViewBytes) return { text, truncated: false };
	let start = bytes.byteLength - TERMINAL_DEFAULTS.observation.maxAgentViewBytes;
	while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
	return { text: `[Earlier terminal output omitted]\n${bytes.subarray(start).toString("utf8")}`, truncated: true };
}

function hasPrompt(screen: string): boolean {
	const line = screen.trimEnd().split("\n").at(-1) ?? "";
	return /(?:[$#>]\s*|\[[^\]]+\]\$\s*|arthas>\s*)$/i.test(line);
}
