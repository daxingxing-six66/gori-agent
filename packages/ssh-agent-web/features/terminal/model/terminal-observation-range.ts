export interface ObservationTrackedMarker {
	readonly isDisposed: boolean;
	readonly line: number;
	dispose(): void;
}

export interface ObservationBufferLine {
	readonly isWrapped: boolean;
	readonly text: string;
}

export interface ObservationBufferRange {
	readonly startLine: number;
	readonly endLine: number;
}

export type ObservationViewportPosition = "visible" | "above" | "below" | "covering" | "snapshot";

export interface ObservationViewportRange {
	readonly position: ObservationViewportPosition;
	readonly topPercent: number;
	readonly heightPercent: number;
	readonly showStartRail: boolean;
	readonly showEndRail: boolean;
}

interface ObservationSequenceCheckpoint {
	readonly sequence: number;
	readonly recordedAt: number;
	readonly marker: ObservationTrackedMarker;
}

export class ObservationSequenceCheckpoints {
	readonly #retentionMs: number;
	readonly #capacity: number;
	readonly #entries: ObservationSequenceCheckpoint[] = [];

	constructor(retentionMs: number, capacity: number) {
		this.#retentionMs = retentionMs;
		this.#capacity = capacity;
	}

	record(sequence: number, recordedAt: number, marker: ObservationTrackedMarker): void {
		const previous = this.#entries.at(-1);
		if (previous && sequence <= previous.sequence) {
			marker.dispose();
			return;
		}
		this.#entries.push({ sequence, recordedAt, marker });
		this.prune(recordedAt);
	}

	lineAtOrBefore(sequence: number): number | null {
		for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
			const checkpoint = this.#entries[index];
			if (!checkpoint || checkpoint.sequence > sequence) continue;
			return checkpoint.marker.isDisposed || checkpoint.marker.line < 0 ? null : checkpoint.marker.line;
		}
		return null;
	}

	prune(now: number): void {
		const cutoff = now - this.#retentionMs;
		while (
			this.#entries.length > this.#capacity ||
			(this.#entries.length > 1 && (this.#entries[1]?.recordedAt ?? now) < cutoff)
		) {
			this.#entries.shift()?.marker.dispose();
		}
	}

	dispose(): void {
		for (const checkpoint of this.#entries) checkpoint.marker.dispose();
		this.#entries.length = 0;
	}
}

export function projectObservationViewportRange(
	startLine: number,
	endLine: number,
	viewportY: number,
	rows: number,
): ObservationViewportRange {
	const viewportEnd = viewportY + rows - 1;
	if (endLine < viewportY) return edgeRange("above");
	if (startLine > viewportEnd) return edgeRange("below");
	const visibleStart = Math.max(startLine, viewportY);
	const visibleEnd = Math.min(endLine, viewportEnd);
	const topPercent = ((visibleStart - viewportY) / rows) * 100;
	const bottomPercent = ((visibleEnd - viewportY + 1) / rows) * 100;
	const showStartRail = startLine >= viewportY;
	const showEndRail = endLine <= viewportEnd;
	return {
		position: showStartRail || showEndRail ? "visible" : "covering",
		topPercent,
		heightPercent: Math.max(0, bottomPercent - topPercent),
		showStartRail,
		showEndRail,
	};
}

export function snapshotObservationViewportRange(): ObservationViewportRange {
	return {
		position: "snapshot",
		topPercent: 0,
		heightPercent: 100,
		showStartRail: true,
		showEndRail: true,
	};
}

export function findObservationBufferRange(
	physicalLines: readonly ObservationBufferLine[],
	agentViewText: string,
): ObservationBufferRange | null {
	const logicalLines: Array<{ text: string; startLine: number; endLine: number }> = [];
	for (let index = 0; index < physicalLines.length; index += 1) {
		const line = physicalLines[index];
		if (!line) continue;
		const previous = logicalLines.at(-1);
		if (line.isWrapped && previous) {
			previous.text += line.text;
			previous.endLine = index;
		} else {
			logicalLines.push({ text: line.text, startLine: index, endLine: index });
		}
	}
	for (const line of logicalLines) line.text = line.text.trimEnd();
	const normalizedNeedle = normalizeObservationText(agentViewText);
	if (normalizedNeedle.length === 0 || logicalLines.length === 0) return null;
	const haystack = logicalLines.map((line) => line.text).join("\n");
	const startOffset = haystack.lastIndexOf(normalizedNeedle);
	if (startOffset < 0) return null;
	const endOffset = startOffset + normalizedNeedle.length - 1;
	let offset = 0;
	let startLine: number | null = null;
	let endLine: number | null = null;
	for (const line of logicalLines) {
		const logicalEnd = offset + line.text.length;
		if (startLine === null && startOffset <= logicalEnd) startLine = line.startLine;
		if (endOffset <= logicalEnd) {
			endLine = line.endLine;
			break;
		}
		offset = logicalEnd + 1;
	}
	return startLine === null || endLine === null ? null : { startLine, endLine };
}

export function hasMeaningfulObservationText(agentViewText: string): boolean {
	return normalizeObservationText(agentViewText).trim().length > 0;
}

export function observationFinishedDelay(shownAt: number, now: number, minimumVisibleMs: number): number {
	return Math.max(0, shownAt + minimumVisibleMs - now);
}

function edgeRange(position: "above" | "below"): ObservationViewportRange {
	return {
		position,
		topPercent: position === "above" ? 0 : 100,
		heightPercent: 0,
		showStartRail: false,
		showEndRail: false,
	};
}

function normalizeObservationText(text: string): string {
	const lines = text
		.replace(/^\[Earlier terminal output omitted\]\r?\n/, "")
		.replaceAll("\r\n", "\n")
		.split("\n")
		.map((line) => line.trimEnd());
	while (lines[0] === "") lines.shift();
	while (lines.at(-1) === "") lines.pop();
	return lines.join("\n");
}
