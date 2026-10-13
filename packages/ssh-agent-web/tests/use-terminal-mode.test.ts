import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionStatus, TerminalSessionView, TerminalStatusResponse } from "../features/terminal/model/terminal";
import { TERMINAL_UI_DEFAULTS } from "../features/terminal/model/terminal-ui-defaults";
import { ApiError } from "../shared/errors/api-error";

const api = vi.hoisted(() => ({
	getStatus: vi.fn<(sessionId: string, signal?: AbortSignal) => Promise<TerminalStatusResponse>>(),
	open: vi.fn<(sessionId: string, requestId: string) => Promise<TerminalSessionView>>(),
	close: vi.fn<(sessionId: string, terminalId: string, requestId: string) => Promise<TerminalSessionView>>(),
}));
let hooks: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useState: (initial: unknown) => hooks.state(initial),
	useRef: (initial: unknown) => hooks.ref(initial),
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => hooks.effect(effect, deps),
	useCallback: <T,>(callback: T, deps: readonly unknown[]) => hooks.callback(callback, deps),
	useMemo: <T,>(factory: () => T, deps: readonly unknown[]) => hooks.memo(factory, deps),
}));
vi.mock("../features/terminal/api/terminal-api", () => ({ terminalApi: api }));
import { useTerminalMode as terminalModeHook } from "../features/terminal/runtime/use-terminal-mode";

/** Deterministic hook scheduling exercises races without creating a browser terminal. */
class HookDriver {
	private states: unknown[] = [];
	private refs: { current: unknown }[] = [];
	private effects: { deps: readonly unknown[]; cleanup?: () => void }[] = [];
	private callbacks: { deps: readonly unknown[]; value: unknown }[] = [];
	private memos: { deps: readonly unknown[]; value: unknown }[] = [];
	private queued: (() => void)[] = [];
	private stateIndex = 0;
	private refIndex = 0;
	private effectIndex = 0;
	private callbackIndex = 0;
	private memoIndex = 0;
	writes = 0;
	sessionId = "session";
	value!: ReturnType<typeof terminalModeHook>;

	state<T>(initial: T): [T, (next: T | ((current: T) => T)) => void] {
		const index = this.stateIndex++;
		if (!(index in this.states)) this.states[index] = initial;
		return [this.states[index] as T, (next) => {
			this.writes += 1;
			this.states[index] = typeof next === "function"
				? (next as (current: T) => T)(this.states[index] as T) : next;
		}];
	}

	ref<T>(initial: T): { current: T } {
		const index = this.refIndex++;
		this.refs[index] ??= { current: initial };
		return this.refs[index] as { current: T };
	}

	callback<T>(value: T, deps: readonly unknown[]): T {
		const index = this.callbackIndex++;
		const previous = this.callbacks[index];
		if (previous && sameDependencies(deps, previous.deps)) return previous.value as T;
		this.callbacks[index] = { deps, value };
		return value;
	}

	memo<T>(factory: () => T, deps: readonly unknown[]): T {
		const index = this.memoIndex++;
		const previous = this.memos[index];
		if (previous && sameDependencies(deps, previous.deps)) return previous.value as T;
		const value = factory();
		this.memos[index] = { deps, value };
		return value;
	}

	effect(effect: () => void | (() => void), deps: readonly unknown[]) {
		const index = this.effectIndex++;
		const previous = this.effects[index];
		if (previous && sameDependencies(deps, previous.deps)) return;
		this.queued.push(() => {
			previous?.cleanup?.();
			const cleanup = effect();
			this.effects[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
		});
	}

	render() {
		this.stateIndex = this.refIndex = this.effectIndex = this.callbackIndex = this.memoIndex = 0;
		this.value = terminalModeHook(this.sessionId);
		const queued = this.queued;
		this.queued = [];
		for (const effect of queued) effect();
		return this.value;
	}

	unmount() { for (const effect of this.effects) effect.cleanup?.(); }
}

function sameDependencies(left: readonly unknown[], right: readonly unknown[]) {
	return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function terminal(status: TerminalSessionStatus, sessionId = "session", id = "terminal"): TerminalSessionView {
	return { id, sessionId, workspaceId: "workspace", status, requestedSandboxMode: null, sandbox: null,
		geometry: { rows: 36, cols: 120 }, eventSequence: 0, ownershipEpoch: 0,
		closeReason: null, failureCode: null, failureMessage: null, createdAt: 1, updatedAt: 2 };
}

function status(value: TerminalSessionView | null = null): TerminalStatusResponse {
	return { terminal: value, effectiveServerInteractionMode: value?.status === "active" ? "terminal" : "command",
		transitionInProgress: value?.status === "opening" || value?.status === "closing",
		capabilities: { minRows: 12, maxRows: 120, minCols: 40, maxCols: 320 } };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail; });
	return { promise, resolve, reject };
}

async function settle() {
	for (let index = 0; index < 8; index++) await Promise.resolve();
	hooks.render();
}

async function load(value: TerminalStatusResponse) {
	api.getStatus.mockResolvedValue(value);
	await hooks.value.refresh();
	hooks.render();
}

beforeEach(async () => {
	vi.useFakeTimers();
	vi.resetAllMocks();
	api.getStatus.mockResolvedValue(status());
	api.open.mockResolvedValue(terminal("opening"));
	api.close.mockResolvedValue(terminal("closed"));
	hooks = new HookDriver();
	hooks.render();
	await settle();
});

afterEach(() => { hooks.unmount(); vi.useRealTimers(); });

describe("Terminal lifecycle hook", () => {
	it("does not mutate until the initial authoritative status is available", async () => {
		hooks.unmount();
		api.getStatus.mockRejectedValue(new ApiError(503, "status_error", "Status unavailable"));
		hooks = new HookDriver();
		hooks.render();
		await hooks.value.open();
		await settle();
		await hooks.value.open();
		expect(api.open).not.toHaveBeenCalled();
		expect(hooks.value).toMatchObject({ status: null, loading: false, error: "Status unavailable" });
	});

	it("locks competing open requests before another render and then follows background startup", async () => {
		const opening = deferred<TerminalSessionView>();
		api.open.mockReturnValueOnce(opening.promise);
		api.getStatus.mockResolvedValue(status(terminal("opening")));
		const open = hooks.value.open;
		const first = open();
		await open();
		expect(api.open).toHaveBeenCalledOnce();
		hooks.render();
		expect(hooks.value).toMatchObject({ transition: "connecting", mutating: true });
		opening.resolve(terminal("opening"));
		await first;
		hooks.render();
		expect(hooks.value.status?.terminal?.status).toBe("opening");
		await hooks.value.open();
		expect(api.open).toHaveBeenCalledOnce();
		api.getStatus.mockResolvedValue(status(terminal("active")));
		await vi.advanceTimersByTimeAsync(TERMINAL_UI_DEFAULTS.transitionPollMs);
		hooks.render();
		expect(hooks.value.status?.terminal?.status).toBe("active");
	});

	it.each(["active", "opening", "closing"] as const)("does not reopen an existing %s terminal", async (state) => {
		await load(status(terminal(state)));
		await hooks.value.open();
		expect(api.open).not.toHaveBeenCalled();
	});

	it("recovers the committed Terminal when an open response is lost", async () => {
		api.open.mockRejectedValueOnce(new ApiError(503, "network_error", "Open response lost"));
		api.getStatus.mockResolvedValue(status(terminal("active")));
		await hooks.value.open();
		hooks.render();
		expect(hooks.value).toMatchObject({ transition: null, openError: null });
		expect(hooks.value.status?.terminal?.status).toBe("active");
		expect(api.getStatus).toHaveBeenCalledTimes(2);
	});

	it("keeps an opening failure and permits a new retry after it settles", async () => {
		api.open.mockRejectedValueOnce(new ApiError(503, "open_error", "Unable to open"));
		api.getStatus.mockResolvedValue(status(terminal("failed")));
		await hooks.value.open();
		hooks.render();
		expect(hooks.value.openError).toBe("Unable to open");
		api.getStatus.mockResolvedValue(status(terminal("opening", "session", "retry-terminal")));
		await hooks.value.open();
		hooks.render();
		expect(api.open).toHaveBeenCalledTimes(2);
		expect(api.open.mock.calls[0]?.[1]).not.toBe(api.open.mock.calls[1]?.[1]);
		expect(hooks.value.openError).toBeNull();
		expect(hooks.value.status?.terminal?.id).toBe("retry-terminal");
	});

	it("locks competing closes and retains the disconnected and exiting transitions", async () => {
		await load(status(terminal("active")));
		const closing = deferred<TerminalSessionView>();
		api.close.mockReturnValueOnce(closing.promise);
		api.getStatus.mockResolvedValue(status(terminal("closed")));
		const close = hooks.value.close;
		const first = close();
		await close();
		expect(api.close).toHaveBeenCalledOnce();
		hooks.render();
		expect(hooks.value.transition).toBe("disconnecting");
		closing.resolve(terminal("closed"));
		await first;
		hooks.render();
		expect(hooks.value.transition).toBe("disconnected");
		await vi.advanceTimersByTimeAsync(TERMINAL_UI_DEFAULTS.disconnectedNoticeMs);
		hooks.render();
		expect(hooks.value.transition).toBe("exiting");
		await vi.advanceTimersByTimeAsync(TERMINAL_UI_DEFAULTS.panelTransitionMs);
		hooks.render();
		expect(hooks.value).toMatchObject({ transition: null, mutating: false });
	});

	it("refreshes after a rejected close and leaves a still-active terminal open", async () => {
		await load(status(terminal("active")));
		api.close.mockRejectedValueOnce(new ApiError(409, "active_run", "A run is active"));
		await hooks.value.close();
		hooks.render();
		expect(api.getStatus).toHaveBeenCalledTimes(3);
		expect(hooks.value).toMatchObject({ transition: null, error: "A run is active", mutating: false });
		expect(hooks.value.status?.terminal?.status).toBe("active");
	});

	it("remains busy if terminal events finish before the close HTTP response", async () => {
		await load(status(terminal("active")));
		const pending = deferred<TerminalSessionView>();
		api.close.mockReturnValueOnce(pending.promise);
		const closing = hooks.value.close();
		await load(status(terminal("closed")));
		await vi.advanceTimersByTimeAsync(TERMINAL_UI_DEFAULTS.disconnectedNoticeMs);
		hooks.render();
		await vi.advanceTimersByTimeAsync(TERMINAL_UI_DEFAULTS.panelTransitionMs);
		hooks.render();
		expect(hooks.value).toMatchObject({ transition: null, mutating: true });
		await hooks.value.open();
		expect(api.open).not.toHaveBeenCalled();
		pending.resolve(terminal("closed"));
		await closing;
		hooks.render();
		expect(hooks.value.mutating).toBe(false);
	});

	it("retries status reading after the close succeeded but its refresh failed", async () => {
		await load(status(terminal("active")));
		api.getStatus.mockRejectedValueOnce(new ApiError(503, "status_error", "Status unavailable"))
			.mockResolvedValueOnce(status(terminal("closed")));
		await hooks.value.close();
		hooks.render();
		expect(api.getStatus).toHaveBeenCalledTimes(4);
		expect(hooks.value.transition).toBe("disconnected");
		expect(hooks.value.status?.terminal?.status).toBe("closed");
	});

	it("does not assume closure when the close and authoritative refresh both fail", async () => {
		await load(status(terminal("active")));
		api.close.mockRejectedValueOnce(new ApiError(503, "close_error", "Close unavailable"));
		api.getStatus.mockRejectedValueOnce(new ApiError(503, "status_error", "Status unavailable"));
		await hooks.value.close();
		hooks.render();
		expect(hooks.value).toMatchObject({ transition: null, error: "Close unavailable", mutating: false });
		expect(hooks.value.status?.terminal?.status).toBe("active");
	});

	it("accepts authoritative closure after a close response was lost", async () => {
		await load(status(terminal("active")));
		api.close.mockRejectedValueOnce(new ApiError(503, "close_error", "Close response lost"));
		api.getStatus.mockResolvedValue(status(terminal("closed")));
		await hooks.value.close();
		hooks.render();
		expect(hooks.value.transition).toBe("disconnected");
		expect(hooks.value.status?.terminal?.status).toBe("closed");
	});

	it("requires authoritative terminal state even when the close POST returned closed", async () => {
		await load(status(terminal("active")));
		await hooks.value.close();
		hooks.render();
		expect(hooks.value.transition).toBeNull();
		expect(hooks.value.status?.terminal?.status).toBe("active");
	});

	it("waits for a closing backend state to become terminal before completing", async () => {
		await load(status(terminal("active")));
		api.getStatus.mockResolvedValue(status(terminal("closing")));
		await hooks.value.close();
		hooks.render();
		expect(hooks.value.transition).toBe("disconnecting");
		api.getStatus.mockResolvedValue(status(terminal("closed")));
		await vi.advanceTimersByTimeAsync(TERMINAL_UI_DEFAULTS.transitionPollMs);
		hooks.render();
		expect(hooks.value.transition).toBe("disconnected");
	});

	it("does not overlap transition polls while a status read is pending", async () => {
		await load(status(terminal("opening")));
		const pending = deferred<TerminalStatusResponse>();
		api.getStatus.mockReturnValueOnce(pending.promise);
		const reads = api.getStatus.mock.calls.length;
		await vi.advanceTimersByTimeAsync(TERMINAL_UI_DEFAULTS.transitionPollMs * 3);
		expect(api.getStatus).toHaveBeenCalledTimes(reads + 1);
		pending.resolve(status(terminal("active")));
		await settle();
		expect(hooks.value.status?.terminal?.status).toBe("active");
	});

	it("does not close a failed page with no live terminal", async () => {
		await load(status(terminal("failed")));
		await hooks.value.close();
		expect(api.close).not.toHaveBeenCalled();
	});

	it("does not roll back status when older reads arrive after the latest read", async () => {
		const older = deferred<TerminalStatusResponse>();
		const newer = deferred<TerminalStatusResponse>();
		api.getStatus.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
		const first = hooks.value.refresh();
		const second = hooks.value.refresh();
		newer.resolve(status(terminal("active")));
		await second;
		hooks.render();
		older.resolve(status(terminal("opening")));
		await first;
		hooks.render();
		expect(hooks.value.status?.terminal?.status).toBe("active");
	});

	it("invalidates reads started before a lifecycle mutation", async () => {
		const older = deferred<TerminalStatusResponse>();
		api.getStatus.mockReturnValueOnce(older.promise).mockResolvedValueOnce(status(terminal("active")));
		const reading = hooks.value.refresh();
		await hooks.value.open();
		older.resolve(status());
		await reading;
		hooks.render();
		expect(hooks.value.status?.terminal?.status).toBe("active");
	});

	it("ignores a response whose caller aborted its status read", async () => {
		const pending = deferred<TerminalStatusResponse>();
		api.getStatus.mockReturnValueOnce(pending.promise);
		const controller = new AbortController();
		const reading = hooks.value.refresh(controller.signal);
		controller.abort();
		pending.resolve(status(terminal("active")));
		await reading;
		hooks.render();
		expect(hooks.value.status?.terminal).toBeNull();
	});

	it("projects an empty Session immediately and ignores an old open result", async () => {
		const pending = deferred<TerminalSessionView>();
		api.open.mockReturnValueOnce(pending.promise);
		const opening = hooks.value.open();
		hooks.value.setError("old error");
		hooks.sessionId = "other";
		expect(hooks.render()).toMatchObject({ status: null, loading: true, transition: null, error: null, openError: null });
		api.getStatus.mockResolvedValue(status(terminal("active", "other", "other-terminal")));
		await settle();
		const reads = api.getStatus.mock.calls.length;
		pending.resolve(terminal("opening"));
		await opening;
		hooks.render();
		expect(api.getStatus).toHaveBeenCalledTimes(reads);
		expect(hooks.value.status?.terminal?.id).toBe("other-terminal");
		expect(hooks.value.transition).toBeNull();
	});

	it("ignores a rejected close after navigating to another Session", async () => {
		await load(status(terminal("active")));
		const pending = deferred<TerminalSessionView>();
		api.close.mockReturnValueOnce(pending.promise);
		const closing = hooks.value.close();
		hooks.sessionId = "other";
		hooks.render();
		api.getStatus.mockResolvedValue(status(terminal("active", "other", "other-terminal")));
		await settle();
		const reads = api.getStatus.mock.calls.length;
		pending.reject(new ApiError(503, "close_error", "Old close failed"));
		await closing;
		hooks.render();
		expect(api.getStatus).toHaveBeenCalledTimes(reads);
		expect(hooks.value).toMatchObject({ transition: null, error: null });
		expect(hooks.value.status?.terminal?.id).toBe("other-terminal");
	});

	it("ignores old status results even after returning to the same Session", async () => {
		const pending = deferred<TerminalStatusResponse>();
		api.getStatus.mockReturnValueOnce(pending.promise);
		const oldRead = hooks.value.refresh();
		hooks.sessionId = "other";
		hooks.render();
		await settle();
		hooks.sessionId = "session";
		hooks.render();
		await settle();
		pending.resolve(status(terminal("active")));
		await oldRead;
		hooks.render();
		expect(hooks.value.status?.terminal).toBeNull();
	});

	it("does not publish late results or continue an open flow after unmounting", async () => {
		const reading = deferred<TerminalStatusResponse>();
		const opening = deferred<TerminalSessionView>();
		api.getStatus.mockReturnValueOnce(reading.promise);
		api.open.mockReturnValueOnce(opening.promise);
		const read = hooks.value.refresh();
		const open = hooks.value.open();
		hooks.unmount();
		const writes = hooks.writes;
		const reads = api.getStatus.mock.calls.length;
		reading.resolve(status(terminal("active")));
		opening.resolve(terminal("opening"));
		await Promise.all([read, open]);
		expect(hooks.writes).toBe(writes);
		expect(api.getStatus).toHaveBeenCalledTimes(reads);
	});

	it("keeps refresh callbacks stable during ordinary updates and supports state setter functions", async () => {
		const refresh = hooks.value.refresh;
		hooks.value.setError("first");
		hooks.value.setError((current) => `${current} second`);
		hooks.value.setOpenError(() => "open error");
		hooks.render();
		expect(hooks.value).toMatchObject({ error: "first second", openError: "open error" });
		await load(status(terminal("active")));
		expect(hooks.value.refresh).toBe(refresh);
	});
});
