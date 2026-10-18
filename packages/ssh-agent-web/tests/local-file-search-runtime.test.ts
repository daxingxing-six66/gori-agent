import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalFileSearchResult } from "../features/chat/api/local-files-api";

let driver: HookDriver;
vi.mock("react", () => ({
	useState: (initial: unknown) => driver.state(initial),
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => driver.effect(effect, deps),
}));
vi.mock("../features/chat/api/local-files-api", () => ({ localFilesApi: { searchSession: vi.fn() } }));
import { localFilesApi } from "../features/chat/api/local-files-api";
import { useLocalFileSearch } from "../features/chat/runtime/use-local-file-search";

class HookDriver {
	private values: unknown[] = [];
	private effects: { deps: readonly unknown[]; cleanup?: void | (() => void) }[] = [];
	private stateIndex = 0;
	private effectIndex = 0;
	state<T>(initial: T): [T, (next: T | ((current: T) => T)) => void] {
		const index = this.stateIndex++;
		if (!(index in this.values)) this.values[index] = initial;
		return [this.values[index] as T, (next) => { this.values[index] = typeof next === "function" ? (next as (current: T) => T)(this.values[index] as T) : next; }];
	}
	effect(effect: () => void | (() => void), deps: readonly unknown[]) {
		const index = this.effectIndex++;
		const previous = this.effects[index];
		if (previous?.deps.length === deps.length && deps.every((value, offset) => Object.is(previous.deps[offset], value))) return;
		previous?.cleanup?.();
		this.effects[index] = { deps, cleanup: effect() };
	}
	render<T>(render: () => T): T { this.stateIndex = this.effectIndex = 0; return render(); }
	unmount() { this.effects.forEach((effect) => effect.cleanup?.()); }
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function result(name: string): LocalFileSearchResult {
	return { entries: [{ name, path: `/work/${name}`, relativePath: name, type: "file", size: 1, modifiedAt: 1 }], truncated: false, incomplete: false };
}
const render = (sessionId = "session", query = "Needle", active = true) => driver.render(() => useLocalFileSearch(sessionId, query, active));
beforeEach(() => { driver = new HookDriver(); vi.useFakeTimers(); vi.stubGlobal("window", globalThis); vi.mocked(localFilesApi.searchSession).mockReset(); });
afterEach(() => { driver.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("local-file search request lifecycle", () => {
	it("debounces rapid typing and never searches closed menus", async () => {
		vi.mocked(localFilesApi.searchSession).mockResolvedValue(result("Newest.java"));
		render("session", "N"); await vi.advanceTimersByTimeAsync(100);
		render("session", "Ne"); await vi.advanceTimersByTimeAsync(100);
		render("session", "Newest"); await vi.advanceTimersByTimeAsync(180);
		expect(localFilesApi.searchSession).toHaveBeenCalledTimes(1);
		expect(vi.mocked(localFilesApi.searchSession).mock.calls[0]?.slice(0, 2)).toEqual(["session", "Newest"]);
		render("session", "Newest", false); await vi.advanceTimersByTimeAsync(1000);
		expect(localFilesApi.searchSession).toHaveBeenCalledTimes(1);
	});

	it("discards old responses even if fetch ignores cancellation", async () => {
		const old = deferred<LocalFileSearchResult>(), latest = deferred<LocalFileSearchResult>();
		vi.mocked(localFilesApi.searchSession).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
		render("session", "old"); await vi.advanceTimersByTimeAsync(180);
		const oldSignal = vi.mocked(localFilesApi.searchSession).mock.calls[0]![2]!.signal!;
		expect(render("session", "latest").entries).toEqual([]);
		expect(oldSignal.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(180);
		latest.resolve(result("latest.java")); await latest.promise;
		old.resolve(result("stale.java")); await old.promise;
		expect(render("session", "latest").entries[0]?.name).toBe("latest.java");
	});

	it("isolates Session changes immediately and cancels the old request", async () => {
		const first = deferred<LocalFileSearchResult>();
		vi.mocked(localFilesApi.searchSession).mockReturnValueOnce(first.promise).mockResolvedValue(result("b.java"));
		render("a"); await vi.advanceTimersByTimeAsync(180);
		const signal = vi.mocked(localFilesApi.searchSession).mock.calls[0]![2]!.signal!;
		expect(render("b").entries).toEqual([]);
		expect(signal.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(180);
		first.resolve(result("a.java")); await first.promise;
		expect(render("b").entries[0]?.name).toBe("b.java");
	});

	it("preserves incomplete/limit flags and sends explicit refresh and ignored-file choices", async () => {
		vi.mocked(localFilesApi.searchSession).mockResolvedValue({ entries: [], incomplete: true, truncated: false });
		render(); await vi.advanceTimersByTimeAsync(180);
		expect(render()).toMatchObject({ incomplete: true, loading: false });
		render().toggleIgnored(); render(); await vi.advanceTimersByTimeAsync(180);
		expect(vi.mocked(localFilesApi.searchSession).mock.lastCall?.[2]).toMatchObject({ includeIgnored: true, refresh: false });
		render().refresh(); render(); await vi.advanceTimersByTimeAsync(180);
		expect(vi.mocked(localFilesApi.searchSession).mock.lastCall?.[2]).toMatchObject({ includeIgnored: true, refresh: true });
		expect(render("different").includeIgnored).toBe(false);
	});

	it("exposes a request failure and permits retry without reviving stale results", async () => {
		vi.mocked(localFilesApi.searchSession).mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(result("retried.java"));
		render(); await vi.advanceTimersByTimeAsync(180);
		expect(render()).toMatchObject({ error: new Error("unavailable"), loading: false, entries: [] });
		render().refresh(); render(); await vi.advanceTimersByTimeAsync(180);
		expect(render()).toMatchObject({ error: null, loading: false, entries: result("retried.java").entries });
	});
});
