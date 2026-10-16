import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let driver: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useState: (initial: unknown) => driver.state(initial),
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => driver.effect(effect, deps),
	useCallback: <T,>(callback: T) => callback,
}));
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../features/statistics/api/statistics-api", () => ({ fetchStatistics: transport.fetch }));
import { useStatistics, useStatisticsLocation } from "../features/statistics/runtime/use-statistics";

class HookDriver {
	private states: unknown[] = [];
	private stateIndex = 0;
	private effectIndex = 0;
	private effects: { deps: readonly unknown[]; cleanup?: () => void }[] = [];
	state<T>(initial: T): [T, (next: T | ((value: T) => T)) => void] {
		const index = this.stateIndex++;
		if (!(index in this.states)) this.states[index] = initial;
		return [this.states[index] as T, (next) => { this.states[index] = typeof next === "function" ? (next as (value: T) => T)(this.states[index] as T) : next; }];
	}
	effect(effect: () => void | (() => void), deps: readonly unknown[]) {
		const index = this.effectIndex++;
		const previous = this.effects[index];
		if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
		previous?.cleanup?.();
		this.effects[index] = { deps, cleanup: effect() || undefined };
	}
	render<T>(callback: () => T): T { this.stateIndex = this.effectIndex = 0; return callback(); }
	unmount() { for (const effect of this.effects) effect.cleanup?.(); }
}

beforeEach(() => { driver = new HookDriver(); transport.fetch.mockReset(); });
afterEach(() => { driver.unmount(); vi.unstubAllGlobals(); });

describe("statistics query isolation", () => {
	it("aborts replaced requests, ignores late results, retries errors and cancels on unmount", async () => {
		const pending: { signal: AbortSignal; resolve(value: unknown): void; reject(error: unknown): void }[] = [];
		transport.fetch.mockImplementation((_endpoint, _params, signal: AbortSignal) => new Promise((resolve, reject) => pending.push({ signal, resolve, reject })));
		let query = "from=1&to=2", refresh = 0;
		const render = () => driver.render(() => useStatistics("overview", query, refresh));
		render();
		query = "from=3&to=4"; render();
		expect(pending[0].signal.aborted).toBe(true);
		pending[0].resolve({ old: true }); await Promise.resolve();
		expect(render().data).toBeNull();
		pending[1].resolve({ current: true }); await Promise.resolve();
		expect(render().data).toEqual({ current: true });
		refresh++; render();
		pending[2].reject(new Error("offline")); await Promise.resolve();
		expect(render().error).toBeInstanceOf(Error);
		refresh++; render();
		expect(render().loading).toBe(true);
		driver.unmount();
		expect(pending[3].signal.aborted).toBe(true);
		expect(transport.fetch.mock.calls.every((call) => call[0] === "overview")).toBe(true);
	});

	it("restores state on popstate and clears paging after filter changes", () => {
		let url = new URL("http://localhost/statistics?tab=runs&range=7d&cursor=old");
		let popstate: (() => void) | undefined;
		vi.stubGlobal("window", {
			location: { get href() { return url.href; }, get search() { return url.search; } },
			history: { pushState: (_state: unknown, _title: string, next: string) => { url = new URL(next, url); } },
			addEventListener: (_name: string, handler: () => void) => { popstate = handler; },
			removeEventListener: vi.fn(),
		});
		const render = () => driver.render(useStatisticsLocation);
		render();
		expect(render().location).toMatchObject({ tab: "runs", range: "7d", cursor: "old" });
		render().update({ workspaceId: "a" });
		expect(url.searchParams.get("cursor")).toBeNull();
		expect(render().location?.workspaceId).toBe("a");
		url = new URL("http://localhost/statistics?tab=models&range=30d"); popstate?.();
		expect(render().location).toMatchObject({ tab: "models", range: "30d", workspaceId: "" });
	});
});
