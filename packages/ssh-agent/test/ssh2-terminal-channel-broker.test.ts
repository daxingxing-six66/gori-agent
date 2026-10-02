import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Client, ClientChannel } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";
import type { UseSsh2ChannelSlotInput } from "../src/infrastructure/ssh/ssh2-connection-pool.ts";
import { Ssh2TerminalChannelBroker } from "../src/infrastructure/ssh/ssh2-terminal-channel-broker.ts";

class FakeChannel extends PassThrough {
	readonly stderr = new PassThrough();
	readonly windows: Array<{ rows: number; cols: number }> = [];

	setWindow(rows: number, cols: number): void {
		this.windows.push({ rows, cols });
	}

	override end(): this {
		queueMicrotask(() => this.emit("close"));
		return this;
	}
}

class FakeClient extends EventEmitter {
	readonly channels: FakeChannel[] = [];
	readonly commands: string[] = [];

	shell(_options: unknown, callback: (error: Error | undefined, channel?: ClientChannel) => void): void {
		const channel = new FakeChannel();
		this.channels.push(channel);
		callback(undefined, channel as unknown as ClientChannel);
	}

	exec(command: string, _options: unknown, callback: (error: Error | undefined, channel?: ClientChannel) => void): void {
		this.commands.push(command);
		this.shell(_options, callback);
	}
}

class FakePool {
	readonly client = new FakeClient();
	activeSlots = 0;

	async withChannelSlot<T>(input: UseSsh2ChannelSlotInput<T>): Promise<T> {
		this.activeSlots += 1;
		try {
			return await input.operation({
				client: this.client as unknown as Client,
				generation: 7,
				isCurrent: () => true,
			});
		} finally {
			this.activeSlots -= 1;
		}
	}
}

const target: SshTargetSnapshot = {
	workspaceId: "workspace-1",
	workspaceRevision: 1,
	credentialId: "credential-1",
	credentialAuthVersion: 1,
	hostname: "localhost",
	port: 22,
	remoteUser: "root",
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: "SHA256:test",
	connectTimeoutMs: 1000,
	keepaliveIntervalMs: 1000,
	keepaliveMaxCount: 3,
	defaultCwd: "/tmp",
};

describe("Ssh2TerminalChannelBroker", () => {
	it("holds the shared channel slot until the Terminal handle is disposed", async () => {
		const pool = new FakePool();
		const broker = new Ssh2TerminalChannelBroker(pool);
		const output: Uint8Array[] = [];
		const handle = await broker.open({
			target,
			launch: { kind: "login_shell" },
			geometry: { rows: 36, cols: 120 },
			term: "xterm-256color",
			signal: new AbortController().signal,
			onData: (chunk) => output.push(chunk),
		});

		expect(pool.activeSlots).toBe(1);
		const channel = pool.client.channels[0]!;
		channel.emit("data", Buffer.from("stdout"));
		channel.stderr.emit("data", Buffer.from("stderr"));
		expect(output).toEqual([]);
		handle.startOutput();
		await handle.resize({ rows: 40, cols: 132 });
		expect(output.map((chunk) => Buffer.from(chunk).toString("utf8"))).toEqual(["stdout", "stderr"]);
		expect(channel.windows).toEqual([{ rows: 40, cols: 132 }]);

		await handle.close();
		expect((await handle.closed).kind).toBe("closed");
		expect(pool.activeSlots).toBe(1);
		handle.dispose();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(pool.activeSlots).toBe(0);
	});

	it("releases backpressure listeners after drain or channel close", async () => {
		const pool = new FakePool();
		const broker = new Ssh2TerminalChannelBroker(pool);
		const handle = await broker.open({ target, launch: { kind: "login_shell" },
			geometry: { rows: 24, cols: 80 }, term: "xterm-256color", signal: new AbortController().signal,
			onData: () => undefined });
		const channel = pool.client.channels[0]!;
		vi.spyOn(channel, "write").mockReturnValue(false);
		const baselineErrors = channel.listenerCount("error");

		const drained = handle.write(new Uint8Array([1]));
		expect(channel.listenerCount("drain")).toBe(1);
		channel.emit("drain");
		await expect(drained).resolves.toBeUndefined();
		expect(channel.listenerCount("drain")).toBe(0);
		expect(channel.listenerCount("error")).toBe(baselineErrors);

		const closed = handle.write(new Uint8Array([2]));
		channel.emit("close");
		await expect(closed).rejects.toThrow("Terminal channel closed before the write drained");
		expect(channel.listenerCount("drain")).toBe(0);
		expect(channel.listenerCount("error")).toBe(baselineErrors);
		handle.dispose();
	});

	it("rejects excess PTYs in the same connection generation without queueing", async () => {
		const pool = new FakePool();
		const broker = new Ssh2TerminalChannelBroker(pool, { maxTerminalsPerConnectionGeneration: 1 });
		const first = await broker.open({
			target,
			launch: { kind: "login_shell" },
			geometry: { rows: 36, cols: 120 },
			term: "xterm-256color",
			signal: new AbortController().signal,
			onData: () => undefined,
		});

		await expect(
			broker.open({
				target,
				launch: { kind: "login_shell" },
				geometry: { rows: 36, cols: 120 },
				term: "xterm-256color",
				signal: new AbortController().signal,
				onData: () => undefined,
			}),
		).rejects.toMatchObject({ failure: { code: "channel_limit_reached" } });

		first.dispose();
	});

	it("waits for a split PTY confirmation and removes its marker before releasing buffered output", async () => {
		const pool = new FakePool();
		const broker = new Ssh2TerminalChannelBroker(pool);
		const output: string[] = [];
		const opened = broker.open({ target, launch: { kind: "sandboxed_exec", command: "launcher --terminal", confirmation: "gori-landlock: confined abi=8 token=abcd" },
			geometry: { rows: 24, cols: 80 }, term: "xterm-256color", signal: new AbortController().signal,
			onData: (bytes) => output.push(Buffer.from(bytes).toString()) });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const channel = pool.client.channels[0]!;
		expect(pool.client.commands).toEqual(["launcher --terminal"]);
		channel.emit("data", Buffer.from("diagnostic\r\ngori-landlock: confined abi=8 tok"));
		channel.emit("data", Buffer.from("en=abcd\r\nready\r\n"));
		const handle = await opened;
		expect(output).toEqual([]);
		handle.startOutput();
		expect(output.join("")).toBe("diagnostic\r\nready\r\n");
		handle.dispose();
	});

	it("fails closed and frees the channel slot when confirmation is missing", async () => {
		const pool = new FakePool();
		const broker = new Ssh2TerminalChannelBroker(pool);
		const opened = broker.open({ target, launch: { kind: "sandboxed_exec", command: "launcher", confirmation: "expected" },
			geometry: { rows: 24, cols: 80 }, term: "xterm-256color", signal: new AbortController().signal,
			onData: () => { throw new Error("Unexpected output"); } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		pool.client.channels[0]!.emit("close");
		await expect(opened).rejects.toThrow("confirmation");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(pool.activeSlots).toBe(0);
	});

	it("cancels an unconfirmed PTY and releases its capacity", async () => {
		const pool = new FakePool();
		const broker = new Ssh2TerminalChannelBroker(pool);
		const controller = new AbortController();
		const opened = broker.open({ target, launch: { kind: "sandboxed_exec", command: "launcher", confirmation: "expected" },
			geometry: { rows: 24, cols: 80 }, term: "xterm-256color", signal: controller.signal, onData: () => undefined });
		await new Promise<void>((resolve) => setImmediate(resolve));
		controller.abort();
		await expect(opened).rejects.toMatchObject({ failure: { code: "execution_cancelled" } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(pool.activeSlots).toBe(0);
	});

	it("rejects an excessive startup prefix before it can reach the screen", async () => {
		const pool = new FakePool();
		const broker = new Ssh2TerminalChannelBroker(pool);
		const output: Uint8Array[] = [];
		const opened = broker.open({ target, launch: { kind: "sandboxed_exec", command: "launcher", confirmation: "expected" },
			geometry: { rows: 24, cols: 80 }, term: "xterm-256color", signal: new AbortController().signal,
			onData: (bytes) => output.push(bytes) });
		await new Promise<void>((resolve) => setImmediate(resolve));
		pool.client.channels[0]!.emit("data", Buffer.alloc(4097, "x"));
		await expect(opened).rejects.toThrow("limit");
		expect(output).toEqual([]);
	});
});
