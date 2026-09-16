import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Client, ClientChannel } from "ssh2";
import { describe, expect, it } from "vitest";
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

	shell(_options: unknown, callback: (error: Error | undefined, channel?: ClientChannel) => void): void {
		const channel = new FakeChannel();
		this.channels.push(channel);
		callback(undefined, channel as unknown as ClientChannel);
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
			geometry: { rows: 36, cols: 120 },
			term: "xterm-256color",
			signal: new AbortController().signal,
			onData: (chunk) => output.push(chunk),
		});

		expect(pool.activeSlots).toBe(1);
		const channel = pool.client.channels[0]!;
		channel.emit("data", Buffer.from("stdout"));
		channel.stderr.emit("data", Buffer.from("stderr"));
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

	it("rejects excess PTYs in the same connection generation without queueing", async () => {
		const pool = new FakePool();
		const broker = new Ssh2TerminalChannelBroker(pool, { maxTerminalsPerConnectionGeneration: 1 });
		const first = await broker.open({
			target,
			geometry: { rows: 36, cols: 120 },
			term: "xterm-256color",
			signal: new AbortController().signal,
			onData: () => undefined,
		});

		await expect(
			broker.open({
				target,
				geometry: { rows: 36, cols: 120 },
				term: "xterm-256color",
				signal: new AbortController().signal,
				onData: () => undefined,
			}),
		).rejects.toMatchObject({ failure: { code: "channel_limit_reached" } });

		first.dispose();
	});
});
