import type { Clock, SessionId } from "../../domain/ids.ts";

export type SessionCommandScheduleResult<TResult> =
	| { kind: "executed"; result: TResult }
	| { kind: "queue_timeout" }
	| { kind: "cancelled_before_dispatch" };

export interface ScheduleSessionCommandInput<TResult> {
	sessionId: SessionId;
	deadlineAt: number;
	signal?: AbortSignal;
	execute(): Promise<TResult>;
}

type ScheduledCommandState = "waiting" | "started" | "settled";

interface ScheduledCommand<TResult> extends ScheduleSessionCommandInput<TResult> {
	state: ScheduledCommandState;
	timeout?: ReturnType<typeof setTimeout>;
	abortListener?: () => void;
	cancelPermitRequest?: () => void;
	resolve(result: SessionCommandScheduleResult<TResult>): void;
	reject(error: unknown): void;
}

interface SessionLane<TResult> {
	readonly queue: ScheduledCommand<TResult>[];
	consuming: boolean;
}

interface PermitRequest {
	promise: Promise<PermitRelease | undefined>;
	cancel(): void;
}

type PermitRelease = () => void;

interface PermitWaiter {
	waiting: boolean;
	resolve(release: PermitRelease | undefined): void;
}

export class SessionCommandScheduler<TResult> {
	private readonly clock: Clock;
	private readonly permits: FairPermitLimiter;
	private readonly lanes = new Map<SessionId, SessionLane<TResult>>();

	constructor(options: { clock: Clock; maxConcurrentOperations: number }) {
		this.clock = options.clock;
		this.permits = new FairPermitLimiter(options.maxConcurrentOperations);
	}

	schedule(input: ScheduleSessionCommandInput<TResult>): Promise<SessionCommandScheduleResult<TResult>> {
		return new Promise<SessionCommandScheduleResult<TResult>>((resolve, reject) => {
			const command: ScheduledCommand<TResult> = {
				...input,
				state: "waiting",
				resolve,
				reject,
			};
			if (input.signal?.aborted) {
				this.settleWaiting(command, "cancelled_before_dispatch");
				return;
			}
			if (this.clock.now() >= input.deadlineAt) {
				this.settleWaiting(command, "queue_timeout");
				return;
			}
			command.abortListener = () => this.settleWaiting(command, "cancelled_before_dispatch");
			input.signal?.addEventListener("abort", command.abortListener, { once: true });
			command.timeout = setTimeout(
				() => this.settleWaiting(command, "queue_timeout"),
				Math.max(0, input.deadlineAt - this.clock.now()),
			);
			const lane = this.lanes.get(input.sessionId) ?? this.createLane(input.sessionId);
			lane.queue.push(command);
			void this.consumeLane(input.sessionId, lane);
		});
	}

	private createLane(sessionId: SessionId): SessionLane<TResult> {
		const lane: SessionLane<TResult> = { queue: [], consuming: false };
		this.lanes.set(sessionId, lane);
		return lane;
	}

	private async consumeLane(sessionId: SessionId, lane: SessionLane<TResult>): Promise<void> {
		if (lane.consuming) return;
		lane.consuming = true;
		try {
			while (lane.queue.length > 0) {
				const command = lane.queue.shift();
				if (!command || command.state !== "waiting") continue;
				if (command.signal?.aborted) {
					this.settleWaiting(command, "cancelled_before_dispatch");
					continue;
				}
				if (this.clock.now() >= command.deadlineAt) {
					this.settleWaiting(command, "queue_timeout");
					continue;
				}
				const request = this.permits.acquire();
				command.cancelPermitRequest = request.cancel;
				const release = await request.promise;
				command.cancelPermitRequest = undefined;
				if (!release) continue;
				if (command.state !== "waiting") {
					release();
					continue;
				}
				if (command.signal?.aborted) {
					this.settleWaiting(command, "cancelled_before_dispatch");
					release();
					continue;
				}
				if (this.clock.now() >= command.deadlineAt) {
					this.settleWaiting(command, "queue_timeout");
					release();
					continue;
				}
				command.state = "started";
				this.clearWaitingResources(command);
				try {
					const result = await command.execute();
					command.state = "settled";
					command.resolve({ kind: "executed", result });
				} catch (error) {
					command.state = "settled";
					command.reject(error);
				} finally {
					release();
				}
			}
		} finally {
			lane.consuming = false;
			if (lane.queue.length === 0 && this.lanes.get(sessionId) === lane) {
				this.lanes.delete(sessionId);
			} else if (lane.queue.length > 0) {
				void this.consumeLane(sessionId, lane);
			}
		}
	}

	private settleWaiting(
		command: ScheduledCommand<TResult>,
		kind: Extract<SessionCommandScheduleResult<TResult>["kind"], "queue_timeout" | "cancelled_before_dispatch">,
	): boolean {
		if (command.state !== "waiting") return false;
		command.state = "settled";
		this.clearWaitingResources(command);
		command.cancelPermitRequest?.();
		command.cancelPermitRequest = undefined;
		command.resolve({ kind });
		return true;
	}

	private clearWaitingResources(command: ScheduledCommand<TResult>): void {
		if (command.timeout !== undefined) {
			clearTimeout(command.timeout);
			command.timeout = undefined;
		}
		if (command.abortListener) {
			command.signal?.removeEventListener("abort", command.abortListener);
			command.abortListener = undefined;
		}
	}
}

class FairPermitLimiter {
	private readonly maximum: number;
	private active = 0;
	private readonly waiters: PermitWaiter[] = [];

	constructor(maximum: number) {
		if (!Number.isSafeInteger(maximum) || maximum <= 0) {
			throw new Error("maxConcurrentOperations must be a positive safe integer");
		}
		this.maximum = maximum;
	}

	acquire(): PermitRequest {
		if (this.active < this.maximum) {
			this.active += 1;
			return { promise: Promise.resolve(this.createRelease()), cancel: () => {} };
		}
		let resolveRequest: (release: PermitRelease | undefined) => void = () => {};
		const waiter: PermitWaiter = {
			waiting: true,
			resolve: (release) => resolveRequest(release),
		};
		const promise = new Promise<PermitRelease | undefined>((resolve) => {
			resolveRequest = resolve;
		});
		this.waiters.push(waiter);
		return {
			promise,
			cancel: () => {
				if (!waiter.waiting) return;
				waiter.waiting = false;
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				waiter.resolve(undefined);
			},
		};
	}

	private createRelease(): PermitRelease {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active -= 1;
			while (this.waiters.length > 0) {
				const waiter = this.waiters.shift();
				if (!waiter?.waiting) continue;
				waiter.waiting = false;
				this.active += 1;
				waiter.resolve(this.createRelease());
				break;
			}
		};
	}
}
