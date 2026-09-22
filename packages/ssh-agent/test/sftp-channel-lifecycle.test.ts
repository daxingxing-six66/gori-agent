import { EventEmitter } from "node:events";
import type { Client, SFTPWrapper } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import { Ssh2SftpChannelPool } from "../src/infrastructure/ssh/ssh2-sftp-channel-pool.ts";
import type { UseSsh2ChannelSlotInput } from "../src/infrastructure/ssh/ssh2-connection-pool.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";

const target: SshTargetSnapshot = {
	workspaceId: "w", workspaceRevision: 1, hostname: "host", port: 22, hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: "fingerprint", credentialId: "c", credentialAuthVersion: 1, remoteUser: "user",
	defaultCwd: "/", connectTimeoutMs: 1000, keepaliveIntervalMs: 0, keepaliveMaxCount: 0,
};
function fixture() {
	const pending: Array<(error?: Error, channel?: SFTPWrapper) => void> = [];
	const client = Object.assign(new EventEmitter(), {
		sftp: (callback: (error?: Error, channel?: SFTPWrapper) => void) => pending.push(callback),
	});
	const end = vi.fn();
	const channel = Object.assign(new EventEmitter(), { end }) as unknown as SFTPWrapper;
	let slots = 0;
	const pool = new Ssh2SftpChannelPool({
		async withChannelSlot<T>(input: UseSsh2ChannelSlotInput<T>): Promise<T> {
			slots++;
			try { return await input.operation({ client: client as unknown as Client, generation: 1, isCurrent: () => true }); }
			finally { slots--; }
		},
	});
	const request = (signal = new AbortController().signal, selected = target) => ({ target: selected, remotePath: "/file", signal });
	return { pool, pending, channel, end, request, get slots() { return slots; } };
}

describe("shared SFTP acquisition lifecycle", () => {
	it("does not cancel shared opening when the first waiter aborts", async () => {
		const test = fixture(); const controller = new AbortController();
		try {
			const first = test.pool.use(test.request(controller.signal), async () => "first");
			const rejected = expect(first).rejects.toMatchObject({ code: "transfer_cancelled" });
			const second = test.pool.use(test.request(), async () => "second");
			controller.abort(); await rejected;
			expect(test.pending).toHaveLength(1);
			test.pending[0]!(undefined, test.channel);
			await expect(second).resolves.toBe("second");
			expect(test.end).not.toHaveBeenCalled();
		} finally { test.pool.close(); }
	});

	it("closes a late subsystem response after the only waiter cancels", async () => {
		const test = fixture(); const controller = new AbortController();
		try {
			const run = test.pool.use(test.request(controller.signal), async () => { throw new Error("must not execute"); });
			const rejected = expect(run).rejects.toMatchObject({ code: "transfer_cancelled" });
			controller.abort(); await rejected;
			test.pending[0]!(undefined, test.channel);
			await vi.waitFor(() => expect(test.slots).toBe(0));
			expect(test.end).toHaveBeenCalledOnce();
		} finally { test.pool.close(); }
	});

	it("shares an open failure and permits a later fresh acquisition", async () => {
		const test = fixture();
		try {
			const first = test.pool.use(test.request(), async () => 1);
			const second = test.pool.use(test.request(), async () => 2);
			const failures = Promise.allSettled([first, second]);
			test.pending[0]!(new Error("open failed"));
			expect((await failures).map((result) => result.status)).toEqual(["rejected", "rejected"]);
			const next = test.pool.use(test.request(), async () => 3);
			test.pending[1]!(undefined, test.channel);
			await expect(next).resolves.toBe(3);
		} finally { test.pool.close(); }
	});

	it("isolates credential versions and rejects pending work on close", async () => {
		const test = fixture();
		const runs = [test.pool.use(test.request(), async () => 1),
			test.pool.use(test.request(undefined, { ...target, credentialAuthVersion: 2 }), async () => 2)];
		const settled = Promise.allSettled(runs);
		expect(test.pending).toHaveLength(2);
		test.pool.close();
		expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
		await vi.waitFor(() => expect(test.slots).toBe(0));
		await expect(test.pool.use(test.request(), async () => 3)).rejects.toMatchObject({ code: "sftp_operation_failed" });
	});
});
