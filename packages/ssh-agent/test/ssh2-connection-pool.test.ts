import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server, utils } from "ssh2";
import { describe, expect, it } from "vitest";
import type { CredentialSecretStore } from "../src/application/repositories/credential-repository.ts";
import type { CredentialSecret } from "../src/domain/credential.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";
import { Ssh2ChannelBroker } from "../src/infrastructure/ssh/ssh2-channel-broker.ts";
import { Ssh2ConnectionPool } from "../src/infrastructure/ssh/ssh2-connection-pool.ts";

class PasswordSecretStore implements CredentialSecretStore {
	async put(): Promise<void> {}
	async get(): Promise<CredentialSecret> {
		return { type: "password", password: "test-password" };
	}
	async deleteAll(): Promise<void> {}
}

describe("ssh2 Connection Pool", () => {
	it("rejects a cancelled upload before opening a connection", async () => {
		const controller = new AbortController();
		controller.abort();
		const pool = new Ssh2ChannelBroker(new PasswordSecretStore());
		try {
			await expect(
				pool.upload({
					target: createTarget(22, "SHA256:unused"),
					remotePath: "/srv/artifact.tar",
					data: chunks("never"),
					signal: controller.signal,
					overwrite: false,
					onProgress: async () => {},
				}),
			).rejects.toMatchObject({ failure: { code: "upload_cancelled", retryable: false } });
		} finally {
			pool.close();
		}
	});

	it("strictly verifies the host key and reuses one physical connection for sequential channels", async () => {
		const hostKey = utils.generateKeyPairSync("ed25519");
		const parsed = utils.parseKey(hostKey.private);
		if (parsed instanceof Error) throw parsed;
		const expectedFingerprint = `SHA256:${createHash("sha256")
			.update(parsed.getPublicSSH())
			.digest("base64")
			.replace(/=+$/, "")}`;
		let connectionCount = 0;
		const connections: Array<{ end(): unknown }> = [];
		const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
			connectionCount += 1;
			connections.push(client);
			client.on("error", () => {});
			client.on("authentication", (context) => {
				if (context.method === "password" && context.password === "test-password") context.accept();
				else context.reject();
			});
			client.on("ready", () => {
				client.on("session", (accept) => {
					const session = accept();
					session.on("exec", (acceptExec, _reject, info) => {
						const channel = acceptExec();
						channel.write(`ran:${info.command}`);
						channel.exit(0);
						channel.end();
					});
				});
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const port = (server.address() as AddressInfo).port;
		const pool = new Ssh2ChannelBroker(new PasswordSecretStore(), {
			idleConnectionTimeoutMs: 10_000,
			reconnectDelaysMs: [1, 2, 4, 8, 16],
			random: () => 0.5,
		});
		const target = createTarget(port, expectedFingerprint);
		try {
			const outputs: string[] = [];
			for (const command of ["first", "second"]) {
				const result = await pool.execute({
					target,
					command,
					signal: new AbortController().signal,
					onStdout: async (chunk) => {
						outputs.push(Buffer.from(chunk).toString("utf8"));
					},
					onStderr: async () => {},
				});
				expect(result.exitCode).toBe(0);
			}
			expect(outputs).toEqual(["ran:first", "ran:second"]);
			expect(connectionCount).toBe(1);
			connections[0]?.end();
			await waitFor(() => connectionCount === 2);
			await pool.execute({
				target,
				command: "after-reconnect",
				signal: new AbortController().signal,
				onStdout: async (chunk) => {
					outputs.push(Buffer.from(chunk).toString("utf8"));
				},
				onStderr: async () => {},
			});
			expect(outputs.at(-1)).toBe("ran:after-reconnect");

			const mismatchedPool = new Ssh2ChannelBroker(new PasswordSecretStore());
			try {
				await expect(
					mismatchedPool.execute({
						target: createTarget(port, "SHA256:not-the-server"),
						command: "never",
						signal: new AbortController().signal,
						onStdout: async () => {},
						onStderr: async () => {},
					}),
				).rejects.toMatchObject({ failure: { code: "host_key_mismatch", retryable: false } });
				await expect(
					mismatchedPool.execute({
						target: { ...target, hostKeyAlgorithm: "rsa-sha2-512" },
						command: "never",
						signal: new AbortController().signal,
						onStdout: async () => {},
						onStderr: async () => {},
					}),
				).rejects.toMatchObject({ failure: { code: "host_key_mismatch", retryable: false } });
			} finally {
				mismatchedPool.close();
			}
		} finally {
			pool.close();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("marks an active command uncertain on disconnect and reconnects without replaying it", async () => {
		const hostKey = utils.generateKeyPairSync("ed25519");
		const parsed = utils.parseKey(hostKey.private);
		if (parsed instanceof Error) throw parsed;
		const expectedFingerprint = `SHA256:${createHash("sha256")
			.update(parsed.getPublicSSH())
			.digest("base64")
			.replace(/=+$/, "")}`;
		let connectionCount = 0;
		const commands: string[] = [];
		const connections: Array<{ end(): unknown }> = [];
		const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
			connectionCount += 1;
			connections.push(client);
			client.on("error", () => {});
			client.on("authentication", (context) => {
				if (context.method === "password" && context.password === "test-password") context.accept();
				else context.reject();
			});
			client.on("ready", () => {
				client.on("session", (accept) => {
					const session = accept();
					session.on("exec", (acceptExec, _reject, info) => {
						commands.push(info.command);
						const channel = acceptExec();
						if (info.command === "hold") return;
						channel.write(`ran:${info.command}`);
						channel.exit(0);
						channel.end();
					});
				});
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const port = (server.address() as AddressInfo).port;
		const pool = new Ssh2ChannelBroker(new PasswordSecretStore(), {
			idleConnectionTimeoutMs: 10_000,
			reconnectDelaysMs: [1, 2, 4],
			random: () => 0.5,
		});
		const target = createTarget(port, expectedFingerprint);
		try {
			const active = pool.execute({
				target,
				command: "hold",
				signal: new AbortController().signal,
				onStdout: async () => {},
				onStderr: async () => {},
			});
			await waitFor(() => commands.includes("hold"));
			const rejected = expect(active).rejects.toMatchObject({
				failure: { code: "execution_result_uncertain", retryable: false },
			});
			connections[0]?.end();
			await rejected;
			await waitFor(() => connectionCount === 2);

			const output: string[] = [];
			await pool.execute({
				target,
				command: "after-disconnect",
				signal: new AbortController().signal,
				onStdout: async (chunk) => {
					output.push(Buffer.from(chunk).toString("utf8"));
				},
				onStderr: async () => {},
			});
			expect(output).toEqual(["ran:after-disconnect"]);
			expect(commands).toEqual(["hold", "after-disconnect"]);
		} finally {
			pool.close();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("uploads through an SFTP channel, reports progress, and atomically renames the temporary file", async () => {
		const hostKey = utils.generateKeyPairSync("ed25519");
		const parsed = utils.parseKey(hostKey.private);
		if (parsed instanceof Error) throw parsed;
		const expectedFingerprint = `SHA256:${createHash("sha256")
			.update(parsed.getPublicSSH())
			.digest("base64")
			.replace(/=+$/, "")}`;
		let connectionCount = 0;
		let temporaryPath: string | undefined;
		let temporaryContent = Buffer.alloc(0);
		let finalContent: Buffer | undefined;
		let openFlags: number | undefined;
		const writeOffsets: number[] = [];
		let renameDestination: string | undefined;
		const requestOrder: string[] = [];
		const unlinkedPaths: string[] = [];
		const uploadHandle = Buffer.from("upload-handle");
		const downloadHandle = Buffer.from("download-handle");
		let downloadCloseAcknowledged = false;
		const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
			connectionCount += 1;
			client.on("error", () => {});
			client.on("authentication", (context) => {
				if (context.method === "password" && context.password === "test-password") context.accept();
				else context.reject();
			});
			client.on("ready", () => {
				client.on("session", (accept) => {
					const session = accept();
					session.on("sftp", (acceptSftp) => {
						const sftp = acceptSftp();
						sftp.on("OPEN", (requestId, filename, flags) => {
							if (flags === utils.sftp.OPEN_MODE.READ && filename === "/srv/artifact.tar" && finalContent) {
								sftp.handle(requestId, downloadHandle);
								return;
							}
							requestOrder.push("open");
							openFlags = flags;
							temporaryPath = filename;
							sftp.handle(requestId, uploadHandle);
						});
						sftp.on("LSTAT", (requestId, path) => {
							if (path === "/srv/artifact.tar" && finalContent)
								sftp.attrs(requestId, {
									mode: 0o100644,
									size: finalContent.byteLength,
									uid: 0,
									gid: 0,
									atime: 0,
									mtime: 0,
								});
							else sftp.status(requestId, utils.sftp.STATUS_CODE.NO_SUCH_FILE);
						});
						sftp.on("WRITE", (requestId, receivedHandle, offset, data) => {
							requestOrder.push("write");
							if (!receivedHandle.equals(uploadHandle)) throw new Error("Unexpected SFTP file handle");
							writeOffsets.push(offset);
							temporaryContent = Buffer.concat([temporaryContent, data]);
							sftp.status(requestId, utils.sftp.STATUS_CODE.OK);
						});
						sftp.on("CLOSE", (requestId, receivedHandle) => {
							if (receivedHandle.equals(downloadHandle)) {
								setTimeout(() => {
									downloadCloseAcknowledged = true;
									sftp.status(requestId, utils.sftp.STATUS_CODE.OK);
								}, 5);
								return;
							}
							requestOrder.push("close");
							if (!receivedHandle.equals(uploadHandle)) throw new Error("Unexpected SFTP file handle");
							sftp.status(requestId, utils.sftp.STATUS_CODE.OK);
						});
						sftp.on("READ", (requestId, receivedHandle, offset, length) => {
							if (!receivedHandle.equals(downloadHandle) || !finalContent)
								throw new Error("Unexpected SFTP download handle");
							if (offset >= finalContent.byteLength) {
								sftp.status(requestId, utils.sftp.STATUS_CODE.EOF);
								return;
							}
							sftp.data(requestId, finalContent.subarray(offset, offset + length));
						});
						sftp.on("RENAME", (requestId, sourcePath, destinationPath) => {
							requestOrder.push("rename");
							if (sourcePath !== temporaryPath) throw new Error("Unexpected SFTP temporary path");
							renameDestination = destinationPath;
							finalContent = temporaryContent;
							temporaryContent = Buffer.alloc(0);
							sftp.status(requestId, utils.sftp.STATUS_CODE.OK);
						});
						sftp.on("REMOVE", (requestId, path) => {
							unlinkedPaths.push(path);
							sftp.status(requestId, utils.sftp.STATUS_CODE.OK);
						});
					});
					session.on("exec", (acceptExec, _reject, info) => {
						const channel = acceptExec();
						channel.write(`ran:${info.command}`);
						channel.exit(0);
						channel.end();
					});
				});
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const port = (server.address() as AddressInfo).port;
		const pool = new Ssh2ChannelBroker(new PasswordSecretStore(), { idleConnectionTimeoutMs: 10_000 });
		try {
			const progress: number[] = [];
			const result = await pool.upload({
				target: createTarget(port, expectedFingerprint),
				remotePath: "/srv/artifact.tar",
				data: chunks("first", "-second"),
				signal: new AbortController().signal,
				overwrite: false,
				onProgress: async (bytesTransferred) => {
					progress.push(bytesTransferred);
				},
			});
			expect(result).toEqual({ bytesTransferred: 12 });
			expect(progress).toEqual([5, 12]);
			expect(finalContent?.toString("utf8")).toBe("first-second");
			expect(temporaryContent).toHaveLength(0);
			expect(temporaryPath).toMatch(/^\/srv\/\.artifact\.tar\.pi-upload-.+\.tmp$/);
			expect(openFlags).toBe(utils.sftp.OPEN_MODE.WRITE | utils.sftp.OPEN_MODE.CREAT | utils.sftp.OPEN_MODE.TRUNC);
			expect(writeOffsets).toEqual([0, 5]);
			expect(renameDestination).toBe("/srv/artifact.tar");
			expect(requestOrder).toEqual(["open", "write", "write", "close", "rename"]);

			let downloaded = "";
			const download = await pool.download({
				target: createTarget(port, expectedFingerprint),
				remotePath: "/srv/artifact.tar",
				signal: new AbortController().signal,
				onData: async (chunk) => {
					downloaded += Buffer.from(chunk).toString("utf8");
				},
				onProgress: async () => {},
			});
			expect(download).toEqual({ bytesTransferred: 12 });
			expect(downloaded).toBe("first-second");
			expect(downloadCloseAcknowledged).toBe(true);

			await expect(
				pool.upload({
					target: createTarget(port, expectedFingerprint),
					remotePath: "/srv/artifact.tar",
					data: chunks("replacement"),
					signal: new AbortController().signal,
					overwrite: true,
					onProgress: async () => {},
				}),
			).rejects.toMatchObject({ code: "atomic_overwrite_unsupported" });
			expect(finalContent?.toString("utf8")).toBe("first-second");
			expect(unlinkedPaths).toHaveLength(1);
			expect(unlinkedPaths[0]).toMatch(/^\/srv\/\.artifact\.tar\.pi-upload-.+\.tmp$/);

			const outputs: string[] = [];
			await pool.execute({
				target: createTarget(port, expectedFingerprint),
				command: "after-upload",
				signal: new AbortController().signal,
				onStdout: async (chunk) => {
					outputs.push(Buffer.from(chunk).toString("utf8"));
				},
				onStderr: async () => {},
			});
			expect(outputs).toEqual(["ran:after-upload"]);
			expect(connectionCount).toBe(1);
		} finally {
			pool.close();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("removes an aborted capacity waiter without granting it a later slot", async () => {
		const hostKey = utils.generateKeyPairSync("ed25519");
		const parsed = utils.parseKey(hostKey.private);
		if (parsed instanceof Error) throw parsed;
		const expectedFingerprint = `SHA256:${createHash("sha256")
			.update(parsed.getPublicSSH())
			.digest("base64")
			.replace(/=+$/, "")}`;
		const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
			client.on("error", () => {});
			client.on("authentication", (context) => {
				if (context.method === "password" && context.password === "test-password") context.accept();
				else context.reject();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const port = (server.address() as AddressInfo).port;
		const target = createTarget(port, expectedFingerprint);
		const pool = new Ssh2ConnectionPool(new PasswordSecretStore(), {
			maxChannelsPerConnection: 1,
			channelAcquireTimeoutMs: 25,
			idleConnectionTimeoutMs: 10_000,
		});
		let releaseFirst = () => {};
		const firstCanFinish = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		try {
			const first = pool.withChannelSlot({
				target,
				signal: new AbortController().signal,
				cancellationError: () => new Error("first cancelled"),
				operation: async () => await firstCanFinish,
			});
			await waitFor(() => pool.snapshotWorkspace(target.workspaceId).activeChannels === 1);

			const controller = new AbortController();
			const cancellation = new Error("capacity wait cancelled");
			let secondEntered = false;
			const second = pool.withChannelSlot({
				target,
				signal: controller.signal,
				cancellationError: () => cancellation,
				operation: async () => {
					secondEntered = true;
				},
			});
			await waitFor(() => pool.snapshotWorkspace(target.workspaceId).waitingChannels === 1);
			const rejected = expect(second).rejects.toBe(cancellation);
			controller.abort();
			await rejected;
			expect(pool.snapshotWorkspace(target.workspaceId).waitingChannels).toBe(0);
			let timedOutEntered = false;
			await expect(
				pool.withChannelSlot({
					target,
					signal: new AbortController().signal,
					cancellationError: () => new Error("cancelled"),
					operation: async () => {
						timedOutEntered = true;
					},
				}),
			).rejects.toMatchObject({ failure: { code: "channel_acquire_timeout" } });
			expect(timedOutEntered).toBe(false);

			releaseFirst();
			await first;
			expect(secondEntered).toBe(false);
		} finally {
			releaseFirst();
			pool.close();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("rejects a connecting acquisition immediately when its Workspace is invalidated", async () => {
		let resolveSecret = (_secret: CredentialSecret) => {};
		const secret = new Promise<CredentialSecret>((resolve) => {
			resolveSecret = resolve;
		});
		const secrets: CredentialSecretStore = {
			put: async () => {},
			get: async () => await secret,
			deleteAll: async () => {},
		};
		const pool = new Ssh2ConnectionPool(secrets);
		const target = createTarget(22, "SHA256:unused");
		let operationEntered = false;
		const acquisition = pool.withChannelSlot({
			target,
			signal: new AbortController().signal,
			cancellationError: () => new Error("cancelled"),
			operation: async () => {
				operationEntered = true;
			},
		});
		await waitFor(() => pool.snapshotWorkspace(target.workspaceId).state === "connecting");
		const rejected = expect(acquisition).rejects.toMatchObject({ failure: { code: "connection_invalidated" } });
		pool.invalidateWorkspace(target.workspaceId);
		await rejected;
		resolveSecret({ type: "password", password: "test-password" });
		await Promise.resolve();
		expect(operationEntered).toBe(false);
		expect(pool.snapshotWorkspace(target.workspaceId).state).toBe("idle");
		pool.close();
		pool.close();
	});
});

function createTarget(port: number, hostKeyFingerprint: string): SshTargetSnapshot {
	return {
		workspaceId: "workspace-1",
		workspaceRevision: 1,
		hostname: "127.0.0.1",
		port,
		hostKeyAlgorithm: "ssh-ed25519",
		hostKeyFingerprint,
		credentialId: "credential-1",
		credentialAuthVersion: 1,
		remoteUser: "root",
		defaultCwd: "/",
		connectTimeoutMs: 2_000,
		keepaliveIntervalMs: 500,
		keepaliveMaxCount: 2,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("Condition was not reached");
}

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
	for (const value of values) yield Buffer.from(value);
}
