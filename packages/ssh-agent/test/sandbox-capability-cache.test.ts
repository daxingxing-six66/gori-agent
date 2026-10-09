import { describe, expect, it, vi } from "vitest";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";
import { SandboxCapabilityCache } from "../src/infrastructure/sandbox/sandbox-capability-cache.ts";

const target = { workspaceId: "w", credentialId: "c", credentialAuthVersion: 1, hostname: "host", port: 22 } as SshTargetSnapshot;
const signal = new AbortController().signal;
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

describe("sandbox capability lifecycle", () => {
	it("does not cache a late discovery result after its owner was cancelled", async () => {
		const pending = deferred<string>();
		const discover = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce("current");
		const cache = new SandboxCapabilityCache({}, discover);
		const owner = new AbortController();
		const preparation = cache.get(target, owner.signal);
		const waiter = cache.get(target, signal);
		owner.abort(new Error("owner cancelled"));
		await expect(preparation).rejects.toThrow("owner cancelled");
		pending.resolve("stale");
		await expect(waiter).rejects.toThrow("owner cancelled");
		expect(await cache.get(target, signal)).toBe("current");
		expect(discover).toHaveBeenCalledTimes(2);
	});

	it("shares discovery and reuses only the current connection identity and generation", async () => {
		let generation = 0;
		const pending = deferred<string>();
		const discover = vi.fn(async () => { generation = 1; return pending.promise; });
		const cache = new SandboxCapabilityCache({ snapshotWorkspace: () => ({ workspaceId: "w", generation,
			state: "connected", activeChannels: 0, waitingChannels: 0 }) }, discover);
		const first = cache.get(target, signal);
		const second = cache.get(target, signal);
		pending.resolve("launcher");
		expect(await Promise.all([first, second, cache.get(target, signal)])).toEqual(["launcher", "launcher", "launcher"]);
		expect(discover).toHaveBeenCalledOnce();
		await cache.get({ ...target, credentialAuthVersion: 2 }, signal);
		expect(discover).toHaveBeenCalledTimes(2);
		generation = 2;
		await cache.get(target, signal);
		expect(discover).toHaveBeenCalledTimes(3);
	});

	it("refreshes after an older discovery and merges concurrent refresh requests", async () => {
		const old = deferred<string>();
		const fresh = deferred<string>();
		const discover = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
		const cache = new SandboxCapabilityCache({}, discover);
		const preparation = cache.get(target, signal);
		const refresh = cache.refresh(target, signal);
		const anotherRefresh = cache.refresh(target, signal);
		const queryDuringRefresh = cache.get(target, signal);
		old.resolve("old");
		expect(await preparation).toBe("old");
		fresh.resolve("fresh");
		expect(await Promise.all([refresh, anotherRefresh, queryDuringRefresh])).toEqual(["fresh", "fresh", "fresh"]);
		expect(await cache.get(target, signal)).toBe("fresh");
		expect(discover).toHaveBeenCalledTimes(2);
	});

	it("cancels a waiter promptly without cancelling another request's discovery", async () => {
		const pending = deferred<string>();
		const discover = vi.fn(async () => pending.promise);
		const cache = new SandboxCapabilityCache({}, discover);
		const owner = cache.get(target, signal);
		const cancelled = new AbortController();
		const waiter = cache.get(target, cancelled.signal);
		const reason = new Error("cancel waiting");
		cancelled.abort(reason);
		await expect(waiter).rejects.toBe(reason);
		pending.resolve("ready");
		expect(await owner).toBe("ready");
		expect(await cache.get(target, signal)).toBe("ready");
		expect(discover).toHaveBeenCalledOnce();
	});

	it("cancels a queued refresh before starting fresh remote work", async () => {
		const pending = deferred<string>();
		const discover = vi.fn(async () => pending.promise);
		const cache = new SandboxCapabilityCache({}, discover);
		const owner = cache.get(target, signal);
		const cancelled = new AbortController();
		const refresh = cache.refresh(target, cancelled.signal);
		cancelled.abort(new Error("cancel refresh"));
		await expect(refresh).rejects.toThrow("cancel refresh");
		pending.resolve("ready");
		await owner;
		expect(await cache.get(target, signal)).toBe("ready");
		expect(discover).toHaveBeenCalledOnce();
	});

	it("does not cache failures or retain a stale verdict after a failed refresh", async () => {
		const discover = vi.fn().mockRejectedValueOnce(new Error("temporary fault")).mockResolvedValueOnce("old")
			.mockRejectedValueOnce(new Error("refresh fault")).mockResolvedValueOnce("new");
		const cache = new SandboxCapabilityCache({}, discover);
		await expect(cache.get(target, signal)).rejects.toThrow("temporary fault");
		expect(await cache.get(target, signal)).toBe("old");
		await expect(cache.refresh(target, signal)).rejects.toThrow("refresh fault");
		expect(await cache.get(target, signal)).toBe("new");
		expect(discover).toHaveBeenCalledTimes(4);
	});

	it("does not discover or reuse metadata for an already cancelled request", async () => {
		const discover = vi.fn(async () => "ready");
		const cache = new SandboxCapabilityCache({}, discover);
		await cache.get(target, signal);
		const cancelled = AbortSignal.abort(new Error("cancelled"));
		await expect(cache.get(target, cancelled)).rejects.toThrow("cancelled");
		expect(() => cache.refresh(target, cancelled)).toThrow("cancelled");
		expect(discover).toHaveBeenCalledOnce();
	});
});
