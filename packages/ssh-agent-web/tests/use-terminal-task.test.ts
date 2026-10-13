import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalStatusResponse } from "../features/terminal/model/terminal";
import type { useTerminalMode } from "../features/terminal/runtime/use-terminal-mode";

let driver: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useState: (initial: unknown) => driver.state(initial),
	useMemo: (factory: () => unknown, deps: readonly unknown[]) => driver.memo(factory, deps),
	useCallback: <T,>(callback: T) => callback,
}));
vi.mock("react-intl", () => ({ useIntl: () => ({ formatMessage: ({ id }: { id: string }) => id }) }));
import { useTerminalTask } from "../features/terminal/runtime/use-terminal-task";

function TerminalTaskProbe(options: Parameters<typeof useTerminalTask>[0]) { return useTerminalTask(options); }

class HookDriver {
	private states: unknown[] = [];
	private memos: { value: unknown; deps: readonly unknown[] }[] = [];
	private stateIndex = 0;
	private memoIndex = 0;
	options: Parameters<typeof useTerminalTask>[0] = { sessionId: "session", mode: mode(),
		runActive: false, submitting: false, sandboxPending: false };
	state<T>(initial: T): [T, (next: T | ((current: T) => T)) => void] {
		const index = this.stateIndex++;
		if (!(index in this.states)) this.states[index] = initial;
		return [this.states[index] as T, (next) => { this.states[index] = typeof next === "function"
			? (next as (current: T) => T)(this.states[index] as T) : next; }];
	}
	memo<T>(factory: () => T, deps: readonly unknown[]): T {
		const index = this.memoIndex++;
		const previous = this.memos[index];
		if (!previous || !deps.every((value, i) => Object.is(value, previous.deps[i]))) {
			this.memos[index] = { value: factory(), deps };
		}
		return this.memos[index]!.value as T;
	}
	render() { this.stateIndex = this.memoIndex = 0; return TerminalTaskProbe(this.options); }
}

function status(state: "active" | "opening" | "closing" | "closed" | "failed", id = "terminal-1"): TerminalStatusResponse {
	return { terminal: { id, sessionId: "session", workspaceId: "workspace", status: state,
		requestedSandboxMode: null, sandbox: null, geometry: { rows: 36, cols: 120 },
		eventSequence: 1, ownershipEpoch: 0, closeReason: null,
		failureCode: state === "failed" ? "terminal_open_timeout" : null,
		failureMessage: state === "failed" ? "Timed out" : null, createdAt: 1, updatedAt: 2 },
		effectiveServerInteractionMode: state === "active" ? "terminal" : "command",
		transitionInProgress: state === "opening" || state === "closing",
		capabilities: { minRows: 12, maxRows: 120, minCols: 40, maxCols: 320 } };
}

function mode(): ReturnType<typeof useTerminalMode> {
	return { status: { ...status("closed"), terminal: null }, loading: false, mutating: false,
		transition: null, error: null, openError: null, setError: vi.fn(), setOpenError: vi.fn(),
		open: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
		refresh: vi.fn(async () => status("active")) };
}

beforeEach(() => { driver = new HookDriver(); });

describe("Terminal task presentation and actions", () => {
	it("opens a missing Terminal through the existing lifecycle", () => {
		const task = driver.render();
		expect(task.present).toBe(false);
		task.reveal();
		expect(driver.options.mode.open).toHaveBeenCalledOnce();
		expect(driver.options.mode.close).not.toHaveBeenCalled();
	});
	it("reveals an active page without opening, closing or changing its phase", () => {
		driver.options.mode.status = status("active");
		driver.render().onPanelPhaseChange("live");
		const task = driver.render();
		task.reveal(); task.reveal();
		expect(task).toMatchObject({ present: true, label: "terminal.panel.live", tone: "positive" });
		expect(driver.options.mode.open).not.toHaveBeenCalled();
		expect(driver.options.mode.close).not.toHaveBeenCalled();
	});
	it.each(["runActive", "submitting", "sandboxPending"] as const)("allows locating an existing page during %s but prevents close", (restriction) => {
		driver.options.mode.status = status("active");
		driver.options[restriction] = true;
		const task = driver.render();
		expect(task.present).toBe(true);
		expect(task.menuDisabledReason).toBeUndefined();
		expect(task.operationDisabledReason).toBeDefined();
		task.reveal(); task.requestClose();
		expect(driver.options.mode.open).not.toHaveBeenCalled();
		expect(driver.options.mode.close).not.toHaveBeenCalled();
	});
	it("prevents opening a missing Terminal while an Agent is active", () => {
		driver.options.runActive = true;
		const task = driver.render();
		expect(task.menuDisabledReason).toBe("terminal.disabled.runActive");
		task.reveal();
		expect(driver.options.mode.open).not.toHaveBeenCalled();
	});
	it.each(["opening", "closing"] as const)("restores and locates a %s page without another lifecycle request", (state) => {
		driver.options.mode.status = status(state);
		const task = driver.render();
		expect(task.present).toBe(true);
		expect(task.operationDisabledReason).toBeDefined();
		task.reveal(); task.requestClose();
		expect(driver.options.mode.open).not.toHaveBeenCalled();
		expect(driver.options.mode.close).not.toHaveBeenCalled();
	});
	it("requests an actual close and keeps the tab visible until authoritative state settles", () => {
		driver.options.mode.status = status("active");
		driver.render().requestClose();
		expect(driver.options.mode.close).toHaveBeenCalledOnce();
		expect(driver.render().present).toBe(true);
		driver.options.mode.status = status("closed");
		expect(driver.render().present).toBe(false);
	});
	it("retains the page when closing reports an error", () => {
		driver.options.mode.status = status("active");
		driver.options.mode.error = "Close request failed";
		expect(driver.render()).toMatchObject({ present: true, expanded: true, tone: "danger" });
	});
	it("dismisses an already failed page without calling close and permits a fresh retry", () => {
		driver.options.mode.status = status("failed");
		const task = driver.render();
		expect(task.failure?.message).toBe("Timed out");
		task.requestClose();
		expect(driver.options.mode.close).not.toHaveBeenCalled();
		expect(driver.render().present).toBe(false);
		driver.render().reveal();
		expect(driver.options.mode.open).toHaveBeenCalledOnce();
	});
	it("keeps the page across sandbox reopening and resets the new connection phase", () => {
		driver.options.mode.status = status("active");
		driver.render().onPanelPhaseChange("live");
		driver.options.sandboxPending = true;
		expect(driver.render()).toMatchObject({ present: true, transition: "connecting" });
		driver.options.mode.status = status("opening", "terminal-2");
		expect(driver.render().present).toBe(true);
		driver.options.sandboxPending = false;
		driver.options.mode.status = status("active", "terminal-2");
		expect(driver.render()).toMatchObject({ present: true, label: "terminal.panel.attaching" });
	});
	it("does not carry dismissed failures into another Session", () => {
		driver.options.mode.status = status("failed");
		driver.render().dismiss();
		expect(driver.render().present).toBe(false);
		driver.options.sessionId = "other";
		expect(driver.render().failure?.message).toBe("Timed out");
	});
	it("keeps closing feedback until the exit animation completes", () => {
		driver.options.mode.status = status("closed");
		driver.options.mode.transition = "disconnected";
		expect(driver.render()).toMatchObject({ present: true, expanded: true });
		driver.options.mode.transition = "exiting";
		expect(driver.render()).toMatchObject({ present: true, expanded: false });
		driver.options.mode.transition = null;
		expect(driver.render().present).toBe(false);
	});
});
