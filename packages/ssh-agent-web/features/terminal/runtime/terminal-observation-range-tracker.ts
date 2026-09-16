import type { IMarker, Terminal } from "@xterm/xterm";
import type { TerminalObservationView } from "@/features/terminal/model/terminal";
import {
	findObservationBufferRange,
	hasMeaningfulObservationText,
	ObservationSequenceCheckpoints,
	projectObservationViewportRange,
	snapshotObservationViewportRange,
	type ObservationViewportRange,
} from "@/features/terminal/model/terminal-observation-range";
import { TERMINAL_UI_DEFAULTS } from "@/features/terminal/model/terminal-ui-defaults";

interface ObservationRangeAnchor {
	readonly observationId: string;
	startMarker: IMarker | null;
	endMarker: IMarker | null;
	capturedAt: number;
	fallbackToSnapshot: boolean;
	content: "unknown" | "valid" | "empty";
}

export interface ObservationRangePresentation {
	readonly capturedAt: number;
	readonly range: ObservationViewportRange;
}

export class TerminalObservationRangeTracker {
	readonly #terminal: Terminal;
	readonly #checkpoints = new ObservationSequenceCheckpoints(
		TERMINAL_UI_DEFAULTS.observationCheckpointRetentionMs,
		TERMINAL_UI_DEFAULTS.observationCheckpointCapacity,
	);
	readonly #inputMarkers = new Map<string, IMarker>();
	readonly #anchors = new Map<string, ObservationRangeAnchor>();

	constructor(terminal: Terminal) {
		this.#terminal = terminal;
	}

	recordCheckpoint(sequence: number, recordedAt = Date.now()): void {
		const marker = this.#terminal.registerMarker(0);
		if (marker) this.#checkpoints.record(sequence, recordedAt, marker);
	}

	recordInput(interactionId: string): void {
		const marker = this.#terminal.registerMarker(0);
		if (!marker) return;
		this.#inputMarkers.get(interactionId)?.dispose();
		this.#inputMarkers.set(interactionId, marker);
	}

	recordCaptured(observationId: string, interactionId: string | null, capturedAt: number): void {
		const previous = this.#anchors.get(observationId);
		if (previous) disposeAnchor(previous);
		const startMarker = interactionId === null ? null : this.#inputMarkers.get(interactionId) ?? null;
		if (interactionId !== null) this.#inputMarkers.delete(interactionId);
		this.#anchors.set(observationId, {
			observationId,
			startMarker,
			endMarker: this.#terminal.registerMarker(0) ?? null,
			capturedAt,
			fallbackToSnapshot: this.#terminal.buffer.active.type === "alternate",
			content: "unknown",
		});
	}

	resolveObservation(observation: TerminalObservationView, createIfMissing = false): void {
		let anchor = this.#anchors.get(observation.id);
		if (!anchor) {
			if (!createIfMissing) return;
			anchor = {
				observationId: observation.id,
				startMarker: null,
				endMarker: null,
				capturedAt: observation.capturedAt,
				fallbackToSnapshot: false,
				content: "unknown",
			};
			this.#anchors.set(observation.id, anchor);
		}
		anchor.capturedAt = observation.capturedAt;
		anchor.content = hasMeaningfulObservationText(observation.agentViewText) ? "valid" : "empty";
		if (anchor.content === "empty") return;
		if (this.#terminal.buffer.active.type === "alternate") {
			anchor.fallbackToSnapshot = true;
			return;
		}
		if (!validMarker(anchor.startMarker)) {
			anchor.startMarker = this.#markerForCheckpoint(observation.startSequence);
		}
		if (!validMarker(anchor.endMarker)) {
			anchor.endMarker = this.#markerForCheckpoint(observation.endSequence);
		}
		if (!validMarker(anchor.startMarker) || !validMarker(anchor.endMarker)) {
			const recovered = findObservationBufferRange(this.#readBufferLines(), observation.agentViewText);
			if (recovered) {
				if (!validMarker(anchor.startMarker)) anchor.startMarker = this.#registerMarkerAtLine(recovered.startLine);
				if (!validMarker(anchor.endMarker)) anchor.endMarker = this.#registerMarkerAtLine(recovered.endLine);
			}
		}
		anchor.fallbackToSnapshot = !validMarker(anchor.startMarker) || !validMarker(anchor.endMarker);
	}

	presentation(observationId: string): ObservationRangePresentation | null {
		const anchor = this.#anchors.get(observationId);
		if (!anchor || anchor.content !== "valid") return null;
		if (
			anchor.fallbackToSnapshot ||
			!validMarker(anchor.startMarker) ||
			!validMarker(anchor.endMarker) ||
			anchor.startMarker.line > anchor.endMarker.line
		) {
			return { capturedAt: anchor.capturedAt, range: snapshotObservationViewportRange() };
		}
		return {
			capturedAt: anchor.capturedAt,
			range: projectObservationViewportRange(
				anchor.startMarker.line,
				anchor.endMarker.line,
				this.#terminal.buffer.active.viewportY,
				this.#terminal.rows,
			),
		};
	}

	disposeObservation(observationId: string): void {
		const anchor = this.#anchors.get(observationId);
		if (!anchor) return;
		disposeAnchor(anchor);
		this.#anchors.delete(observationId);
	}

	dispose(): void {
		this.#checkpoints.dispose();
		for (const marker of this.#inputMarkers.values()) marker.dispose();
		this.#inputMarkers.clear();
		for (const anchor of this.#anchors.values()) disposeAnchor(anchor);
		this.#anchors.clear();
	}

	#markerForCheckpoint(sequence: number): IMarker | null {
		const line = this.#checkpoints.lineAtOrBefore(sequence);
		return line === null ? null : this.#registerMarkerAtLine(line);
	}

	#registerMarkerAtLine(line: number): IMarker | null {
		const buffer = this.#terminal.buffer.active;
		if (buffer.type !== "normal" || line < 0 || line >= buffer.length) return null;
		return this.#terminal.registerMarker(line - (buffer.baseY + buffer.cursorY)) ?? null;
	}

	#readBufferLines(): Array<{ text: string; isWrapped: boolean }> {
		const buffer = this.#terminal.buffer.active;
		const lines: Array<{ text: string; isWrapped: boolean }> = [];
		for (let index = 0; index < buffer.length; index += 1) {
			const line = buffer.getLine(index);
			if (line) lines.push({ text: line.translateToString(true), isWrapped: line.isWrapped });
		}
		return lines;
	}
}

function validMarker(marker: IMarker | null): marker is IMarker {
	return marker !== null && !marker.isDisposed && marker.line >= 0;
}

function disposeAnchor(anchor: ObservationRangeAnchor): void {
	anchor.startMarker?.dispose();
	if (anchor.endMarker !== anchor.startMarker) anchor.endMarker?.dispose();
}
