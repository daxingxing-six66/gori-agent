import { describe, expect, it, vi } from "vitest";
import { SftpTransferLimiter } from "../src/infrastructure/ssh/sftp-transfer-limiter.ts";
import { Ssh2ChannelBroker } from "../src/infrastructure/ssh/ssh2-channel-broker.ts";
import { Ssh2SftpFileBroker } from "../src/infrastructure/ssh/ssh2-sftp-file-broker.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";

const target: SshTargetSnapshot = {
	workspaceId: "w", workspaceRevision: 1, hostname: "host", port: 22, hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: "fingerprint", credentialId: "c", credentialAuthVersion: 1, remoteUser: "user",
	defaultCwd: "/", connectTimeoutMs: 1000, keepaliveIntervalMs: 0, keepaliveMaxCount: 0,
};
function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}
const cancellation = () => new Error("cancelled");
const input = (signal = new AbortController().signal) => ({ target, signal });

function fill(limiter: SftpTransferLimiter) {
	const gates = Array.from({ length: 20 }, deferred);
	const runs = gates.map((gate) => limiter.run(input(), () => gate.promise, cancellation));
	return { gates, runs, async finish() { gates.forEach((gate) => gate.release()); await Promise.allSettled(runs); } };
}

describe("shared transfer FIFO budget", () => {
	it("allows 3000 waiting transfers in addition to 20 active and reclaims cancelled queue capacity", async () => {
		const limiter = new SftpTransferLimiter();
		const active = fill(limiter);
		await Promise.resolve();
		const io = vi.fn(async () => {});
		const controllers = Array.from({ length: 3000 }, () => new AbortController());
		const queued = controllers.map((controller) => limiter.run(input(controller.signal), io, cancellation));
		const settled = Promise.allSettled(queued);
		try {
			await expect(limiter.run(input(), io, cancellation)).rejects.toMatchObject({ code: "transfer_queue_full", status: 429 });
			controllers[0]!.abort();
			await expect(queued[0]).rejects.toThrow("cancelled");
			const replacement = limiter.run(input(), io, cancellation);
			const replacementSettled = Promise.allSettled([replacement]);
			await expect(limiter.run(input(), io, cancellation)).rejects.toMatchObject({ code: "transfer_queue_full" });
			expect(io).not.toHaveBeenCalled();
			limiter.close();
			expect(await replacementSettled).toMatchObject([{ status: "rejected", reason: { code: "transfer_cancelled" } }]);
			const results = await settled;
			expect(results.slice(1)).toHaveLength(2999);
			for (const result of results.slice(1)) expect(result).toMatchObject({ status: "rejected", reason: { code: "transfer_cancelled" } });
		} finally { limiter.close(); await settled; await active.finish(); }
	});

	it("admits exactly 20 and hands each freed slot to the oldest waiter", async () => {
		const limiter = new SftpTransferLimiter(); const active = fill(limiter);
		const started: number[] = []; const gates = [deferred(), deferred(), deferred()];
		const queued = gates.map((gate, index) => limiter.run(input(), async () => { started.push(index); await gate.promise; }, cancellation));
		try {
			await Promise.resolve(); expect(started).toEqual([]);
			active.gates[0]!.release();
			await vi.waitFor(() => expect(started).toEqual([0]));
			gates[0]!.release();
			await vi.waitFor(() => expect(started).toEqual([0, 1]));
			gates[1]!.release();
			await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
		} finally { gates.forEach((gate) => gate.release()); await active.finish(); await Promise.all(queued); limiter.close(); }
	});

	it("removes a cancelled waiter without running it or blocking the next", async () => {
		const limiter = new SftpTransferLimiter(); const active = fill(limiter); const controller = new AbortController();
		const skipped = vi.fn(async () => {}); const next = vi.fn(async () => {});
		const cancelled = limiter.run(input(controller.signal), skipped, cancellation);
		const rejected = expect(cancelled).rejects.toThrow("cancelled");
		const queued = limiter.run(input(), next, cancellation);
		controller.abort(); await rejected;
		active.gates[0]!.release(); await queued;
		expect(skipped).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledOnce();
		await active.finish(); limiter.close();
	});

	it("releases permits after failures and synchronous throws", async () => {
		const limiter = new SftpTransferLimiter();
		const failed = Array.from({ length: 40 }, (_, index) => limiter.run(input(), () => {
			if (index % 2) throw new Error("sync");
			return Promise.reject(new Error("async"));
		}, cancellation));
		expect((await Promise.allSettled(failed)).every((result) => result.status === "rejected")).toBe(true);
		const active = fill(limiter); const next = vi.fn(async () => {});
		const queued = limiter.run(input(), next, cancellation);
		await Promise.resolve(); expect(next).not.toHaveBeenCalled();
		await active.finish(); await queued; limiter.close();
	});

	it("checks cancellation after granting a permit but before starting I/O", async () => {
		const limiter = new SftpTransferLimiter(); const controller = new AbortController(); const io = vi.fn(async () => {});
		const run = limiter.run(input(controller.signal), io, cancellation);
		controller.abort(); await expect(run).rejects.toThrow("cancelled");
		expect(io).not.toHaveBeenCalled();
		const active = fill(limiter); await active.finish(); limiter.close();
	});

	it("cancels only queued work for an invalidated target", async () => {
		const limiter = new SftpTransferLimiter(); const active = fill(limiter); const io = vi.fn(async () => {});
		const obsolete = limiter.run(input(), io, cancellation);
		const rejected = expect(obsolete).rejects.toMatchObject({ code: "transfer_cancelled" });
		const next = limiter.run({ ...input(), target: { ...target, workspaceId: "other" } }, io, cancellation);
		limiter.cancelQueued((snapshot) => snapshot.workspaceId === target.workspaceId);
		await rejected; expect(io).not.toHaveBeenCalled();
		active.gates[0]!.release(); await next; expect(io).toHaveBeenCalledOnce();
		await active.finish(); limiter.close();
	});

	it("rejects queued/new work on close and settles already running tasks", async () => {
		const limiter = new SftpTransferLimiter(); const active = fill(limiter);
		await Promise.resolve();
		const io = vi.fn(async () => {}); const queued = limiter.run(input(), io, cancellation);
		const rejected = expect(queued).rejects.toMatchObject({ code: "transfer_cancelled" });
		limiter.close(); await rejected;
		await expect(limiter.run(input(), io, cancellation)).rejects.toMatchObject({ code: "transfer_cancelled" });
		expect(io).not.toHaveBeenCalled(); await active.finish();
	});

	it("shares the broker's 20 slots between uploads and downloads across workspaces", async () => {
		const broker = new Ssh2ChannelBroker({ get: async () => undefined, put: async () => {}, deleteAll: async () => {} });
		const gate = deferred();
		const uploads = vi.spyOn(Ssh2SftpFileBroker.prototype, "upload").mockImplementation(async () => { await gate.promise; return { bytesTransferred: 1 }; });
		const downloads = vi.spyOn(Ssh2SftpFileBroker.prototype, "download").mockImplementation(async () => { await gate.promise; return { bytesTransferred: 1 }; });
		const listing = vi.spyOn(Ssh2SftpFileBroker.prototype, "listDirectory").mockResolvedValue({ path: "/", entries: [] });
		const transfer = (i: number) => {
			const common = { ...input(), target: { ...target, workspaceId: i % 2 ? "w" : "other" }, remotePath: `/file${i}`, onProgress: async () => {} };
			return i % 2 ? broker.upload({ ...common, data: (async function* () { yield new Uint8Array(1); })(), overwrite: false })
				: broker.download({ ...common, onData: async () => {} });
		};
		const runs = Array.from({ length: 25 }, (_, i) => transfer(i));
		try {
			await vi.waitFor(() => { expect(uploads).toHaveBeenCalledTimes(10); expect(downloads).toHaveBeenCalledTimes(10); });
			await broker.listDirectory({ ...input(), remotePath: "/" }); expect(listing).toHaveBeenCalledOnce();
			gate.release(); await Promise.all(runs);
			expect(uploads).toHaveBeenCalledTimes(12); expect(downloads).toHaveBeenCalledTimes(13);
		} finally { gate.release(); await Promise.allSettled(runs); broker.close(); vi.restoreAllMocks(); }
	});
});
