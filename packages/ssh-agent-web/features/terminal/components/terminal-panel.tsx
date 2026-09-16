"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { useLocale } from "@/features/i18n/components/locale-context";
import { useTheme } from "@/features/theme/components/theme-context";
import { terminalApi } from "@/features/terminal/api/terminal-api";
import { TerminalObservationMask } from "@/features/terminal/components/terminal-observation-mask";
import { TerminalTimeline } from "@/features/terminal/components/terminal-timeline";
import { TERMINAL_UI_DEFAULTS } from "@/features/terminal/model/terminal-ui-defaults";
import type { TerminalSseEnvelope, TerminalStatusResponse } from "@/features/terminal/model/terminal";
import { applyTerminalTheme, terminalTheme } from "@/features/terminal/model/terminal-theme";
import {
	isObservationMaskStateEvent,
	reduceObservationMaskState,
	restoreObservationMaskState,
	type ObservationMaskState,
} from "@/features/terminal/model/terminal-observation-mask";
import {
	observationFinishedDelay,
	type ObservationViewportRange,
} from "@/features/terminal/model/terminal-observation-range";
import {
	integerData,
	isStreamReadyData,
	stringData,
	TerminalEventStream,
} from "@/features/terminal/runtime/terminal-event-stream";
import { TerminalObservationRangeTracker } from "@/features/terminal/runtime/terminal-observation-range-tracker";

export function TerminalPanel({
	sessionId,
	status,
	onTerminalStateChange,
}: {
	sessionId: string;
	status: TerminalStatusResponse;
	onTerminalStateChange(): void;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const { locale } = useLocale();
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const { resolvedTheme } = useTheme();
	const resolvedThemeRef = useRef(resolvedTheme);
	const [retry, setRetry] = useState(0);
	const [phase, setPhase] = useState<"attaching" | "replaying" | "live">("attaching");
	const [owner, setOwner] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [observationMask, setObservationMask] = useState<ObservationMaskState | null>(null);
	const [observationRange, setObservationRange] = useState<ObservationViewportRange | null>(null);
	const [observationCapturedAt, setObservationCapturedAt] = useState<number | null>(null);

	useEffect(() => {
		resolvedThemeRef.current = resolvedTheme;
		if (terminalRef.current) applyTerminalTheme(terminalRef.current, resolvedTheme);
	}, [resolvedTheme]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || status.terminal?.status !== "active") return;
		let disposed = false;
		let stream: TerminalEventStream | undefined;
		let terminal: Terminal | undefined;
		let attachmentId: string | undefined;
		let lastSequence = 0;
		let ownershipEpoch: number | null = null;
		let live = false;
		let writeTail: Promise<void> = Promise.resolve();
		let resizeTimer: ReturnType<typeof setTimeout> | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let observationFinishDelayTimer: ReturnType<typeof setTimeout> | undefined;
		let observationFinishedTimer: ReturnType<typeof setTimeout> | undefined;
		let observationStateEventCount = 0;
		let currentObservationMask: ObservationMaskState | null = null;
		let currentObservationShownAt: number | null = null;
		let observationRangeTracker: TerminalObservationRangeTracker | undefined;
		const observationViewportSubscriptions: Array<{ dispose(): void }> = [];
		const fitAddon = new FitAddon();
		setPhase("attaching");
		setOwner(false);
		setError(null);
		setObservationMask(null);
		setObservationRange(null);
		setObservationCapturedAt(null);

		const timelineRestore = terminalApi.listTimeline(sessionId, 50);
		const clearObservationTimers = (): void => {
			if (observationFinishDelayTimer !== undefined) {
				clearTimeout(observationFinishDelayTimer);
				observationFinishDelayTimer = undefined;
			}
			if (observationFinishedTimer !== undefined) {
				clearTimeout(observationFinishedTimer);
				observationFinishedTimer = undefined;
			}
		};
		const updateObservationPresentation = (): void => {
			if (!currentObservationMask || !observationRangeTracker) {
				setObservationRange(null);
				setObservationCapturedAt(null);
				return;
			}
			const presentation = observationRangeTracker.presentation(currentObservationMask.observationId);
			if (presentation && currentObservationMask.phase === "finished" && currentObservationShownAt === null) {
				setObservationRange(null);
				setObservationCapturedAt(null);
				return;
			}
			if (presentation && currentObservationShownAt === null) currentObservationShownAt = Date.now();
			setObservationRange(presentation?.range ?? null);
			setObservationCapturedAt(presentation?.capturedAt ?? null);
		};
		const removeObservation = (observationId: string): void => {
			if (currentObservationMask?.observationId !== observationId) return;
			currentObservationMask = null;
			currentObservationShownAt = null;
			setObservationMask(null);
			setObservationRange(null);
			setObservationCapturedAt(null);
			observationRangeTracker?.disposeObservation(observationId);
		};
		const enterObservationFinished = (observationId: string): void => {
			observationFinishDelayTimer = undefined;
			if (currentObservationMask?.observationId !== observationId) return;
			currentObservationMask = { observationId, phase: "finished" };
			setObservationMask(currentObservationMask);
			observationFinishedTimer = setTimeout(() => {
				observationFinishedTimer = undefined;
				removeObservation(observationId);
			}, TERMINAL_UI_DEFAULTS.observationMaskFinishedFadeMs);
		};
		const applyObservationMaskEvent = (envelope: TerminalSseEnvelope): void => {
			const next = reduceObservationMaskState(currentObservationMask, envelope);
			if (next === currentObservationMask) return;
			if (next === null) {
				clearObservationTimers();
				if (currentObservationMask) observationRangeTracker?.disposeObservation(currentObservationMask.observationId);
				currentObservationMask = null;
				currentObservationShownAt = null;
				setObservationMask(null);
				setObservationRange(null);
				setObservationCapturedAt(null);
				return;
			}
			if (next.phase === "finished") {
				if (observationFinishDelayTimer !== undefined || observationFinishedTimer !== undefined) return;
				if (currentObservationShownAt === null) {
					enterObservationFinished(next.observationId);
					return;
				}
				const delay = observationFinishedDelay(
					currentObservationShownAt,
					Date.now(),
					TERMINAL_UI_DEFAULTS.observationMaskMinimumVisibleMs,
				);
				if (delay === 0) enterObservationFinished(next.observationId);
				else observationFinishDelayTimer = setTimeout(() => enterObservationFinished(next.observationId), delay);
				return;
			}
			clearObservationTimers();
			const previousObservationId = currentObservationMask?.observationId;
			if (previousObservationId !== next.observationId) {
				if (previousObservationId) observationRangeTracker?.disposeObservation(previousObservationId);
				currentObservationShownAt = null;
			}
			currentObservationMask = next;
			setObservationMask(next);
			updateObservationPresentation();
		};
		const loadObservationRange = async (observationId: string, restore = false): Promise<void> => {
			const observation = await terminalApi.getObservation(sessionId, observationId);
			if (
				disposed ||
				observation.terminalSessionId !== status.terminal?.id ||
				!observationRangeTracker
			) return;
			observationRangeTracker.resolveObservation(observation, restore);
			if (currentObservationMask?.observationId === observationId) updateObservationPresentation();
		};

		const fail = (value: unknown): void => {
			if (disposed) return;
			setError(localizedErrorMessage(value));
			void Promise.resolve(onTerminalStateChange()).catch(() => undefined);
			if (retryTimer === undefined) {
				retryTimer = setTimeout(() => {
					retryTimer = undefined;
					if (!disposed) setRetry((current) => current + 1);
				}, TERMINAL_UI_DEFAULTS.reconnectRetryMs);
			}
		};
		const requestResize = (): void => {
			if (!live || ownershipEpoch === null || !attachmentId || !terminal) return;
			if (resizeTimer !== undefined) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				const proposed = fitAddon.proposeDimensions();
				if (!proposed || ownershipEpoch === null || !attachmentId || !terminal) return;
				const rows = clamp(proposed.rows, status.capabilities.minRows, status.capabilities.maxRows);
				const cols = clamp(proposed.cols, status.capabilities.minCols, status.capabilities.maxCols);
				if (rows === terminal.rows && cols === terminal.cols) return;
				void terminalApi.resize(sessionId, attachmentId, ownershipEpoch, rows, cols).catch(fail);
			}, TERMINAL_UI_DEFAULTS.resizeDebounceMs);
		};
		const updateFocus = (): void => {
			if (!live || !attachmentId) return;
			const focused = document.visibilityState === "visible" && document.hasFocus();
			void terminalApi.focus(sessionId, attachmentId, focused).then((result) => {
				if (disposed) return;
				ownershipEpoch = result.owner ? result.ownershipEpoch : null;
				setOwner(result.owner);
				if (result.owner) requestResize();
			}).catch(fail);
		};

		void terminalApi.attach(sessionId, crypto.randomUUID()).then(async (bootstrap) => {
			if (disposed) return;
			attachmentId = bootstrap.attachmentId;
			lastSequence = bootstrap.snapshot.sequence;
			terminal = new Terminal({
				cols: bootstrap.snapshot.cols,
				rows: bootstrap.snapshot.rows,
				disableStdin: true,
				convertEol: false,
				cursorBlink: false,
				fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
				fontSize: TERMINAL_UI_DEFAULTS.fontSize,
				lineHeight: TERMINAL_UI_DEFAULTS.lineHeight,
				scrollback: TERMINAL_UI_DEFAULTS.scrollbackRows,
				theme: terminalTheme(resolvedThemeRef.current),
			});
			terminalRef.current = terminal;
			terminal.loadAddon(fitAddon);
			terminal.open(container);
			observationRangeTracker = new TerminalObservationRangeTracker(terminal);
			await writeTerminal(terminal, decodeBase64(bootstrap.snapshot.data));
			if (disposed) return;
			observationRangeTracker.recordCheckpoint(bootstrap.snapshot.sequence);
			observationViewportSubscriptions.push(
				terminal.onScroll(updateObservationPresentation),
				terminal.onResize(updateObservationPresentation),
			);
			void timelineRestore.then(async (events) => {
				if (disposed || observationStateEventCount > 0) return;
				const restored = restoreObservationMaskState(events, status.terminal?.id ?? "");
				if (!restored) return;
				await loadObservationRange(restored.observationId, true).catch(() => undefined);
				if (disposed || observationStateEventCount > 0) {
					observationRangeTracker?.disposeObservation(restored.observationId);
					return;
				}
				currentObservationMask = restored;
				currentObservationShownAt = null;
				setObservationMask(restored);
				updateObservationPresentation();
			}).catch(() => undefined);
			setPhase("replaying");
			stream = new TerminalEventStream(sessionId, bootstrap.attachmentId, bootstrap.snapshot.sequence, locale, () => {
				fail(new Error("Terminal event stream disconnected"));
			});
			stream.subscribe((envelope) => {
				const maskStateEvent = isObservationMaskStateEvent(envelope);
				if (maskStateEvent) observationStateEventCount += 1;
				if (envelope.type === "terminal.resync_required") {
					applyObservationMaskEvent(envelope);
					fail(new Error("Terminal stream gap requires a new snapshot"));
					setRetry((value) => value + 1);
					return;
				}
				if (envelope.type === "terminal.stream.ready") {
					if (!isStreamReadyData(envelope.data)) return;
					writeTail = writeTail.then(async () => {
						if (!attachmentId) return;
						if (lastSequence !== envelope.data.replayedThroughSequence) {
							throw new Error("Terminal replay did not reach the declared sequence");
						}
						await terminalApi.ready(sessionId, attachmentId, lastSequence);
						live = true;
						if (retryTimer !== undefined) {
							clearTimeout(retryTimer);
							retryTimer = undefined;
						}
						setError(null);
						setPhase("live");
						updateFocus();
					});
					void writeTail.catch(fail);
					return;
				}
				if (envelope.sequence === null) return;
				writeTail = writeTail.then(async () => {
					if (!terminal || !attachmentId || envelope.sequence === null) return;
					if (envelope.sequence <= lastSequence) return;
					if (envelope.sequence !== lastSequence + 1) throw new Error("Terminal event sequence gap");
					if (envelope.type === "terminal.input") {
						const interactionId = stringData(envelope.data, "interactionId");
						if (interactionId !== null) observationRangeTracker?.recordInput(interactionId);
					} else if (envelope.type === "terminal.observation.captured") {
						const observationId = stringData(envelope.data, "observationId");
						const interactionId = stringData(envelope.data, "interactionId");
						if (observationId !== null) {
							observationRangeTracker?.recordCaptured(
								observationId,
								interactionId,
								Date.parse(envelope.emittedAt),
							);
							void loadObservationRange(observationId).catch(() => undefined);
						}
					} else if (envelope.type === "terminal.output") {
						const bytes = stringData(envelope.data, "bytesBase64");
						if (bytes === null) throw new Error("Invalid Terminal output event");
						await writeTerminal(terminal, decodeBase64(bytes));
					} else if (envelope.type === "terminal.resized") {
						const rows = integerData(envelope.data, "rows");
						const cols = integerData(envelope.data, "cols");
						if (rows === null || cols === null) throw new Error("Invalid Terminal resize event");
						terminal.resize(cols, rows);
					} else if (envelope.type === "terminal.resize_owner_changed") {
						const ownerId = envelope.data.ownerAttachmentId;
						const epoch = integerData(envelope.data, "ownershipEpoch");
						const isOwner = ownerId === attachmentId && epoch !== null;
						ownershipEpoch = isOwner ? epoch : null;
						setOwner(isOwner);
					} else if (envelope.type === "terminal.status") {
						const nextStatus = stringData(envelope.data, "newStatus");
						if (nextStatus === "closed" || nextStatus === "failed" || nextStatus === "lost") onTerminalStateChange();
					}
					if (envelope.type === "terminal.output" || envelope.type === "terminal.resized") {
						observationRangeTracker?.recordCheckpoint(envelope.sequence);
						updateObservationPresentation();
					}
					if (maskStateEvent) applyObservationMaskEvent(envelope);
					lastSequence = envelope.sequence;
				});
				void writeTail.catch((streamError) => {
					fail(streamError);
					setRetry((value) => value + 1);
				});
			});
		}).catch(fail);

		const resizeObserver = new ResizeObserver(requestResize);
		resizeObserver.observe(container);
		window.addEventListener("focus", updateFocus);
		window.addEventListener("blur", updateFocus);
		document.addEventListener("visibilitychange", updateFocus);
		window.addEventListener("pageshow", updateFocus);
		return () => {
			disposed = true;
			if (resizeTimer !== undefined) clearTimeout(resizeTimer);
			if (retryTimer !== undefined) clearTimeout(retryTimer);
			if (observationFinishDelayTimer !== undefined) clearTimeout(observationFinishDelayTimer);
			if (observationFinishedTimer !== undefined) clearTimeout(observationFinishedTimer);
			for (const subscription of observationViewportSubscriptions) subscription.dispose();
			observationRangeTracker?.dispose();
			resizeObserver.disconnect();
			window.removeEventListener("focus", updateFocus);
			window.removeEventListener("blur", updateFocus);
			document.removeEventListener("visibilitychange", updateFocus);
			window.removeEventListener("pageshow", updateFocus);
			stream?.close();
			if (terminalRef.current === terminal) terminalRef.current = null;
			terminal?.dispose();
			if (attachmentId) void terminalApi.detach(sessionId, attachmentId).catch(() => undefined);
		};
	}, [locale, localizedErrorMessage, retry, sessionId, status, onTerminalStateChange]);

	return (
		<section className="terminal-panel terminal-panel-shell shrink-0 bg-[var(--terminal-bg)] text-[var(--terminal-ink)]">
			<div className="flex h-9 items-center justify-between border-b border-[var(--terminal-line)] px-4">
				<div className="flex items-center gap-2 text-[9px] font-semibold"><span className={`h-1.5 w-1.5 rounded-full ${phase === "live" ? "bg-emerald-400" : "bg-amber-400"}`} />Terminal · {intl.formatMessage({ id: phase === "live" ? owner ? "terminal.panel.liveOwner" : "terminal.panel.liveFollower" : phase === "replaying" ? "terminal.panel.replaying" : "terminal.panel.attaching" })}</div>
				{error ? <button type="button" className="flex items-center gap-1 text-[9px] text-rose-300" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={10} />{intl.formatMessage({ id: "terminal.panel.resync" })}</button> : null}
			</div>
			<div className="terminal-viewport relative min-h-0 p-2">
				<div ref={containerRef} className="h-full w-full overflow-hidden" aria-label={intl.formatMessage({ id: "terminal.panel.readonly" })} />
				<TerminalObservationMask
					state={observationMask}
					range={observationRange}
					capturedAt={observationCapturedAt}
				/>
				{phase !== "live" && !error ? <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-[color-mix(in_srgb,var(--terminal-bg)_70%,transparent)] text-[9px] text-[var(--terminal-muted)]"><span className="flex items-center gap-2"><LoaderCircle size={12} className="animate-spin" />{intl.formatMessage({ id: "terminal.panel.restoring" })}</span></div> : null}
				{error ? <div className="absolute inset-x-3 bottom-3 z-20 rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] px-3 py-2 text-[9px] text-[var(--danger)]">{error}</div> : null}
			</div>
			<TerminalTimeline sessionId={sessionId} />
		</section>
	);
}

function writeTerminal(terminal: Terminal, data: Uint8Array): Promise<void> {
	return new Promise((resolve) => terminal.write(data, resolve));
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}
