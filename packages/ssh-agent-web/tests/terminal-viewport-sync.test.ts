import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalViewportSync } from "../features/terminal/runtime/terminal-viewport-sync";
import { TERMINAL_UI_DEFAULTS } from "../features/terminal/model/terminal-ui-defaults";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function fixture() {
	const viewport = { clientWidth: 600, clientHeight: 500 };
	let geometry = { rows: 36, cols: 120 };
	let proposed = { rows: 30, cols: 80 };
	let documentFocused = true;
	let epoch = 0;
	const focus = vi.fn(async (focused: boolean) => ({ owner: focused, ownershipEpoch: ++epoch }));
	const resize = vi.fn(async (_epoch: number, _geometry: typeof geometry): Promise<void> => undefined);
	const onOwnerChange = vi.fn();
	const onError = vi.fn();
	const measure = vi.fn(() => proposed);
	const sync = new TerminalViewportSync({ viewport, bounds: { minRows: 12, maxRows: 120, minCols: 40, maxCols: 320 },
		measure, geometry: () => geometry, isDocumentFocused: () => documentFocused, focus, resize, onOwnerChange, onError });
	return { sync, viewport, focus, resize, onOwnerChange, onError, measure,
		propose: (next: typeof proposed) => { proposed = next; },
		acknowledge: (next: typeof geometry) => { geometry = next; sync.geometryChanged(); },
		setDocumentFocused: (value: boolean) => { documentFocused = value; sync.refresh(); } };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const resizeDelay = () => vi.advanceTimersByTimeAsync(TERMINAL_UI_DEFAULTS.resizeDebounceMs);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Terminal viewport synchronization", () => {
	it("waits for replay readiness, then requests server resize without changing mirrored geometry", async () => {
		const f = fixture();
		f.sync.refresh();
		await resizeDelay();
		expect(f.focus).not.toHaveBeenCalled();
		expect(f.resize).not.toHaveBeenCalled();
		f.sync.ready();
		await settle();
		await resizeDelay();
		expect(f.resize).toHaveBeenCalledExactlyOnceWith(1, { rows: 30, cols: 80 });
		await resizeDelay();
		expect(f.resize).toHaveBeenCalledOnce(); // Await the authoritative event rather than sending the same request again.
		f.acknowledge({ rows: 30, cols: 80 });
		await resizeDelay();
		expect(f.resize).toHaveBeenCalledOnce();
		f.sync.dispose();
	});

	it("debounces animation measurements and clamps the final dimensions to server bounds", async () => {
		const f = fixture();
		f.sync.ready();
		await settle();
		await vi.advanceTimersByTimeAsync(100);
		f.propose({ rows: 60, cols: 160 }); f.sync.refresh();
		await vi.advanceTimersByTimeAsync(100);
		f.propose({ rows: 200, cols: 500 }); f.sync.refresh();
		expect(f.resize).not.toHaveBeenCalled();
		await resizeDelay();
		expect(f.resize).toHaveBeenCalledExactlyOnceWith(1, { rows: 120, cols: 320 });
		f.sync.dispose();
	});

	it("cancels pending resize when collapsed, releases ownership and remeasures after restoration", async () => {
		const f = fixture();
		f.sync.ready(); await settle();
		f.viewport.clientWidth = f.viewport.clientHeight = 0; f.sync.refresh();
		await settle(); await resizeDelay();
		expect(f.focus.mock.calls.map(([focused]) => focused)).toEqual([true, false]);
		expect(f.resize).not.toHaveBeenCalled();
		expect(f.measure).not.toHaveBeenCalled();
		f.viewport.clientWidth = 1000; f.viewport.clientHeight = 700;
		f.propose({ rows: 42, cols: 140 }); f.sync.refresh();
		await settle(); await resizeDelay();
		expect(f.resize).toHaveBeenCalledExactlyOnceWith(3, { rows: 42, cols: 140 });
		f.sync.dispose();
	});

	it("keeps hidden bootstrap read-only and acquires ownership once revealed", async () => {
		const f = fixture();
		f.viewport.clientWidth = 0;
		f.sync.ready(); await settle(); await resizeDelay();
		expect(f.focus).toHaveBeenCalledExactlyOnceWith(false);
		expect(f.resize).not.toHaveBeenCalled();
		f.viewport.clientWidth = 600; f.sync.refresh();
		await settle(); await resizeDelay();
		expect(f.resize).toHaveBeenCalledExactlyOnceWith(2, { rows: 30, cols: 80 });
		f.sync.dispose();
	});

	it("serializes focus changes so a late claim cannot restore ownership to a hidden page", async () => {
		const f = fixture();
		const claim = deferred<{ owner: boolean; ownershipEpoch: number }>();
		f.focus.mockReturnValueOnce(claim.promise);
		f.sync.ready();
		f.viewport.clientWidth = 0; f.sync.refresh();
		expect(f.focus).toHaveBeenCalledOnce();
		claim.resolve({ owner: true, ownershipEpoch: 1 });
		await settle(); await resizeDelay();
		expect(f.focus.mock.calls.map(([focused]) => focused)).toEqual([true, false]);
		expect(f.onOwnerChange).not.toHaveBeenCalledWith(true);
		expect(f.resize).not.toHaveBeenCalled();
		f.sync.dispose();
	});

	it("serializes resize requests and remeasures the latest layout rather than replaying intermediate sizes", async () => {
		const f = fixture();
		const first = deferred<void>();
		f.resize.mockReturnValueOnce(first.promise);
		f.sync.ready(); await settle(); await resizeDelay();
		f.propose({ rows: 60, cols: 200 }); f.sync.refresh(); await resizeDelay();
		f.propose({ rows: 40, cols: 130 }); f.sync.refresh(); await resizeDelay();
		expect(f.resize).toHaveBeenCalledOnce();
		f.acknowledge({ rows: 30, cols: 80 }); first.resolve(); await settle(); await resizeDelay();
		expect(f.resize.mock.calls).toEqual([[1, { rows: 30, cols: 80 }], [1, { rows: 40, cols: 130 }]]);
		f.sync.dispose();
	});

	it("corrects an in-flight fullscreen resize after returning to the original docked geometry", async () => {
		const f = fixture();
		const first = deferred<void>();
		f.resize.mockReturnValueOnce(first.promise);
		f.propose({ rows: 60, cols: 200 }); f.sync.ready(); await settle(); await resizeDelay();
		f.propose({ rows: 36, cols: 120 }); f.sync.refresh(); await resizeDelay();
		f.acknowledge({ rows: 60, cols: 200 }); first.resolve(); await settle(); await resizeDelay();
		expect(f.resize.mock.calls).toEqual([[1, { rows: 60, cols: 200 }], [1, { rows: 36, cols: 120 }]]);
		f.sync.dispose();
	});

	it("never resizes a follower and responds to authoritative ownership changes", async () => {
		const f = fixture();
		f.focus.mockResolvedValue({ owner: false, ownershipEpoch: 2 });
		f.sync.ready(); await settle(); await resizeDelay();
		expect(f.resize).not.toHaveBeenCalled();
		f.sync.ownerChanged(3); await resizeDelay();
		expect(f.resize).toHaveBeenCalledExactlyOnceWith(3, { rows: 30, cols: 80 });
		f.sync.ownerChanged(null); f.propose({ rows: 50, cols: 100 }); f.sync.refresh(); await resizeDelay();
		expect(f.resize).toHaveBeenCalledOnce();
		f.sync.dispose();
	});

	it("releases on browser blur and synchronizes again on focus", async () => {
		const f = fixture();
		f.sync.ready(); await settle();
		f.setDocumentFocused(false); await settle(); await resizeDelay();
		expect(f.resize).not.toHaveBeenCalled();
		f.setDocumentFocused(true); await settle(); await resizeDelay();
		expect(f.resize).toHaveBeenCalledExactlyOnceWith(3, { rows: 30, cols: 80 });
		f.sync.dispose();
	});

	it("ignores an obsolete ownership resize failure but reports a current failure", async () => {
		const f = fixture();
		const first = deferred<void>();
		f.resize.mockReturnValueOnce(first.promise);
		f.sync.ready(); await settle(); await resizeDelay();
		f.sync.ownerChanged(null); first.reject(new Error("Ownership changed")); await settle();
		expect(f.onError).not.toHaveBeenCalled();
		f.resize.mockRejectedValue(new Error("Resize failed"));
		f.sync.ownerChanged(4); await resizeDelay();
		expect(f.onError).toHaveBeenCalledOnce();
		f.sync.dispose();
	});

	it("disposes timers and ignores late focus results", async () => {
		const f = fixture();
		const pending = deferred<{ owner: boolean; ownershipEpoch: number }>();
		f.focus.mockReturnValueOnce(pending.promise);
		f.sync.ready(); f.sync.dispose(); pending.resolve({ owner: true, ownershipEpoch: 1 });
		await settle(); await resizeDelay();
		expect(f.onOwnerChange).not.toHaveBeenCalled();
		expect(f.resize).not.toHaveBeenCalled();
	});
});
