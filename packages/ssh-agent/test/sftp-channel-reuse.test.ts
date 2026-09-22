import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server, utils, type SFTPWrapper } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import { Ssh2ChannelBroker } from "../src/infrastructure/ssh/ssh2-channel-broker.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

async function fixture() {
	const key = utils.generateKeyPairSync("ed25519");
	const parsed = utils.parseKey(key.private);
	if (parsed instanceof Error) throw parsed;
	const files = new Map<string, Buffer>();
	const handles = new Map<string, string>();
	const channels: SFTPWrapper[] = [];
	let nextHandle = 0;
	let writeGate: ReturnType<typeof deferred> | undefined;
	let writes = 0;
	let loseRename = false;
	let loseRead = false;
	const clients: Array<{ end(): unknown }> = [];
	const server = new Server({ hostKeys: [key.private] }, (client) => {
		clients.push(client);
		client.on("error", () => {});
		client.on("authentication", (auth) => auth.method === "password" ? auth.accept() : auth.reject());
		client.on("ready", () => client.on("session", (accept) => {
			const session = accept();
			session.on("sftp", (acceptSftp) => {
				const sftp = acceptSftp(); channels.push(sftp);
				sftp.on("error", () => {});
				sftp.on("LSTAT", (id, path) => {
					const data = files.get(path);
					if (!data) { sftp.status(id, utils.sftp.STATUS_CODE.NO_SUCH_FILE); return; }
					sftp.attrs(id, { mode: 0o100644, size: data.length, uid: 0, gid: 0, atime: 0, mtime: 0 });
				});
				sftp.on("OPEN", (id, path, flags) => {
					if (flags & utils.sftp.OPEN_MODE.WRITE) files.set(path, Buffer.alloc(0));
					const handle = String(++nextHandle); handles.set(handle, path);
					sftp.handle(id, Buffer.from(handle));
				});
				sftp.on("WRITE", (id, handle, offset, data) => {
					writes++;
					const path = handles.get(handle.toString())!;
					const previous = files.get(path)!;
					const merged = Buffer.alloc(Math.max(previous.length, offset + data.length));
					previous.copy(merged); data.copy(merged, offset); files.set(path, merged);
					if (writeGate) void writeGate.promise.then(() => sftp.status(id, utils.sftp.STATUS_CODE.OK));
					else sftp.status(id, utils.sftp.STATUS_CODE.OK);
				});
				sftp.on("READ", (id, handle, offset, length) => {
					if (loseRead) { client.end(); return; }
					const data = files.get(handles.get(handle.toString())!)!;
					if (offset >= data.length) sftp.status(id, utils.sftp.STATUS_CODE.EOF);
					else sftp.data(id, data.subarray(offset, offset + length));
				});
				sftp.on("CLOSE", (id, handle) => { handles.delete(handle.toString()); sftp.status(id, utils.sftp.STATUS_CODE.OK); });
				sftp.on("RENAME", (id, source, target) => {
					files.set(target, files.get(source)!); files.delete(source);
					if (loseRename) { client.end(); return; }
					sftp.status(id, utils.sftp.STATUS_CODE.OK);
				});
				sftp.on("REMOVE", (id, path) => { files.delete(path); sftp.status(id, utils.sftp.STATUS_CODE.OK); });
			});
		}));
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const target: SshTargetSnapshot = {
		workspaceId: "workspace", workspaceRevision: 1, hostname: "127.0.0.1", port: (server.address() as AddressInfo).port,
		hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`,
		credentialId: "credential", credentialAuthVersion: 1, remoteUser: "user", defaultCwd: "/",
		connectTimeoutMs: 2000, keepaliveIntervalMs: 0, keepaliveMaxCount: 3,
	};
	const broker = new Ssh2ChannelBroker({ get: async () => ({ type: "password", password: "test" }), put: async () => {}, deleteAll: async () => {} },
		{ maxChannelsPerConnection: 1, channelAcquireTimeoutMs: 200, reconnectDelaysMs: [] });
	return {
		target, broker, files, handles, channels,
		get writes() { return writes; },
		pauseWrites() { writeGate = deferred(); return writeGate; },
		loseRename() { loseRename = true; },
		loseRead() { loseRead = true; },
		async close() {
			writeGate?.release(); broker.close(); clients.forEach((client) => client.end());
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		},
	};
}

async function* chunks(value: string) { yield Buffer.from(value); }

function upload(test: Awaited<ReturnType<typeof fixture>>, name: string, controller = new AbortController()) {
	return test.broker.upload({ target: test.target, remotePath: `/remote/${name}`, data: chunks(name), signal: controller.signal, overwrite: false, onProgress: async () => {} });
}

describe("SFTP channel multiplexing with a local SSH server", () => {
	it("uploads concurrently on one channel and reuses it for concurrent downloads", async () => {
		const test = await fixture(); const gate = test.pauseWrites(); const downloading = deferred();
		try {
			const uploads = Promise.all([upload(test, "alpha"), upload(test, "beta")]);
			await vi.waitFor(() => expect(test.writes).toBe(2));
			expect(test.channels).toHaveLength(1);
			expect(test.broker.snapshotWorkspace(test.target.workspaceId).activeChannels).toBe(1);
			gate.release(); await uploads;
			expect(test.files.get("/remote/alpha")?.toString()).toBe("alpha");
			expect(test.files.get("/remote/beta")?.toString()).toBe("beta");
			const received = new Map<string, string>();
			const downloads = Promise.all(["alpha", "beta"].map((name) => test.broker.download({
				target: test.target, remotePath: `/remote/${name}`, signal: new AbortController().signal,
				onProgress: async () => {}, onData: async (chunk) => { received.set(name, Buffer.from(chunk).toString()); await downloading.promise; },
			})));
			await vi.waitFor(() => expect(received.size).toBe(2));
			expect(test.channels).toHaveLength(1);
			downloading.release(); await downloads;
			expect([...received.entries()].sort()).toEqual([["alpha", "alpha"], ["beta", "beta"]]);
			expect(test.handles.size).toBe(0);
		} finally { gate.release(); downloading.release(); await test.close(); }
	});

	it("cancels one upload without closing the channel or cancelling its sibling", async () => {
		const test = await fixture(); const gate = test.pauseWrites(); const controller = new AbortController();
		try {
			const cancelled = upload(test, "cancelled", controller);
			const rejected = expect(cancelled).rejects.toMatchObject({ failure: { code: "upload_cancelled" } });
			const sibling = upload(test, "sibling");
			await vi.waitFor(() => expect(test.writes).toBe(2));
			controller.abort(); gate.release();
			await rejected; await sibling;
			expect(test.files.has("/remote/cancelled")).toBe(false);
			expect(test.files.get("/remote/sibling")?.toString()).toBe("sibling");
			expect(test.channels).toHaveLength(1);
			expect(test.handles.size).toBe(0);
			expect([...test.files.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
		} finally { gate.release(); await test.close(); }
	});

	it("cancels one download while its sibling completes on the same channel", async () => {
		const test = await fixture(); const gate = deferred(); const controller = new AbortController();
		try {
			test.files.set("/remote/one", Buffer.from("one"));
			test.files.set("/remote/two", Buffer.from("two"));
			let received = 0;
			const fetch = (name: string, signal: AbortSignal) => test.broker.download({
				target: test.target, remotePath: `/remote/${name}`, signal,
				onData: async () => { received++; await gate.promise; }, onProgress: async () => {},
			});
			const cancelled = fetch("one", controller.signal);
			const rejected = expect(cancelled).rejects.toMatchObject({ code: "transfer_cancelled" });
			const sibling = fetch("two", new AbortController().signal);
			await vi.waitFor(() => expect(received).toBe(2));
			controller.abort(); gate.release();
			await rejected; await expect(sibling).resolves.toEqual({ bytesTransferred: 3 });
			expect(test.channels).toHaveLength(1);
			expect(test.handles.size).toBe(0);
		} finally { gate.release(); await test.close(); }
	});

	it("replaces a channel closed by the server without losing the SSH connection", async () => {
		const test = await fixture();
		try {
			await upload(test, "first");
			test.channels[0]!.end();
			await vi.waitFor(() => expect(test.broker.snapshotWorkspace(test.target.workspaceId).activeChannels).toBe(0));
			await upload(test, "second");
			expect(test.channels).toHaveLength(2);
			expect(test.files.get("/remote/second")?.toString()).toBe("second");
		} finally { await test.close(); }
	});

	it("retires idle channels and recreates them for later work", async () => {
		const test = await fixture();
		try {
			await upload(test, "first");
			await vi.waitFor(() => expect(test.broker.snapshotWorkspace(test.target.workspaceId).activeChannels).toBe(0), { timeout: 2000 });
			await upload(test, "second");
			expect(test.channels).toHaveLength(2);
		} finally { await test.close(); }
	});

	it("discards the shared channel when its workspace connection is invalidated", async () => {
		const test = await fixture();
		try {
			await upload(test, "first");
			test.broker.invalidateWorkspace(test.target.workspaceId);
			await upload(test, "second");
			expect(test.channels).toHaveLength(2);
			expect(test.files.get("/remote/second")?.toString()).toBe("second");
		} finally { await test.close(); }
	});

	it("settles a download on transport loss without waiting for a dead file handle", async () => {
		const test = await fixture(); test.loseRead();
		test.files.set("/remote/read", Buffer.from("data"));
		try {
			await expect(test.broker.download({ target: test.target, remotePath: "/remote/read",
				signal: new AbortController().signal, onData: async () => {}, onProgress: async () => {},
			})).rejects.toMatchObject({ code: "sftp_operation_failed" });
		} finally { await test.close(); }
	});

	it("reports an uncertain upload commit after a disconnect without replaying", async () => {
		const test = await fixture(); test.loseRename();
		try {
			await expect(upload(test, "uncertain")).rejects.toMatchObject({ failure: { code: "upload_result_uncertain" } });
			expect(test.files.get("/remote/uncertain")?.toString()).toBe("uncertain");
			expect(test.channels).toHaveLength(1);
		} finally { await test.close(); }
	});
});
