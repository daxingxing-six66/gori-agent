import type { Clock, IdGenerator, SessionId } from "../../domain/ids.ts";
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
import { TerminalRuntimeRegistry } from "../terminal/terminal-runtime-registry.ts";
import type {
	TerminalAttachmentBootstrap,
	TerminalEventListener,
	TerminalEventStreamConnection,
	TerminalResizeOwnership,
} from "../terminal/terminal-session-actor.ts";
import { TerminalSessionActor } from "../terminal/terminal-session-actor.ts";
import type { SessionLifecycleCoordinator, SessionUseLease } from "./session-lifecycle-coordinator.ts";
import type { SshTargetResolver } from "./ssh-target-resolver.ts";

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
	readonly #targets: SshTargetResolver;
	readonly #broker: TerminalChannelBroker;
	readonly #lifecycle: SessionLifecycleCoordinator;
	readonly #registry: TerminalRuntimeRegistry;
	readonly #clock: Clock;
	readonly #ids: IdGenerator;
	readonly #hasActiveChatRun: (sessionId: SessionId) => Promise<boolean>;
	readonly #openTimeoutMs: number;
	readonly #openingControllers = new Map<string, AbortController>();
	readonly #idleTimer: ReturnType<typeof setInterval>;
	#closed = false;

	constructor(options: {
		sessions: SessionRepository;
		terminals: TerminalRepository;
		targets: SshTargetResolver;
		broker: TerminalChannelBroker;
		lifecycle: SessionLifecycleCoordinator;
		registry?: TerminalRuntimeRegistry;
		clock: Clock;
		ids: IdGenerator;
		hasActiveChatRun: (sessionId: SessionId) => Promise<boolean>;
		openTimeoutMs?: number;
	}) {
		this.#sessions = options.sessions;
		this.#terminals = options.terminals;
		this.#targets = options.targets;
		this.#broker = options.broker;
		this.#lifecycle = options.lifecycle;
		this.#registry = options.registry ?? new TerminalRuntimeRegistry();
		this.#clock = options.clock;
		this.#ids = options.ids;
		this.#hasActiveChatRun = options.hasActiveChatRun;
		this.#openTimeoutMs = options.openTimeoutMs ?? TERMINAL_DEFAULTS.lifecycle.openTimeoutMs;
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
		if (this.#closed)
			throw new TerminalError("terminal_session_unavailable", "Terminal service is closing", { status: 503 });
		const existingRequest = this.#terminals.findSessionByOpenRequest(input.sessionId, input.requestId);
		if (existingRequest) return existingRequest;
		const useLease = this.#lifecycle.acquireUse(input.sessionId, "terminal_open");
		try {
			const session = await this.#sessions.findById(input.sessionId);
			if (!session) throw new TerminalError("terminal_session_not_found", "Session was not found", { status: 404 });
			if (await this.#hasActiveChatRun(input.sessionId)) {
				throw new TerminalError("session_has_active_chat_run", "Session has an active Chat Run", { status: 409 });
			}
			const current = this.#terminals.findCurrentSession(input.sessionId);
			if (current && isLiveTerminalStatus(current.status)) {
				throw new TerminalError(
					"terminal_session_already_active",
					"Session already has an active TerminalSession",
					{
						status: 409,
						details: { terminalSessionId: current.id, status: current.status },
					},
				);
			}
			const geometry = requireGeometry(input.rows, input.cols);
			const reservation = this.#registry.reserve();
			if (!reservation) {
				throw new TerminalError("terminal_capacity_exceeded", "Process Terminal capacity exceeded", {
					status: 429,
					retryable: true,
				});
			}
			let sessionLease: SessionUseLease | undefined;
			let actor: TerminalSessionActor | undefined;
			let runtimeOwnsResources = false;
			try {
				sessionLease = this.#lifecycle.acquireUse(input.sessionId, "terminal_session");
				const now = this.#clock.now();
				const terminal: TerminalSession = {
					id: this.#ids.next(),
					sessionId: session.id,
					workspaceId: session.workspaceId,
					openRequestId: input.requestId,
					closeRequestId: null,
					status: "opening",
					revision: 1,
					geometry,
					eventSequence: 0,
					ownershipEpoch: 0,
					connectionGeneration: null,
					term: "xterm-256color",
					activatedAt: null,
					lastConsumerActivityAt: now,
					idleDeadlineAt: null,
					closingAt: null,
					closedAt: null,
					closeReason: null,
					failureCode: null,
					failureMessage: null,
					createdAt: now,
					updatedAt: now,
				};
				this.#terminals.insertSession(terminal);
				const createdActor = new TerminalSessionActor({
					session: terminal,
					repository: this.#terminals,
					clock: this.#clock,
					ids: this.#ids,
					sessionLease,
					onDisposed: () => {
						this.#registry.remove(createdActor);
						reservation.release();
					},
				});
				actor = createdActor;
				this.#registry.register(createdActor);
				runtimeOwnsResources = true;
				this.#terminals.appendTimelineEvent({
					id: this.#ids.next(),
					terminalSessionId: terminal.id,
					sessionId: terminal.sessionId,
					terminalEventSequence: 0,
					type: "terminal.opening",
					interactionId: null,
					observationId: null,
					agentRunId: null,
					data: { rows: geometry.rows, cols: geometry.cols },
					createdAt: now,
				});
				const controller = new AbortController();
				this.#openingControllers.set(createdActor.id, controller);
				void this.#startActor(createdActor, controller);
				return terminal;
			} catch (error) {
				if (runtimeOwnsResources) {
					await actor?.failOpening(
						"terminal_initialization_failed",
						error instanceof Error ? error.message : "Terminal initialization failed",
					);
				} else {
					sessionLease?.release();
					reservation.release();
				}
				throw error;
			}
		} finally {
			useLease.release();
		}
	}

	async close(input: CloseTerminalInput): Promise<TerminalSession> {
		if (await this.#hasActiveChatRun(input.sessionId)) {
			throw new TerminalError("session_has_active_chat_run", "Session has an active Chat Run", { status: 409 });
		}
		const actor = this.#registry.findBySession(input.sessionId);
		if (!actor || actor.id !== input.terminalSessionId) {
			const persisted = this.#terminals.findSession(input.terminalSessionId);
			if (!persisted || persisted.sessionId !== input.sessionId) {
				throw new TerminalError("terminal_session_not_found", "TerminalSession was not found", { status: 404 });
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

	async attach(sessionId: SessionId, requestId: string): Promise<TerminalAttachmentBootstrap> {
		return this.#withActor(sessionId, (actor) => actor.createAttachment(requestId, this.#ids.next()));
	}

	async ready(sessionId: SessionId, attachmentId: string, replayedThroughSequence: number): Promise<void> {
		await this.#withActor(sessionId, (actor) => actor.markAttachmentReady(attachmentId, replayedThroughSequence));
	}

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
		const actor = this.#registry.findBySession(sessionId);
		if (!actor || actor.id !== current?.id) {
			throw new TerminalError("terminal_session_unavailable", "Active TerminalSession runtime is unavailable", {
				status: 409,
				retryable: true,
			});
		}
		await actor.bindRun(runId);
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
		let openTimeout: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		const timeoutError = new TerminalError("terminal_open_timeout", "Timed out opening the SSH terminal channel", {
			status: 504,
			retryable: true,
		});
		try {
			const open = Promise.resolve().then(async () => {
				const target = await this.#targets.resolve(actor.sessionId);
				return this.#broker.open({
					target,
					geometry: actor.view.geometry,
					term: "xterm-256color",
					signal: controller.signal,
					onData: (bytes) => actor.acceptSshData(bytes),
				});
			});
			const timeout = new Promise<never>((_resolve, reject) => {
				openTimeout = setTimeout(() => {
					timedOut = true;
					controller.abort();
					reject(timeoutError);
				}, this.#openTimeoutMs);
				openTimeout.unref();
			});
			void open.then(
				(channel) => {
					if (timedOut) channel.dispose();
				},
				() => undefined,
			);
			const channel = await Promise.race([open, timeout]);
			if (timedOut) {
				channel.dispose();
				throw timeoutError;
			}
			await actor.activate(channel);
		} catch (error) {
			await actor.failOpening(
				error instanceof TerminalError ? error.code : "terminal_open_failed",
				error instanceof Error ? error.message : "Terminal open failed",
			);
		} finally {
			if (openTimeout !== undefined) clearTimeout(openTimeout);
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
