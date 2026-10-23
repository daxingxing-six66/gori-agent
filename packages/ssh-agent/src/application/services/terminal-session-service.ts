import type { Clock, IdGenerator, SessionId } from "../../domain/ids.ts";
import type { TerminalInputControl, TerminalHumanInputRequest, TerminalHumanActivity } from "../../domain/terminal-human.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import type {
	TerminalCloseReason,
	TerminalGeometry,
	TerminalObservation,
	TerminalSession,
	TerminalTimelineEvent,
} from "../../domain/terminal.ts";
import { effectiveServerInteractionMode, isLiveTerminalStatus, TerminalError } from "../../domain/terminal.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import type { TerminalRepository } from "../repositories/terminal-repository.ts";
import type { TerminalChannelBroker } from "../ssh-channel-broker.ts";
import { TERMINAL_DEFAULTS } from "../terminal/terminal-defaults.ts";
import { TerminalChannelOpener } from "../terminal/terminal-channel-opener.ts";
import { TerminalRuntimeRegistry } from "../terminal/terminal-runtime-registry.ts";
import type {
	TerminalAttachmentBootstrap,
	TerminalEventListener,
	TerminalEventStreamConnection,
	TerminalResizeOwnership,
} from "../terminal/terminal-session-actor.ts";
import { TerminalSessionActor } from "../terminal/terminal-session-actor.ts";
import { settleHumanActivity } from "../terminal/terminal-human-handoff-settle.ts";
import type { SessionLifecycleCoordinator, SessionUseLease } from "./session-lifecycle-coordinator.ts";
import type { SshTargetResolver } from "./ssh-target-resolver.ts";
import type { RemoteSandboxProvider } from "./remote-sandbox-provider.ts";
import type { Session } from "../../domain/session.ts";
import { sessionSandboxMode } from "./session-sandbox-policy.ts";

export interface OpenTerminalInput {
	readonly sessionId: SessionId;
	readonly requestId: string;
	readonly rows?: number;
	readonly cols?: number;
}

export interface CloseTerminalInput {
	readonly sessionId: SessionId;
	readonly terminalSessionId: string;
	readonly requestId: string;
	readonly reason?: TerminalCloseReason;
}

export interface TerminalStatusView {
	readonly inputControl: TerminalInputControl;
	readonly terminal: TerminalSession | null;
	readonly effectiveServerInteractionMode: "command" | "terminal";
	readonly transitionInProgress: boolean;
	readonly capabilities: {
		readonly minRows: number;
		readonly maxRows: number;
		readonly minCols: number;
		readonly maxCols: number;
	};
}

export class TerminalSessionService {
	readonly #sessions: SessionRepository;
	readonly #terminals: TerminalRepository;
	readonly #opener: TerminalChannelOpener;
	readonly #lifecycle: SessionLifecycleCoordinator;
	readonly #registry: TerminalRuntimeRegistry;
	readonly #clock: Clock;
	readonly #ids: IdGenerator;
	readonly #hasActiveChatRun: (sessionId: SessionId) => Promise<boolean>;
	readonly #openingControllers = new Map<string, AbortController>();
	readonly #idleTimer: ReturnType<typeof setInterval>;
	#closed = false;

	constructor(options: {
		sessions: SessionRepository;
		terminals: TerminalRepository;
		targets: SshTargetResolver;
		broker: TerminalChannelBroker;
		sandbox: RemoteSandboxProvider;
		lifecycle: SessionLifecycleCoordinator;
		registry?: TerminalRuntimeRegistry;
		clock: Clock;
		ids: IdGenerator;
		hasActiveChatRun: (sessionId: SessionId) => Promise<boolean>;
		openTimeoutMs?: number;
	}) {
		this.#sessions = options.sessions;
		this.#terminals = options.terminals;
		this.#opener = new TerminalChannelOpener({
			targets: options.targets, sandbox: options.sandbox, broker: options.broker,
			timeoutMs: options.openTimeoutMs ?? TERMINAL_DEFAULTS.lifecycle.openTimeoutMs,
			sessions: options.sessions,
		});
		this.#lifecycle = options.lifecycle;
		this.#registry = options.registry ?? new TerminalRuntimeRegistry();
		this.#clock = options.clock;
		this.#ids = options.ids;
		this.#hasActiveChatRun = options.hasActiveChatRun;
		this.#idleTimer = setInterval(() => this.#scanIdle(), TERMINAL_DEFAULTS.lifecycle.idleScanIntervalMs);
		this.#idleTimer.unref();
	}

	get(sessionId: SessionId): TerminalSession | null {
		return this.#terminals.findCurrentSession(sessionId) ?? null;
	}

	async getStatus(sessionId: SessionId): Promise<TerminalStatusView> {
		if (!(await this.#sessions.findById(sessionId))) {
			throw new TerminalError("terminal_session_not_found", "Session was not found", { status: 404 });
		}
		const terminal = this.get(sessionId);
		return {
			inputControl: this.getActor(sessionId)?.inputControl ?? { mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 },
			terminal,
			effectiveServerInteractionMode: effectiveServerInteractionMode(terminal?.status ?? null),
			transitionInProgress: terminal?.status === "opening" || terminal?.status === "closing",
			capabilities: {
				minRows: TERMINAL_DEFAULTS.geometry.minRows,
				maxRows: TERMINAL_DEFAULTS.geometry.maxRows,
				minCols: TERMINAL_DEFAULTS.geometry.minCols,
				maxCols: TERMINAL_DEFAULTS.geometry.maxCols,
			},
		};
	}

	getActor(sessionId: SessionId): TerminalSessionActor | undefined {
		return this.#registry.findBySession(sessionId);
	}

	async open(input: OpenTerminalInput): Promise<TerminalSession> {
		this.#requireOpenAvailable();
		const existing = this.#terminals.findSessionByOpenRequest(input.sessionId, input.requestId);
		if (existing) {
			return existing;
		}
		const lease = this.#lifecycle.acquireUse(input.sessionId, "terminal_open");
		try {
			const session = await this.#requireOpenSession(input.sessionId);
			this.#requireOpenState(input.sessionId);
			return await this.#createRuntime(input, session, requireGeometry(input.rows, input.cols));
		} finally {
			lease.release();
		}
	}

	#requireOpenAvailable(): void {
		if (this.#closed)
			throw new TerminalError("terminal_session_unavailable", "Terminal service is closing", { status: 503 });
	}

	async #requireNoActiveChatRun(sessionId: SessionId): Promise<void> {
		if (await this.#hasActiveChatRun(sessionId)) {
			throw new TerminalError("session_has_active_chat_run", "Session has an active Chat Run", { status: 409 });
		}
	}

	async #requireOpenSession(sessionId: SessionId) {
		const session = await this.#sessions.findById(sessionId);
		if (!session) throw new TerminalError("terminal_session_not_found", "Session was not found", { status: 404 });
		await this.#requireNoActiveChatRun(sessionId);
		return session;
	}

	#requireOpenState(sessionId: SessionId): void {
		// Check after the final validation await; shutdown or another open may have completed.
		this.#requireOpenAvailable();
		const current = this.#terminals.findCurrentSession(sessionId);
		if (current && isLiveTerminalStatus(current.status)) {
			throw new TerminalError("terminal_session_already_active", "Session already has an active TerminalSession", {
				status: 409, details: { terminalSessionId: current.id, status: current.status },
			});
		}
	}

	async #createRuntime(input: OpenTerminalInput, session: Session, geometry: TerminalGeometry): Promise<TerminalSession> {
		const reservation = this.#registry.reserve();
		if (!reservation) {
			throw new TerminalError("terminal_capacity_exceeded", "Process Terminal capacity exceeded", {
				status: 429, retryable: true,
			});
		}
		let sessionLease: SessionUseLease | undefined;
		let actor: TerminalSessionActor | undefined;
		try {
			sessionLease = this.#lifecycle.acquireUse(input.sessionId, "terminal_session");
			const terminal = this.#newOpeningSession(input, session, geometry);
			this.#terminals.insertSession(terminal);
			const createdActor = new TerminalSessionActor({
				session: terminal, repository: this.#terminals, clock: this.#clock, ids: this.#ids, sessionLease,
				onDisposed: () => { this.#registry.remove(createdActor); reservation.release(); },
			});
			// Once constructed, the Actor owns the Session lease and capacity reservation.
			actor = createdActor;
			this.#registry.register(createdActor);
			this.#appendOpeningTimeline(terminal);
			const controller = new AbortController();
			this.#openingControllers.set(actor.id, controller);
			void this.#startActor(actor, controller);
			return terminal;
		} catch (error) {
			if (actor) {
				await actor.failOpening("terminal_initialization_failed", error instanceof Error ? error.message : "Terminal initialization failed");
			} else {
				sessionLease?.release();
				reservation.release();
			}
			throw error;
		}
	}

	#newOpeningSession(input: OpenTerminalInput, session: Session, geometry: TerminalGeometry): TerminalSession {
		const now = this.#clock.now();
		return {
			id: this.#ids.next(), sessionId: input.sessionId, workspaceId: session.workspaceId, openRequestId: input.requestId,
			closeRequestId: null, status: "opening", requestedSandboxMode: sessionSandboxMode(session), sandbox: null,
			revision: 1, geometry, eventSequence: 0, ownershipEpoch: 0, connectionGeneration: null,
			term: "xterm-256color", activatedAt: null, lastConsumerActivityAt: now, idleDeadlineAt: null,
			closingAt: null, closedAt: null, closeReason: null, failureCode: null, failureMessage: null,
			createdAt: now, updatedAt: now,
		};
	}

	#appendOpeningTimeline(terminal: TerminalSession): void {
		this.#terminals.appendTimelineEvent({
			id: this.#ids.next(), terminalSessionId: terminal.id, sessionId: terminal.sessionId, terminalEventSequence: 0,
			type: "terminal.opening", interactionId: null, observationId: null, agentRunId: null,
			data: { rows: terminal.geometry.rows, cols: terminal.geometry.cols, requestedSandboxMode: terminal.requestedSandboxMode },
			createdAt: terminal.createdAt,
		});
	}

	async close(input: CloseTerminalInput): Promise<TerminalSession> {
		await this.#requireNoActiveChatRun(input.sessionId);
		const actor = this.#registry.findBySession(input.sessionId);
		if (!actor || actor.id !== input.terminalSessionId) {
			const persisted = this.#terminals.findSession(input.terminalSessionId);
			if (!persisted || persisted.sessionId !== input.sessionId) {
				throw new TerminalError("terminal_session_not_found", "TerminalSession was not found", { status: 404 });
			}
			if (!actor && isLiveTerminalStatus(persisted.status)) {
				const now = this.#clock.now();
				const lost: TerminalSession = {
					...persisted,
					status: "lost",
					closeRequestId: input.requestId,
					closeReason: "connection_lost",
					closedAt: now,
					eventSequence: persisted.eventSequence + 1,
					revision: persisted.revision + 1,
					updatedAt: now,
				};
				if (this.#terminals.updateSession(lost, persisted.status, persisted.revision)) {
					this.#terminals.appendTimelineEvent({
						id: this.#ids.next(),
						terminalSessionId: lost.id,
						sessionId: lost.sessionId,
						terminalEventSequence: lost.eventSequence,
						type: "terminal.lost",
						interactionId: null,
						observationId: null,
						agentRunId: null,
						data: { reason: lost.closeReason },
						createdAt: now,
					});
					return lost;
				}
				return this.#terminals.findSession(input.terminalSessionId) ?? persisted;
			}
			return persisted;
		}
		this.#openingControllers.get(actor.id)?.abort();
		await actor.close(input.reason ?? "user_requested", input.requestId);
		return this.#terminals.findSession(input.terminalSessionId) ?? actor.view;
	}

	async closeForSessionDeletion(sessionId: SessionId): Promise<void> {
		const actor = this.#registry.findBySession(sessionId);
		if (actor) {
			this.#openingControllers.get(actor.id)?.abort();
			await actor.close("session_deleted");
		}
	}

	/** Called only while SessionService owns the sandbox_update lifecycle lease. */
	async reconfigureSandbox(sessionId: SessionId, persist: () => Promise<Session>): Promise<Session> {
		const current = this.get(sessionId);
		if (current?.status === "opening" || current?.status === "closing") {
			throw new TerminalError("terminal_transition_in_progress", "Wait for the Terminal transition before changing sandbox mode", { status: 409 });
		}
		if (current?.status !== "active") return persist();
		await this.close({ sessionId, terminalSessionId: current.id, requestId: this.#ids.next() });
		let session: Session;
		try { session = await persist(); }
		catch (error) {
			await this.#restorePreviousTerminal(sessionId, current.geometry);
			throw error;
		}
		await this.#reopenAfterConfiguration(session, current.geometry);
		return session;
	}

	async #restorePreviousTerminal(sessionId: SessionId, geometry: TerminalGeometry): Promise<void> {
		try {
			const unchanged = await this.#sessions.findById(sessionId);
			if (unchanged) await this.#reopenAfterConfiguration(unchanged, geometry);
		} catch (error) {
			// Restoration is best effort; retain the original setting persistence error.
			console.error("Failed to restore Terminal after Session configuration failure", { sessionId, error });
		}
	}

	async #reopenAfterConfiguration(session: Session, geometry: TerminalGeometry): Promise<void> {
		this.#requireOpenState(session.id);
		await this.#createRuntime({ sessionId: session.id, requestId: this.#ids.next() }, session, geometry);
	}

	async attach(sessionId: SessionId, requestId: string): Promise<TerminalAttachmentBootstrap> {
		return this.#withActor(sessionId, (actor) => actor.createAttachment(requestId, this.#ids.next()));
	}

	async ready(sessionId: SessionId, attachmentId: string, replayedThroughSequence: number): Promise<void> {
		await this.#withActor(sessionId, (actor) => actor.markAttachmentReady(attachmentId, replayedThroughSequence));
	}

	async controlInput(sessionId: SessionId, attachmentId: string, claim: boolean): Promise<TerminalInputControl> {
		if (claim) await this.#requireNoActiveChatRun(sessionId);
		return this.#withActor(sessionId, (actor) => actor.controlInput(attachmentId, claim));
	}

	async writeHumanInput(sessionId: SessionId, attachmentId: string, input: TerminalHumanInputRequest): Promise<{ acceptedSequence: number }> {
		await this.#requireNoActiveChatRun(sessionId);
		return this.#withActor(sessionId, (actor) => actor.writeHumanInput(attachmentId, input));
	}

	latestHumanActivity(sessionId: SessionId): TerminalHumanActivity | null { return this.#terminals.latestHumanActivity(sessionId); }

	async focus(sessionId: SessionId, attachmentId: string, focused: boolean): Promise<TerminalResizeOwnership> {
		return this.#withActor(sessionId, (actor) =>
			focused ? actor.claimResizeOwnership(attachmentId) : actor.releaseResizeOwnership(attachmentId),
		);
	}

	async resize(
		sessionId: SessionId,
		attachmentId: string,
		ownershipEpoch: number,
		geometry: TerminalGeometry,
	): Promise<void> {
		await this.#withActor(sessionId, (actor) => actor.resize(attachmentId, ownershipEpoch, geometry));
	}

	async detach(sessionId: SessionId, attachmentId: string): Promise<void> {
		await this.#withActor(sessionId, (actor) => actor.detach(attachmentId));
	}

	async connectEvents(
		sessionId: SessionId,
		attachmentId: string,
		afterSequence: number,
		listener: TerminalEventListener,
	): Promise<{ readonly terminalSessionId: string; readonly connection: TerminalEventStreamConnection }> {
		return this.#withActor(sessionId, async (actor) => ({
			terminalSessionId: actor.id,
			connection: await actor.connectEventStream(attachmentId, afterSequence, listener),
		}));
	}

	async bindRun(sessionId: SessionId, runId: string, requestedMode: "command" | "terminal"): Promise<string | null> {
		const current = this.get(sessionId);
		if (current?.status === "opening") {
			throw new TerminalError("terminal_transition_in_progress", "Terminal Mode is still opening", {
				status: 409,
				retryable: true,
			});
		}
		const effective = effectiveServerInteractionMode(current?.status ?? null);
		if (requestedMode !== effective) {
			throw new TerminalError(
				requestedMode === "terminal" ? "terminal_session_unavailable" : "server_interaction_mode_conflict",
				"Requested server interaction mode does not match the current Session mode",
				{ status: 409, retryable: true },
			);
		}
		if (requestedMode === "command") return null;
		if (!current?.sandbox) throw new TerminalError("terminal_session_unavailable", "Active Terminal sandbox state is unknown", { status: 409 });
		const actor = this.#registry.findBySession(sessionId);
		if (!actor || actor.id !== current?.id) {
			throw new TerminalError("terminal_session_unavailable", "Active TerminalSession runtime is unavailable", {
				status: 409,
				retryable: true,
			});
		}
		await actor.bindRun(runId);
		try {
			if (actor.hasPendingHumanActivity) {
				await settleHumanActivity(actor);
				await actor.finishHumanHandoff(runId);
			}
		} catch (error) { await actor.unbindRun(runId); throw error; }
		return actor.id;
	}

	async unbindRun(sessionId: SessionId, runId: string): Promise<void> {
		await this.#registry.findBySession(sessionId)?.unbindRun(runId);
	}

	listTimeline(sessionId: SessionId, beforeSequence?: number, limit?: number): TerminalTimelineEvent[] {
		return this.#terminals.listTimeline(sessionId, beforeSequence, limit);
	}

	getObservation(sessionId: SessionId, observationId: string): TerminalObservation {
		const observation = this.#terminals.findObservation(observationId);
		if (!observation)
			throw new TerminalError("terminal_observation_not_found", "Terminal Observation was not found", {
				status: 404,
			});
		const terminal = this.#terminals.findSession(observation.terminalSessionId);
		if (!terminal || terminal.sessionId !== sessionId) {
			throw new TerminalError("terminal_observation_not_found", "Terminal Observation was not found", {
				status: 404,
			});
		}
		return observation;
	}

	async shutdown(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		clearInterval(this.#idleTimer);
		for (const controller of this.#openingControllers.values()) controller.abort();
		await Promise.allSettled(this.#registry.list().map((actor) => actor.close("backend_shutdown")));
	}

	async #startActor(actor: TerminalSessionActor, controller: AbortController): Promise<void> {
		try {
			const { channel, sandbox } = await this.#opener.open(actor, controller);
			await actor.activate(channel, sandbox);
		} catch (error) {
			await actor.failOpening(
				error instanceof TerminalError ? error.code : error instanceof SshAgentError ? error.failure.code : "terminal_open_failed",
				error instanceof Error ? error.message : "Terminal open failed",
			);
		} finally {
			if (this.#openingControllers.get(actor.id) === controller) this.#openingControllers.delete(actor.id);
		}
	}

	#scanIdle(): void {
		const now = this.#clock.now();
		for (const terminal of this.#terminals.listIdleCandidates(now)) {
			void this.#registry.findById(terminal.id)?.checkIdle(now);
		}
	}

	async #withActor<T>(sessionId: SessionId, operation: (actor: TerminalSessionActor) => Promise<T>): Promise<T> {
		const lease = this.#lifecycle.acquireUse(sessionId, "terminal_open");
		try {
			const actor = this.#registry.findBySession(sessionId);
			if (!actor)
				throw new TerminalError("terminal_session_not_found", "Active TerminalSession was not found", {
					status: 404,
				});
			return await operation(actor);
		} finally {
			lease.release();
		}
	}
}

function requireGeometry(rows?: number, cols?: number): TerminalGeometry {
	const limits = TERMINAL_DEFAULTS.geometry;
	const geometry = { rows: rows ?? limits.rows, cols: cols ?? limits.cols };
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
	return geometry;
}
