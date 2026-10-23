import type { Clock, IdGenerator, TerminalAttachmentId } from "../../domain/ids.ts";
import type { TerminalInputControl, TerminalHumanInputRequest, TerminalHumanHandoffReceipt } from "../../domain/terminal-human.ts";
import type { TerminalCloseReason, TerminalGeometry, TerminalSandboxFacts, TerminalSession } from "../../domain/terminal.ts";
import { TerminalError } from "../../domain/terminal.ts";
import type { TerminalRepository } from "../repositories/terminal-repository.ts";
import type { SessionUseLease } from "../services/session-lifecycle-coordinator.ts";
import type { TerminalChannelExit, TerminalChannelHandle } from "../ssh-channel-broker.ts";
import { TerminalCanonicalState, type TerminalSnapshot } from "./terminal-canonical-state.ts";
import { TERMINAL_DEFAULTS } from "./terminal-defaults.ts";
import { TerminalInputArbiter } from "./terminal-input-control.ts";
import { TerminalHumanActivityRecorder } from "./terminal-human-activity.ts";
import { TerminalHumanHandoffObservation } from "./terminal-human-handoff.ts";
import {
	TerminalReplayGapError,
	type TerminalReplayResult,
	TerminalReplayRing,
	type TerminalSequencedEvent,
} from "./terminal-replay-ring.ts";

type AttachmentState = "bootstrapping" | "live" | "disconnected";

interface TerminalAttachment {
	readonly id: TerminalAttachmentId;
	readonly requestId: string;
	readonly bootstrap: TerminalAttachmentBootstrap;
	state: AttachmentState;
	replayedThroughSequence: number | null;
	bootstrapTimer?: ReturnType<typeof setTimeout>;
	reconnectTimer?: ReturnType<typeof setTimeout>;
}

export interface TerminalAttachmentBootstrap {
	readonly attachmentId: TerminalAttachmentId;
	readonly snapshot: TerminalSnapshot;
	readonly inputControl: TerminalInputControl;
}

export interface TerminalResizeOwnership {
	readonly owner: boolean;
	readonly ownershipEpoch: number | null;
}

export interface TerminalCanonicalCapture {
	readonly sequence: number;
	readonly geometry: TerminalGeometry;
	readonly screenText: string;
	readonly allText: string;
}

export interface TerminalEventStreamConnection {
	readonly replay: TerminalReplayResult;
	disconnect(): void;
}

export type TerminalEventListener = (event: TerminalSequencedEvent) => void;

export class TerminalSessionActor {
	#session: TerminalSession;
	readonly #repository: TerminalRepository;
	readonly #clock: Clock;
	readonly #ids: IdGenerator;
	readonly #canonical: TerminalCanonicalState;
	readonly #ring: TerminalReplayRing;
	readonly #sessionLease: SessionUseLease;
	readonly #onDisposed: () => void;
	readonly #attachments = new Map<TerminalAttachmentId, TerminalAttachment>();
	readonly #listeners = new Set<TerminalEventListener>();
	#channel: TerminalChannelHandle | null = null;
	#ownerAttachmentId: TerminalAttachmentId | null = null;
	#tail: Promise<void> = Promise.resolve();
	#pendingOutput: { chunks: Uint8Array[]; byteLength: number } | null = null;
	#disposed = false;
	#finalCapture: TerminalCanonicalCapture | null = null;
	#runBindings = new Set<string>();
	#inFlightInteractions = 0;
	readonly #input = new TerminalInputArbiter();
	readonly #human: TerminalHumanActivityRecorder;
	readonly #handoff = new TerminalHumanHandoffObservation();
	#contentVersion = 0;
	#humanCheckpointTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: {
		session: TerminalSession;
		repository: TerminalRepository;
		clock: Clock;
		ids: IdGenerator;
		sessionLease: SessionUseLease;
		onDisposed: () => void;
	}) {
		this.#session = options.session;
		this.#repository = options.repository;
		this.#clock = options.clock;
		this.#ids = options.ids;
		this.#sessionLease = options.sessionLease;
		this.#onDisposed = options.onDisposed;
		this.#canonical = new TerminalCanonicalState(options.session.geometry);
		this.#ring = new TerminalReplayRing();
		this.#human = new TerminalHumanActivityRecorder(options.repository, options.clock, options.ids);
	}

	get id(): string {
		return this.#session.id;
	}

	get sessionId(): string {
		return this.#session.sessionId;
	}

	get view(): TerminalSession {
		return this.#session;
	}

	get inputControl(): TerminalInputControl { return this.#input.view; }
	get hasPendingHumanActivity(): boolean { return this.#human.active; }

	finishHumanHandoff(runId: string): Promise<void> {
		return this.#enqueue(async () => {
			this.#requireActive(); this.#input.requireAgent(runId);
			const capture = this.#capture();
			this.#human.checkpoint(capture, "handoff");
			this.#handoff.freeze(this.#human.latest, capture, this.#contentVersion);
		});
	}

	requireAgentControl(runId: string, writing = false): void {
		this.#input.requireAgent(runId, writing && !this.#handoff.reusable(runId, this.#contentVersion));
	}

	acknowledgeHumanHandoff(receipt: TerminalHumanHandoffReceipt): Promise<TerminalCanonicalCapture | null> {
		return this.#enqueue(async () => {
			this.#requireActive(); this.#input.requireAgent(receipt.agentRunId);
			return this.#handoff.acknowledge(receipt);
		});
	}

	markHumanActivityObserved(runId: string): Promise<void> {
		return this.#enqueue(async () => { this.#input.observed(runId); this.#human.observed(); this.#handoff.observed(); });
	}

	controlInput(attachmentId: string, claim: boolean): Promise<TerminalInputControl> {
		return this.#enqueue(async () => {
			this.#requireActive();
			const attachment = this.#requireAttachment(attachmentId);
			if (claim && attachment.state !== "live")
				throw new TerminalError("terminal_attachment_not_live", "Terminal attachment is not live", { status: 409 });
			const previous = this.#input.view;
			if (claim) this.#input.claim(attachmentId); else this.#input.release(attachmentId);
			this.#publishInputControl(previous);
			return this.#input.view;
		});
	}

	writeHumanInput(attachmentId: string, request: TerminalHumanInputRequest): Promise<{ acceptedSequence: number }> {
		return this.#enqueue(async () => {
			this.#requireActive();
			if (this.#requireAttachment(attachmentId).state !== "live")
				throw new TerminalError("terminal_attachment_not_live", "Terminal attachment is not live", { status: 409 });
			if (!this.#input.accept(this.id, attachmentId, request)) return { acceptedSequence: request.inputSequence };
			try {
				this.#human.begin(this.sessionId, this.id, request.bytes.byteLength, this.#capture());
				await this.#writeHumanBytes(request.bytes);
				this.#human.written(this.#capture());
				this.#refreshConsumerActivity();
				return { acceptedSequence: request.inputSequence };
			} catch {
				const previous = this.#input.view;
				this.#input.release(attachmentId);
				try { this.#human.written(this.#capture(), true); this.#publishInputControl(previous); }
				catch (error) { this.#handleRuntimeFailure(error); }
				throw new TerminalError("terminal_input_uncertain", "Terminal input could not be confirmed. It will not be replayed; inspect the terminal before continuing.", { status: 409 });
			}
		});
	}

	acceptSshData(bytes: Uint8Array): void {
		if (this.#disposed || bytes.byteLength === 0) return;
		const pending = this.#pendingOutput;
		if (pending && pending.byteLength + bytes.byteLength <= TERMINAL_DEFAULTS.replay.outputBatchBytes) {
			pending.chunks.push(bytes.slice());
			pending.byteLength += bytes.byteLength;
			return;
		}
		const batch = { chunks: [bytes.slice()], byteLength: bytes.byteLength };
		void this.#enqueue(async () => {
			if (this.#pendingOutput === batch) this.#pendingOutput = null;
			if (this.#disposed || this.#session.status !== "active") return;
			const output = new Uint8Array(batch.byteLength);
			let offset = 0;
			for (const chunk of batch.chunks) {
				output.set(chunk, offset);
				offset += chunk.byteLength;
			}
			await this.#canonical.write(output);
			this.#contentVersion += 1;
			const event: TerminalSequencedEvent = {
				sequence: this.#nextSequence(),
				type: "terminal.output",
				emittedAt: this.#clock.now(),
				bytes: output,
			};
			this.#publish(event);
			if (this.#human.active) this.#human.track(this.#capture());
			this.#scheduleHumanCheckpoint();
		}).catch((error: unknown) => this.#handleRuntimeFailure(error));
		this.#pendingOutput = batch;
	}

	activate(channel: TerminalChannelHandle, sandbox: TerminalSandboxFacts): Promise<TerminalSession> {
		return this.#enqueue(async () => {
			if (this.#session.status !== "opening" || channel.isClosed()) {
				channel.dispose();
				throw new TerminalError("terminal_session_unavailable", "Terminal is no longer opening", { status: 409 });
			}
			this.#channel = channel;
			const previous = this.#session;
			const now = this.#clock.now();
			const next: TerminalSession = {
				...previous,
				status: "active",
				sandbox,
				revision: previous.revision + 1,
				connectionGeneration: channel.connectionGeneration,
				activatedAt: now,
				idleDeadlineAt: now + TERMINAL_DEFAULTS.lifecycle.idleTtlMs,
				updatedAt: now,
			};
			this.#persist(next, previous);
			this.#session = next;
			this.#appendTimeline("terminal.active", { sandbox });
			void channel.closed.then((exit) => this.#handleChannelExit(exit));
			channel.startOutput();
			return next;
		});
	}

	failOpening(code: string, message: string): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#session.status !== "opening") return;
			const previous = this.#session;
			const now = this.#clock.now();
			const next: TerminalSession = {
				...previous,
				status: "failed",
				revision: previous.revision + 1,
				closeReason: "open_failed",
				failureCode: code,
				failureMessage: message,
				closedAt: now,
				updatedAt: now,
			};
			this.#persist(next, previous);
			this.#session = next;
			this.#appendTimeline("terminal.failed", { code });
			this.#dispose();
		});
	}

	createAttachment(requestId: string, attachmentId: TerminalAttachmentId): Promise<TerminalAttachmentBootstrap> {
		return this.#enqueue(async () => {
			this.#requireActive();
			const existing = [...this.#attachments.values()].find((attachment) => attachment.requestId === requestId);
			if (existing) return existing.bootstrap;
			if (this.#attachments.size >= TERMINAL_DEFAULTS.capacity.attachmentsPerTerminal) {
				throw new TerminalError("terminal_attachment_capacity_exceeded", "Terminal attachment capacity exceeded", {
					status: 429,
					retryable: true,
				});
			}
			const bootstrap = { attachmentId, snapshot: this.#canonical.snapshot(this.#session.eventSequence), inputControl: this.#input.view };
			const bootstrapTimer = setTimeout(
				() => void this.detach(attachmentId),
				TERMINAL_DEFAULTS.lifecycle.bootstrapTimeoutMs,
			);
			bootstrapTimer.unref();
			this.#attachments.set(attachmentId, {
				id: attachmentId,
				requestId,
				bootstrap,
				state: "bootstrapping",
				replayedThroughSequence: null,
				bootstrapTimer,
			});
			this.#refreshConsumerActivity();
			return bootstrap;
		});
	}

	prepareReplay(attachmentId: TerminalAttachmentId, afterSequence: number): Promise<TerminalReplayResult> {
		return this.#enqueue(async () => {
			const attachment = this.#requireAttachment(attachmentId);
			if (attachment.reconnectTimer !== undefined) {
				clearTimeout(attachment.reconnectTimer);
				attachment.reconnectTimer = undefined;
			}
			attachment.state = "bootstrapping";
			const replay = this.#ring.replayAfter(afterSequence);
			attachment.replayedThroughSequence = replay.latestSequence ?? afterSequence;
			return replay;
		});
	}

	connectEventStream(
		attachmentId: TerminalAttachmentId,
		afterSequence: number,
		listener: TerminalEventListener,
	): Promise<TerminalEventStreamConnection> {
		return this.#enqueue(async () => {
			const attachment = this.#requireAttachment(attachmentId);
			if (attachment.reconnectTimer !== undefined) {
				clearTimeout(attachment.reconnectTimer);
				attachment.reconnectTimer = undefined;
			}
			attachment.state = "bootstrapping";
			const replay = this.#ring.replayAfter(afterSequence);
			attachment.replayedThroughSequence = replay.latestSequence ?? afterSequence;
			this.#listeners.add(listener);
			let disconnected = false;
			return {
				replay,
				disconnect: () => {
					if (disconnected) return;
					disconnected = true;
					this.#listeners.delete(listener);
					void this.#enqueue(async () => this.#disconnectAttachment(attachmentId));
				},
			};
		});
	}

	connectObservationEvents(
		afterSequence: number,
		listener: TerminalEventListener,
	): Promise<{ readonly replay: TerminalReplayResult; readonly incomplete: boolean; disconnect(): void }> {
		return this.#enqueue(async () => {
			this.#requireActive();
			let replay: TerminalReplayResult;
			let incomplete = false;
			try {
				replay = this.#ring.replayAfter(afterSequence);
			} catch (error) {
				if (!(error instanceof TerminalReplayGapError)) throw error;
				incomplete = true;
				replay = this.#ring.replayAfter(error.oldestAvailable - 1);
			}
			// An oversized single frame can evict the entire ring.
			if (replay.latestSequence === null && afterSequence < this.#session.eventSequence) incomplete = true;
			this.#listeners.add(listener);
			let disconnected = false;
			return {
				replay,
				incomplete,
				disconnect: () => {
					if (disconnected) return;
					disconnected = true;
					this.#listeners.delete(listener);
				},
			};
		});
	}

	markAttachmentReady(attachmentId: TerminalAttachmentId, replayedThroughSequence: number): Promise<void> {
		return this.#enqueue(async () => {
			const attachment = this.#requireAttachment(attachmentId);
			if (attachment.replayedThroughSequence !== replayedThroughSequence) {
				throw new TerminalError("terminal_resync_required", "Attachment did not apply the complete replay", {
					status: 409,
					retryable: true,
				});
			}
			attachment.state = "live";
			if (attachment.bootstrapTimer !== undefined) {
				clearTimeout(attachment.bootstrapTimer);
				attachment.bootstrapTimer = undefined;
			}
			if (attachment.reconnectTimer !== undefined) {
				clearTimeout(attachment.reconnectTimer);
				attachment.reconnectTimer = undefined;
			}
			this.#refreshConsumerActivity();
		});
	}

	detach(attachmentId: TerminalAttachmentId): Promise<void> {
		return this.#enqueue(async () => {
			const attachment = this.#attachments.get(attachmentId);
			if (!attachment) return;
			if (attachment.bootstrapTimer !== undefined) clearTimeout(attachment.bootstrapTimer);
			if (attachment.reconnectTimer !== undefined) clearTimeout(attachment.reconnectTimer);
			this.#attachments.delete(attachmentId);
			const previousControl = this.#input.view;
			this.#input.release(attachmentId);
			this.#publishInputControl(previousControl);
			if (this.#ownerAttachmentId === attachmentId) this.#changeOwner(null);
			this.#refreshConsumerActivity();
		});
	}

	claimResizeOwnership(attachmentId: TerminalAttachmentId): Promise<TerminalResizeOwnership> {
		return this.#enqueue(async () => {
			const attachment = this.#requireAttachment(attachmentId);
			if (attachment.state !== "live") {
				throw new TerminalError("terminal_attachment_not_live", "Terminal attachment is not live", {
					status: 409,
					retryable: true,
				});
			}
			if (this.#ownerAttachmentId !== attachmentId) this.#changeOwner(attachmentId);
			this.#refreshConsumerActivity();
			return { owner: true, ownershipEpoch: this.#session.ownershipEpoch };
		});
	}

	releaseResizeOwnership(attachmentId: TerminalAttachmentId): Promise<TerminalResizeOwnership> {
		return this.#enqueue(async () => {
			if (this.#ownerAttachmentId === attachmentId) this.#changeOwner(null);
			return { owner: false, ownershipEpoch: null };
		});
	}

	resize(attachmentId: TerminalAttachmentId, ownershipEpoch: number, geometry: TerminalGeometry): Promise<void> {
		return this.#enqueue(async () => {
			this.#requireActive();
			this.#requireAttachment(attachmentId);
			if (this.#ownerAttachmentId !== attachmentId) {
				throw new TerminalError("terminal_resize_not_owner", "Attachment is not the resize owner", {
					status: 409,
					retryable: true,
				});
			}
			if (ownershipEpoch !== this.#session.ownershipEpoch) {
				throw new TerminalError("terminal_ownership_epoch_mismatch", "Resize ownership epoch is stale", {
					status: 409,
					retryable: true,
					details: { ownershipEpoch: this.#session.ownershipEpoch },
				});
			}
			requireGeometry(geometry);
			if (geometry.rows === this.#session.geometry.rows && geometry.cols === this.#session.geometry.cols) return;
			this.#canonical.resize(geometry);
			this.#contentVersion += 1;
			await this.#requireChannel().resize(geometry);
			const previous = this.#session;
			const sequence = previous.eventSequence + 1;
			const next: TerminalSession = {
				...previous,
				geometry,
				eventSequence: sequence,
				revision: previous.revision + 1,
				lastConsumerActivityAt: this.#clock.now(),
				updatedAt: this.#clock.now(),
			};
			this.#persist(next, previous);
			this.#session = next;
			this.#publish({
				sequence,
				type: "terminal.resized",
				emittedAt: this.#clock.now(),
				geometry,
				ownerAttachmentId: attachmentId,
				ownershipEpoch,
			});
		});
	}

	bindRun(runId: string): Promise<void> {
		return this.#enqueue(async () => {
			this.#requireActive();
			const previous = this.#input.view;
			this.#input.bind(runId, this.#human.needsObservation);
			try {
				this.#human.checkpoint(this.#capture());
				this.#publishInputControl(previous);
			} catch (error) {
				const bound = this.#input.view;
				this.#input.unbind(runId);
				this.#publishInputControl(bound);
				throw error;
			}
			this.#runBindings.add(runId);
			this.#refreshConsumerActivity();
		});
	}

	unbindRun(runId: string): Promise<void> {
		return this.#enqueue(async () => {
			this.#runBindings.delete(runId);
			const previous = this.#input.view;
			this.#input.unbind(runId);
			this.#handoff.release();
			this.#publishInputControl(previous);
			this.#refreshConsumerActivity();
		});
	}

	write(data: Uint8Array, runId: string): Promise<number> {
		return this.#enqueue(async () => {
			this.#requireActive();
			this.requireAgentControl(runId, true);
			this.#inFlightInteractions += 1;
			this.#refreshConsumerActivity();
			try {
				// A dispatched write can be uncertain even before its echo arrives; never reuse its old handoff again.
				this.#handoff.observed();
				await this.#requireChannel().write(data);
				this.#input.observed(runId);
				this.#human.observed();
				return this.#session.eventSequence;
			} finally {
				this.#inFlightInteractions -= 1;
				this.#refreshConsumerActivity();
			}
		});
	}

	captureCanonical(): Promise<TerminalCanonicalCapture> {
		return this.#enqueue(async () => {
			if (this.#disposed && this.#finalCapture) return this.#finalCapture;
			this.#requireActive();
			return {
				sequence: this.#session.eventSequence,
				geometry: this.#canonical.geometry,
				screenText: this.#canonical.currentScreenText(),
				allText: this.#canonical.allText(),
			};
		});
	}

	recordDurableEvent(
		type:
			| "terminal.input"
			| "terminal.observation.captured"
			| "terminal.observation.delivered"
			| "terminal.observation.processing"
			| "terminal.observation.finished",
		data: Readonly<Record<string, string | number | boolean | null>>,
	): Promise<number> {
		return this.#enqueue(async () => {
			this.#requireActive();
			const previous = this.#session;
			const sequence = previous.eventSequence + 1;
			const next: TerminalSession = {
				...previous,
				eventSequence: sequence,
				revision: previous.revision + 1,
				updatedAt: this.#clock.now(),
			};
			this.#persist(next, previous);
			this.#session = next;
			this.#publish({ sequence, type, emittedAt: this.#clock.now(), data });
			return sequence;
		});
	}

	close(reason: TerminalCloseReason, closeRequestId: string | null = null): Promise<void> {
		return this.#enqueue(() => this.#closeQueued(reason, closeRequestId));
	}

	checkIdle(now: number): Promise<boolean> {
		return this.#enqueue(async () => {
			if (
				this.#session.status !== "active" ||
				[...this.#attachments.values()].some((attachment) => attachment.state !== "disconnected") ||
				this.#runBindings.size > 0 ||
				this.#inFlightInteractions > 0 ||
				this.#session.idleDeadlineAt === null ||
				now < this.#session.idleDeadlineAt
			) {
				return false;
			}
			await this.#closeQueued("idle_timeout", null);
			return true;
		});
	}

	subscribe(listener: TerminalEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#handleChannelExit(exit: TerminalChannelExit): void {
		void this.#enqueue(async () => {
			if (this.#disposed) return;
			if (this.#session.status === "closing") {
				await this.#finishTerminal("closed", exit);
				return;
			}
			if (this.#session.status === "active") {
				await this.#finishTerminal(exit.kind === "closed" ? "closed" : "lost", exit);
			}
		}).catch((error: unknown) => this.#handleRuntimeFailure(error));
	}

	#handleRuntimeFailure(error: unknown): void {
		if (this.#disposed) return;
		void this.#enqueue(async () => {
			if (this.#disposed || this.#session.status !== "active") return;
			await this.#finishTerminal("lost", {
				kind: "error",
				message: error instanceof Error ? error.message : "Terminal runtime failed",
			});
		}).catch(() => undefined);
	}

	async #closeQueued(reason: TerminalCloseReason, closeRequestId: string | null): Promise<void> {
		if (this.#session.status === "closed" || this.#session.status === "failed" || this.#session.status === "lost") {
			return;
		}
		if (this.#runBindings.size > 0 && reason === "user_requested") {
			throw new TerminalError("session_has_active_chat_run", "Session has an active Chat Run", { status: 409 });
		}
		try {
			await this.#performClose(reason, closeRequestId);
		} catch (error) {
			// A failed SQLite transition or event publish must not leave the Shell running.
			this.#dispose();
			throw error;
		}
	}

	async #performClose(reason: TerminalCloseReason, closeRequestId: string | null): Promise<void> {
		const previous = this.#session;
		const sequence = previous.eventSequence + 1;
		const now = this.#clock.now();
		const closing: TerminalSession = {
			...previous,
			status: "closing",
			closeRequestId,
			closeReason: reason,
			closingAt: now,
			eventSequence: sequence,
			revision: previous.revision + 1,
			updatedAt: now,
		};
		this.#persist(closing, previous);
		this.#session = closing;
		this.#publish({
			sequence,
			type: "terminal.status",
			emittedAt: now,
			oldStatus: previous.status,
			newStatus: "closing",
			reason,
		});
		this.#appendTimeline("terminal.closing", { reason });
		const channel = this.#channel;
		let exit: TerminalChannelExit | undefined;
		if (channel) {
			try {
				await channel.close();
				exit = await channel.closed;
			} catch (error) {
				exit = {
					kind: "error",
					message: error instanceof Error ? error.message : "Terminal channel close failed",
				};
			}
		}
		await this.#finishTerminal(
			reason === "backend_shutdown" || exit?.kind === "error" || exit?.kind === "connection_lost" ? "lost" : "closed",
			exit,
		);
	}

	async #finishTerminal(status: "closed" | "lost", exit?: TerminalChannelExit): Promise<void> {
		if (this.#session.status === status || this.#disposed) return;
		const previous = this.#session;
		const sequence = previous.eventSequence + 1;
		const now = this.#clock.now();
		const next: TerminalSession = {
			...previous,
			status,
			eventSequence: sequence,
			revision: previous.revision + 1,
			closedAt: now,
			closeReason: status === "lost" ? "connection_lost" : (previous.closeReason ?? "shell_exited"),
			failureCode: exit?.kind === "error" ? "channel_closed" : previous.failureCode,
			failureMessage: exit?.message ?? previous.failureMessage,
			updatedAt: now,
		};
		try {
			this.#human.checkpoint(this.#capture(), status === "lost" ? "lost" : "closed");
			this.#persist(next, previous);
			this.#session = next;
			this.#publish({
				sequence,
				type: "terminal.status",
				emittedAt: now,
				oldStatus: previous.status,
				newStatus: status,
				reason: next.closeReason,
			});
			this.#appendTimeline(status === "closed" ? "terminal.closed" : "terminal.lost", {
				reason: next.closeReason,
			});
		} finally {
			this.#dispose();
		}
	}

	#changeOwner(attachmentId: TerminalAttachmentId | null): void {
		const previous = this.#session;
		const sequence = previous.eventSequence + 1;
		const next: TerminalSession = {
			...previous,
			eventSequence: sequence,
			ownershipEpoch: previous.ownershipEpoch + 1,
			revision: previous.revision + 1,
			updatedAt: this.#clock.now(),
		};
		this.#persist(next, previous);
		this.#session = next;
		this.#ownerAttachmentId = attachmentId;
		this.#publish({
			sequence,
			type: "terminal.resize_owner_changed",
			emittedAt: this.#clock.now(),
			ownerAttachmentId: attachmentId,
			ownershipEpoch: next.ownershipEpoch,
		});
	}

	#refreshConsumerActivity(): void {
		if (this.#session.status !== "active") return;
		const now = this.#clock.now();
		const hasConsumers =
			[...this.#attachments.values()].some((attachment) => attachment.state !== "disconnected") ||
			this.#runBindings.size > 0 ||
			this.#inFlightInteractions > 0;
		const previous = this.#session;
		const next: TerminalSession = {
			...previous,
			revision: previous.revision + 1,
			lastConsumerActivityAt: now,
			idleDeadlineAt: hasConsumers ? null : now + TERMINAL_DEFAULTS.lifecycle.idleTtlMs,
			updatedAt: now,
		};
		this.#persist(next, previous);
		this.#session = next;
	}

	#persist(next: TerminalSession, previous: TerminalSession): void {
		if (!this.#repository.updateSession(next, previous.status, previous.revision)) {
			throw new TerminalError("terminal_persistence_failed", "TerminalSession state could not be persisted", {
				status: 500,
				retryable: true,
			});
		}
	}

	#appendTimeline(type: Parameters<TerminalRepository["appendTimelineEvent"]>[0]["type"], data: unknown): void {
		this.#repository.appendTimelineEvent({
			id: this.#ids.next(),
			terminalSessionId: this.#session.id,
			sessionId: this.#session.sessionId,
			terminalEventSequence: this.#session.eventSequence,
			type,
			interactionId: null,
			observationId: null,
			agentRunId: null,
			data,
			createdAt: this.#clock.now(),
		});
	}

	#nextSequence(): number {
		this.#session = { ...this.#session, eventSequence: this.#session.eventSequence + 1 };
		return this.#session.eventSequence;
	}

	#publish(event: TerminalSequencedEvent): void {
		this.#ring.append(event);
		for (const listener of this.#listeners) listener(event);
	}

	#requireActive(): void {
		if (this.#session.status !== "active") {
			throw new TerminalError("terminal_session_unavailable", "TerminalSession is not active", {
				status: 409,
				retryable: this.#session.status === "opening" || this.#session.status === "closing",
				details: { terminalSessionId: this.#session.id, status: this.#session.status },
			});
		}
	}

	#requireAttachment(id: TerminalAttachmentId): TerminalAttachment {
		const attachment = this.#attachments.get(id);
		if (!attachment)
			throw new TerminalError("terminal_session_not_found", "Terminal attachment was not found", { status: 404 });
		return attachment;
	}

	#requireChannel(): TerminalChannelHandle {
		if (!this.#channel)
			throw new TerminalError("terminal_session_unavailable", "Terminal channel is unavailable", { status: 409 });
		return this.#channel;
	}

	#dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#humanCheckpointTimer !== undefined) clearTimeout(this.#humanCheckpointTimer);
		this.#finalCapture = {
			sequence: this.#session.eventSequence,
			geometry: this.#canonical.geometry,
			screenText: this.#canonical.currentScreenText(),
			allText: this.#canonical.allText(),
		};
		this.#channel?.dispose();
		this.#canonical.dispose();
		this.#listeners.clear();
		for (const attachment of this.#attachments.values()) {
			if (attachment.bootstrapTimer !== undefined) clearTimeout(attachment.bootstrapTimer);
			if (attachment.reconnectTimer !== undefined) clearTimeout(attachment.reconnectTimer);
		}
		this.#attachments.clear();
		this.#sessionLease.release();
		this.#onDisposed();
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		// A snapshot, input, resize or lifecycle operation seals the preceding output batch.
		// Only adjacent SSH output may share a canonical write and event sequence.
		this.#pendingOutput = null;
		const result = this.#tail.then(operation);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#disconnectAttachment(attachmentId: TerminalAttachmentId): void {
		const attachment = this.#attachments.get(attachmentId);
		if (!attachment || this.#disposed) return;
		attachment.state = "disconnected";
		const previousControl = this.#input.view;
		this.#input.release(attachmentId);
		this.#publishInputControl(previousControl);
		if (this.#ownerAttachmentId === attachmentId) this.#changeOwner(null);
		if (attachment.reconnectTimer !== undefined) clearTimeout(attachment.reconnectTimer);
		attachment.reconnectTimer = setTimeout(
			() => void this.detach(attachmentId),
			TERMINAL_DEFAULTS.lifecycle.reconnectGraceMs,
		);
		attachment.reconnectTimer.unref();
		this.#refreshConsumerActivity();
	}

	#capture(): TerminalCanonicalCapture {
		return { sequence: this.#session.eventSequence, geometry: this.#canonical.geometry,
			screenText: this.#canonical.currentScreenText(), allText: this.#canonical.allText() };
	}

	async #writeHumanBytes(bytes: Uint8Array): Promise<void> {
		const channel = this.#requireChannel();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([channel.write(bytes), new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					try { channel.dispose(); } catch (error) { reject(error); return; }
					reject(new Error("Terminal input write timed out"));
				}, TERMINAL_DEFAULTS.input.writeTimeoutMs);
				timer.unref();
			})]);
		} finally { if (timer !== undefined) clearTimeout(timer); }
	}

	#publishInputControl(previous: TerminalInputControl): void {
		if (previous === this.#input.view || this.#disposed) return;
		const control = this.#input.view;
		const before = this.#session;
		const sequence = before.eventSequence + 1;
		const next = { ...before, eventSequence: sequence, revision: before.revision + 1, updatedAt: this.#clock.now() };
		this.#persist(next, before);
		this.#session = next;
		this.#publish({ type: "terminal.control_changed", sequence, emittedAt: this.#clock.now(), data: { ...control } });
	}

	#scheduleHumanCheckpoint(): void {
		if (!this.#human.active || this.#humanCheckpointTimer !== undefined) return;
		this.#humanCheckpointTimer = setTimeout(() => {
			this.#humanCheckpointTimer = undefined;
			void this.#enqueue(async () => {
				if (!this.#disposed) this.#human.checkpoint(this.#capture());
			}).catch((error: unknown) => this.#handleRuntimeFailure(error));
		}, 250);
		this.#humanCheckpointTimer.unref();
	}
}

function requireGeometry(geometry: TerminalGeometry): void {
	const limits = TERMINAL_DEFAULTS.geometry;
	if (
		!Number.isInteger(geometry.rows) ||
		!Number.isInteger(geometry.cols) ||
		geometry.rows < limits.minRows ||
		geometry.rows > limits.maxRows ||
		geometry.cols < limits.minCols ||
		geometry.cols > limits.maxCols
	) {
		throw new TerminalError("terminal_resize_invalid", "Terminal geometry is outside the supported range", {
			status: 400,
		});
	}
}
