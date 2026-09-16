import { isRecord, parseTerminalEnvelope, type TerminalSseEnvelope } from "@/features/terminal/model/terminal";
import type { SupportedLocale } from "@/features/i18n/model/locale";
import { apiUrlWithLocale } from "@/shared/api/client";

const EVENT_TYPES = [
	"terminal.stream.ready",
	"terminal.status",
	"terminal.output",
	"terminal.resized",
	"terminal.resize_owner_changed",
	"terminal.input",
	"terminal.observation.captured",
	"terminal.observation.delivered",
	"terminal.observation.processing",
	"terminal.observation.finished",
	"terminal.resync_required",
] as const;

export class TerminalEventStream {
	readonly #source: EventSource;
	readonly #listeners = new Set<(event: TerminalSseEnvelope) => void>();

	constructor(sessionId: string, attachmentId: string, afterSequence: number, locale: SupportedLocale, onError?: () => void) {
		const query = new URLSearchParams({ afterSequence: String(afterSequence) });
		this.#source = new EventSource(
			apiUrlWithLocale(
				`/api/sessions/${encodeURIComponent(sessionId)}/terminal/attachments/${encodeURIComponent(attachmentId)}/events?${query}`,
				locale,
			),
		);
		for (const type of EVENT_TYPES) {
			this.#source.addEventListener(type, (event) => {
				if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
				let value: unknown;
				try {
					value = JSON.parse(event.data) as unknown;
				} catch {
					return;
				}
				const envelope = parseTerminalEnvelope(value, type);
				if (envelope) for (const listener of this.#listeners) listener(envelope);
			});
		}
		if (onError) this.#source.addEventListener("error", onError);
	}

	subscribe(listener: (event: TerminalSseEnvelope) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): void {
		this.#source.close();
		this.#listeners.clear();
	}
}

export function stringData(data: Record<string, unknown>, key: string): string | null {
	return typeof data[key] === "string" ? data[key] : null;
}

export function integerData(data: Record<string, unknown>, key: string): number | null {
	return Number.isSafeInteger(data[key]) ? Number(data[key]) : null;
}

export function isStreamReadyData(data: unknown): data is { replayedThroughSequence: number } {
	return isRecord(data) && Number.isSafeInteger(data.replayedThroughSequence);
}
