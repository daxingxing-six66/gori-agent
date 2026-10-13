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
import { TERMINAL_UI_DEFAULTS } from "@/features/terminal/model/terminal-ui-defaults";
import { shouldRetryTerminalConnection } from "@/features/terminal/model/terminal-retry";
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
import { decodeTerminalBytes, TerminalEventQueue } from "@/features/terminal/runtime/terminal-event-queue";

export type TerminalPanelPhase = "attaching" | "replaying" | "live";

export function TerminalPanel({
	sessionId,
	status,
	onTerminalStateChange,
	onPhaseChange,
}: {
	sessionId: string;
	status: TerminalStatusResponse;
	onTerminalStateChange(): void;
	onPhaseChange(phase: TerminalPanelPhase): void;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const { locale } = useLocale();
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const { resolvedTheme } = useTheme();
	const resolvedThemeRef = useRef(resolvedTheme);
	const [retry, setRetry] = useState(0);
	const [phase, setPhase] = useState<TerminalPanelPhase>("attaching");
	const [owner, setOwner] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [observationMask, setObservationMask] = useState<ObservationMaskState | null>(null);
	const [observationRange, setObservationRange] = useState<ObservationViewportRange | null>(null);
	const [observationCapturedAt, setObservationCapturedAt] = useState<number | null>(null);
	const terminalSessionId = status.terminal?.id;
	const terminalStatus = status.terminal?.status;
	const { minRows, maxRows, minCols, maxCols } = status.capabilities;

	useEffect(() => { onPhaseChange(phase); }, [onPhaseChange, phase]);

	useEffect(() => {
		resolvedThemeRef.current = resolvedTheme;
		if (terminalRef.current) applyTerminalTheme(terminalRef.current, resolvedTheme);
	}, [resolvedTheme]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || terminalStatus !== "active") return;
		let disposed = false;
		const attachController = new AbortController();
		let stream: TerminalEventStream | undefined;
		let eventQueue: TerminalEventQueue | undefined;
		let terminal: Terminal | undefined;
		let attachmentId: string | undefined;
		let ownershipEpoch: number | null = null;
		let live = false;
		let resizeTimer: ReturnType<typeof setTimeout> | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let observationFinishDelayTimer: ReturnType<typeof setTimeout> | undefined;
		let observationFinishedTimer: ReturnType<typeof setTimeout> | undefined;
		let observationStateEventCount = 0;
		let failureHandled = false;
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
				observation.terminalSessionId !== terminalSessionId ||
				!observationRangeTracker
			) return;
			observationRangeTracker.resolveObservation(observation, restore);
			if (currentObservationMask?.observationId === observationId) updateObservationPresentation();
		};

		const fail = (value: unknown): void => {
			if (disposed || failureHandled) return;
			failureHandled = true;
			stream?.close();
			eventQueue?.close();
			setError(localizedErrorMessage(value));
			void Promise.resolve(onTerminalStateChange()).catch(() => undefined);
			if (shouldRetryTerminalConnection(value)) {
				retryTimer = setTimeout(() => {
					retryTimer = undefined;
					if (!disposed) setRetry((current) => current + 1);
				}, TERMINAL_UI_DEFAULTS.reconnectRetryMs);
			}
		};
		const requestResize = (): void => {
			if (disposed || failureHandled || !live || ownershipEpoch === null || !attachmentId || !terminal) return;
			// An inactive tab stays attached but must not resize the PTY to a hidden viewport.
			if (container.clientWidth === 0 || container.clientHeight === 0) return;
			if (resizeTimer !== undefined) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				if (disposed || failureHandled) return;
				if (container.clientWidth === 0 || container.clientHeight === 0) return;
				const proposed = fitAddon.proposeDimensions();
				if (!proposed || ownershipEpoch === null || !attachmentId || !terminal) return;
				const rows = clamp(proposed.rows, minRows, maxRows);
				const cols = clamp(proposed.cols, minCols, maxCols);
				if (rows === terminal.rows && cols === terminal.cols) return;
				void terminalApi.resize(sessionId, attachmentId, ownershipEpoch, rows, cols).catch(fail);
			}, TERMINAL_UI_DEFAULTS.resizeDebounceMs);
		};
		const updateFocus = (): void => {
			if (disposed || failureHandled || !live || !attachmentId) return;
			const focused = document.visibilityState === "visible" && document.hasFocus();
			void terminalApi.focus(sessionId, attachmentId, focused).then((result) => {
				if (disposed) return;
				ownershipEpoch = result.owner ? result.ownershipEpoch : null;
				setOwner(result.owner);
				if (result.owner) requestResize();
			}).catch(fail);
		};

		void terminalApi.attach(sessionId, crypto.randomUUID(), attachController.signal).then(async (bootstrap) => {
			if (disposed) {
				void terminalApi.detach(sessionId, bootstrap.attachmentId).catch(() => undefined);
				return;
			}
			attachmentId = bootstrap.attachmentId;
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
			await writeTerminal(terminal, decodeTerminalBytes(bootstrap.snapshot.data));
			if (disposed) return;
			observationRangeTracker.recordCheckpoint(bootstrap.snapshot.sequence);
			observationViewportSubscriptions.push(
				terminal.onScroll(updateObservationPresentation),
				terminal.onResize(updateObservationPresentation),
			);
			void timelineRestore.then(async (events) => {
				if (disposed || observationStateEventCount > 0) return;
				const restored = restoreObservationMaskState(events, terminalSessionId ?? "");
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
			eventQueue = new TerminalEventQueue({
				initialSequence: bootstrap.snapshot.sequence,
				writeOutput: async (bytes, sequence) => {
					if (disposed || failureHandled || !terminal) return;
					await writeTerminal(terminal, bytes);
					if (disposed || failureHandled) return;
					observationRangeTracker?.recordCheckpoint(sequence);
					updateObservationPresentation();
				},
				applyEvent: async (envelope, appliedSequence) => {
					if (disposed || failureHandled || !terminal || !attachmentId) return;
					if (envelope.type === "terminal.stream.ready") {
						if (!isStreamReadyData(envelope.data) || appliedSequence !== envelope.data.replayedThroughSequence) {
							throw new Error("Terminal replay did not reach the declared sequence");
						}
						await terminalApi.ready(sessionId, attachmentId, appliedSequence);
						if (disposed || failureHandled) return;
						live = true;
						setError(null);
						setPhase("live");
						updateFocus();
						return;
					}
					if (envelope.sequence === null) return;
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
					} else if (envelope.type === "terminal.resized") {
						const rows = integerData(envelope.data, "rows");
						const cols = integerData(envelope.data, "cols");
						if (rows === null || cols === null) throw new Error("Invalid Terminal resize event");
						terminal.resize(cols, rows);
						observationRangeTracker?.recordCheckpoint(envelope.sequence);
						updateObservationPresentation();
					} else if (envelope.type === "terminal.resize_owner_changed") {
						const ownerId = envelope.data.ownerAttachmentId;
						const epoch = integerData(envelope.data, "ownershipEpoch");
						const isOwner = ownerId === attachmentId && epoch !== null;
						ownershipEpoch = isOwner ? epoch : null;
						setOwner(isOwner);
					} else if (envelope.type === "terminal.status") {
						const nextStatus = stringData(envelope.data, "newStatus");
						if (nextStatus === "closed" || nextStatus === "failed" || nextStatus === "lost") {
							void Promise.resolve(onTerminalStateChange()).catch(fail);
						}
					}
					if (isObservationMaskStateEvent(envelope)) applyObservationMaskEvent(envelope);
				},
				onError: fail,
			});
			stream = new TerminalEventStream(sessionId, bootstrap.attachmentId, bootstrap.snapshot.sequence, locale, () => {
				fail(new Error("Terminal event stream disconnected"));
			});
			stream.subscribe((envelope) => {
				if (disposed || failureHandled) return;
				if (isObservationMaskStateEvent(envelope)) observationStateEventCount += 1;
				if (envelope.type === "terminal.resync_required") {
					applyObservationMaskEvent(envelope);
					fail(new Error("Terminal stream gap requires a new snapshot"));
					return;
				}
				eventQueue?.push(envelope);
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
			attachController.abort();
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
			eventQueue?.close();
			if (terminalRef.current === terminal) terminalRef.current = null;
			terminal?.dispose();
			if (attachmentId) void terminalApi.detach(sessionId, attachmentId).catch(() => undefined);
		};
	}, [locale, localizedErrorMessage, retry, sessionId, terminalSessionId, terminalStatus, minRows, maxRows, minCols, maxCols, onTerminalStateChange]);

	return (
		<section data-resize-owner={owner} className="terminal-task-viewport">
			<div className="terminal-viewport relative min-h-0 p-2">
				<div ref={containerRef} className="h-full w-full overflow-hidden" aria-label={intl.formatMessage({ id: "terminal.panel.readonly" })} />
				<TerminalObservationMask
					state={observationMask}
					range={observationRange}
					capturedAt={observationCapturedAt}
				/>
				{phase !== "live" && !error ? <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-[color-mix(in_srgb,var(--terminal-bg)_70%,transparent)] text-[9px] text-[var(--terminal-muted)]"><span className="flex items-center gap-2"><LoaderCircle size={12} className="animate-spin" />{intl.formatMessage({ id: "terminal.panel.restoring" })}</span></div> : null}
				{error ? <div className="absolute inset-x-3 bottom-3 z-20 rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">{error}
					<button type="button" className="terminal-task-resync" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={12} />{intl.formatMessage({ id: "terminal.panel.resync" })}</button>
				</div> : null}
			</div>
		</section>
	);
}

function writeTerminal(terminal: Terminal, data: Uint8Array): Promise<void> {
	return new Promise((resolve) => terminal.write(data, resolve));
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}
