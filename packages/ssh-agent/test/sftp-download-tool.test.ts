import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SshTargetResolver } from "../src/application/services/ssh-target-resolver.ts";
import type { DownloadRemoteFileInput, SftpFileBroker } from "../src/application/ssh-channel-broker.ts";
import {
	createSftpDownloadTool,
	type RequestSftpDownloadOverwriteApproval,
	type SftpDownloadDetails,
} from "../src/application/tools/sftp-download-tool.ts";
import { FileTransferError, type SftpDirectoryEntry } from "../src/domain/file-transfer.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";

const target: SshTargetSnapshot = {
	workspaceId: "workspace-1",
	workspaceRevision: 1,
	hostname: "server",
	port: 22,
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: "SHA256:test",
	credentialId: "credential-1",
	credentialAuthVersion: 1,
	remoteUser: "root",
	defaultCwd: "/srv",
	connectTimeoutMs: 1_000,
	keepaliveIntervalMs: 1_000,
	keepaliveMaxCount: 3,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakeSftpBroker implements SftpFileBroker {
	readonly entries = new Map<string, SftpDirectoryEntry>();
	readonly downloads: string[] = [];
	readonly downloadStarted: Promise<void>;
	content = new Uint8Array([1, 2, 3, 4]);
	chunkSize = 2;
	waitForAbort = false;
	afterDownload?: () => Promise<void>;
	private markDownloadStarted: () => void = () => {};

	constructor() {
		this.entries.set("/remote/artifact.bin", entry("/remote/artifact.bin", "file", this.content.byteLength));
		this.downloadStarted = new Promise((resolve) => {
			this.markDownloadStarted = resolve;
		});
	}

	async listDirectory(): Promise<{ path: string; entries: SftpDirectoryEntry[] }> {
		return { path: "/remote", entries: [] };
	}

	async stat(input: Parameters<SftpFileBroker["stat"]>[0]): Promise<SftpDirectoryEntry> {
		const value = this.entries.get(input.remotePath);
		if (!value) throw new FileTransferError("file_not_found", "missing", 404);
		return { ...value };
	}

	async upload(): Promise<{ bytesTransferred: number }> {
		throw new Error("not implemented");
	}

	async download(input: DownloadRemoteFileInput): Promise<{ bytesTransferred: number }> {
		this.downloads.push(input.remotePath);
		this.markDownloadStarted();
		if (this.waitForAbort) {
			await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
			throw new FileTransferError("transfer_cancelled", "cancelled", 409);
		}
		let bytes = 0;
		for (let offset = 0; offset < this.content.byteLength; offset += this.chunkSize) {
			const chunk = this.content.slice(offset, Math.min(this.content.byteLength, offset + this.chunkSize));
			await input.onData(chunk);
			bytes += chunk.byteLength;
			await input.onProgress(bytes);
		}
		await this.afterDownload?.();
		return { bytesTransferred: bytes };
	}

	async deleteFile(): Promise<void> {
		throw new Error("not implemented");
	}
}

describe("sftp_download Tool", () => {
	it("does not open a staging file while queued and exposes queue saturation", async () => {
		const fixture = await createFixture();
		vi.spyOn(fixture.broker, "download").mockImplementation(async () => {
			expect(await readdir(fixture.downloads)).toEqual([]);
			throw new FileTransferError("transfer_queue_full", "queue full", 429);
		});
		await expect(fixture.tool(vi.fn()).execute("queue-full", { remoteFilePath: "/remote/artifact.bin", targetPath: fixture.downloads }))
			.rejects.toMatchObject({ details: { status: "failed", presentationMessage: { key: "sftp.transfer_queue_full" } } });
		expect(await readdir(fixture.downloads)).toEqual([]);
	});

	it("creates an empty local file even when download emits no chunks", async () => {
		const fixture = await createFixture();
		fixture.broker.content = new Uint8Array();
		fixture.broker.entries.set("/remote/artifact.bin", entry("/remote/artifact.bin", "file", 0));
		await fixture.tool(vi.fn()).execute("empty", { remoteFilePath: "/remote/artifact.bin", targetPath: fixture.downloads });
		expect(await readFile(join(fixture.downloads, "artifact.bin"))).toHaveLength(0);
	});

	it("streams a remote file into a local directory without approval", async () => {
		const fixture = await createFixture();
		const approval = vi.fn<RequestSftpDownloadOverwriteApproval>();
		const updates: SftpDownloadDetails[] = [];

		const result = await fixture
			.tool(approval)
			.execute("tool-1", { remoteFilePath: "/remote/artifact.bin", targetPath: "downloads" }, undefined, (update) =>
				updates.push(update.details),
			);

		expect(approval).not.toHaveBeenCalled();
		expect(fixture.broker.downloads).toEqual(["/remote/artifact.bin"]);
		expect(await readFile(join(fixture.downloads, "artifact.bin"))).toEqual(Buffer.from([1, 2, 3, 4]));
		expect(result.details).toMatchObject({
			status: "completed",
			remoteFilePath: "/remote/artifact.bin",
			localPath: join(fixture.downloads, "artifact.bin"),
			totalBytes: 4,
			bytesTransferred: 4,
			overwrite: false,
		});
		expect(updates[0]?.update).toEqual({
			type: "status",
			detail: {
				status: "preparing",
				message: "Checking remote file: /remote/artifact.bin",
				messageDescriptor: { key: "sftp.download_checking", values: { path: "/remote/artifact.bin" } },
			},
		});
		expect(updates.at(-1)?.update).toEqual({
			type: "progress",
			detail: {
				current: 4,
				total: 4,
				unit: "bytes",
				message: "Downloading /remote/artifact.bin",
				messageDescriptor: { key: "sftp.download_running", values: { path: "/remote/artifact.bin" } },
			},
		});
	});

	it("requires approval before replacing an existing local file", async () => {
		const fixture = await createFixture();
		const destination = join(fixture.downloads, "artifact.bin");
		await writeFile(destination, "old");
		const approval = vi.fn<RequestSftpDownloadOverwriteApproval>().mockResolvedValue({ approved: true });
		const updates: SftpDownloadDetails[] = [];

		const result = await fixture
			.tool(approval)
			.execute(
				"tool-2",
				{ remoteFilePath: "/remote/artifact.bin", targetPath: fixture.downloads },
				undefined,
				(update) => updates.push(update.details),
			);

		expect(approval).toHaveBeenCalledWith(
			"tool-2",
			expect.objectContaining({ path: destination, type: "file", size: 3 }),
			expect.any(AbortSignal),
		);
		expect(await readFile(destination)).toEqual(Buffer.from([1, 2, 3, 4]));
		expect(result.details).toMatchObject({ status: "completed", overwrite: true });
		expect(updates).toContainEqual(
			expect.objectContaining({
				update: {
					type: "status",
					detail: {
						status: "waiting_for_approval",
						message: `Waiting for approval to overwrite ${destination}`,
						messageDescriptor: {
							key: "sftp.download_waiting_approval",
							values: { path: destination },
						},
					},
				},
			}),
		);
	});

	it("does not open a remote download when overwrite approval is rejected", async () => {
		const fixture = await createFixture();
		const destination = join(fixture.downloads, "artifact.bin");
		await writeFile(destination, "old");
		const approval = vi
			.fn<RequestSftpDownloadOverwriteApproval>()
			.mockResolvedValue({ approved: false, reason: "user_rejected" });

		await expect(
			fixture.tool(approval).execute("tool-3", {
				remoteFilePath: "/remote/artifact.bin",
				targetPath: fixture.downloads,
			}),
		).rejects.toMatchObject({ name: "AgentToolError", terminate: true, details: { status: "cancelled" } });
		expect(fixture.broker.downloads).toEqual([]);
		expect(await readFile(destination, "utf8")).toBe("old");
	});

	it("requests approval if a local file appears before commit", async () => {
		const fixture = await createFixture();
		const destination = join(fixture.downloads, "artifact.bin");
		fixture.broker.afterDownload = () => writeFile(destination, "raced");
		const approval = vi.fn<RequestSftpDownloadOverwriteApproval>().mockResolvedValue({ approved: true });

		const result = await fixture.tool(approval).execute("tool-race", {
			remoteFilePath: "/remote/artifact.bin",
			targetPath: fixture.downloads,
		});

		expect(approval).toHaveBeenCalledOnce();
		expect(await readFile(destination)).toEqual(Buffer.from([1, 2, 3, 4]));
		expect(result.details).toMatchObject({ status: "completed", overwrite: true });
	});

	it("rejects invalid remote and local object types", async () => {
		const fixture = await createFixture();
		fixture.broker.entries.set("/remote/folder", entry("/remote/folder", "directory", 0));
		fixture.broker.entries.set("/remote/link", entry("/remote/link", "symlink", 0));
		await symlink(fixture.downloads, join(fixture.directory, "downloads-link"));

		await expect(
			fixture.tool(vi.fn()).execute("tool-relative", {
				remoteFilePath: "remote/artifact.bin",
				targetPath: fixture.downloads,
			}),
		).rejects.toMatchObject({ details: { status: "failed" } });
		await expect(
			fixture.tool(vi.fn()).execute("tool-directory", {
				remoteFilePath: "/remote/folder",
				targetPath: fixture.downloads,
			}),
		).rejects.toMatchObject({ details: { status: "failed" } });
		await expect(
			fixture.tool(vi.fn()).execute("tool-remote-link", {
				remoteFilePath: "/remote/link",
				targetPath: fixture.downloads,
			}),
		).rejects.toMatchObject({ details: { status: "failed" } });
		await expect(
			fixture.tool(vi.fn()).execute("tool-local-link", {
				remoteFilePath: "/remote/artifact.bin",
				targetPath: "downloads-link",
			}),
		).rejects.toMatchObject({ details: { status: "failed" } });
		await expect(
			fixture.tool(vi.fn()).execute("tool-local-missing", {
				remoteFilePath: "/remote/artifact.bin",
				targetPath: "missing",
			}),
		).rejects.toMatchObject({ details: { status: "failed" } });
	});

	it("rejects a non-file local destination without requesting approval", async () => {
		const fixture = await createFixture();
		const destination = join(fixture.downloads, "artifact.bin");
		await mkdir(destination);
		const approval = vi.fn<RequestSftpDownloadOverwriteApproval>();

		await expect(
			fixture.tool(approval).execute("tool-local-directory", {
				remoteFilePath: "/remote/artifact.bin",
				targetPath: fixture.downloads,
			}),
		).rejects.toMatchObject({ details: { status: "failed" } });
		expect(approval).not.toHaveBeenCalled();
		expect(fixture.broker.downloads).toEqual([]);
	});

	it("preserves an existing file and cleans staging data on size mismatch", async () => {
		const fixture = await createFixture();
		const destination = join(fixture.downloads, "artifact.bin");
		await writeFile(destination, "old");
		fixture.broker.entries.set("/remote/artifact.bin", entry("/remote/artifact.bin", "file", 5));

		await expect(
			fixture.tool(vi.fn().mockResolvedValue({ approved: true })).execute("tool-size", {
				remoteFilePath: "/remote/artifact.bin",
				targetPath: fixture.downloads,
			}),
		).rejects.toMatchObject({ details: { status: "failed", bytesTransferred: 4 } });
		expect(await readFile(destination, "utf8")).toBe("old");
		expect((await readdir(fixture.downloads)).filter((name) => name.includes(".pi-download-"))).toEqual([]);
	});

	it("passes cancellation to the SFTP channel and cleans the temporary file", async () => {
		const fixture = await createFixture();
		fixture.broker.waitForAbort = true;
		const controller = new AbortController();
		const execution = fixture
			.tool(vi.fn())
			.execute(
				"tool-cancel",
				{ remoteFilePath: "/remote/artifact.bin", targetPath: fixture.downloads },
				controller.signal,
			);
		await fixture.broker.downloadStarted;
		controller.abort();

		await expect(execution).rejects.toMatchObject({ details: { status: "cancelled" } });
		expect((await readdir(fixture.downloads)).filter((name) => name.includes(".pi-download-"))).toEqual([]);
	});

	it("throttles intermediate progress and always emits the final update", async () => {
		const fixture = await createFixture();
		fixture.broker.content = new Uint8Array(700 * 1024);
		fixture.broker.chunkSize = 64 * 1024;
		fixture.broker.entries.set(
			"/remote/artifact.bin",
			entry("/remote/artifact.bin", "file", fixture.broker.content.byteLength),
		);
		const updates: SftpDownloadDetails[] = [];

		await fixture
			.tool(vi.fn())
			.execute(
				"tool-progress",
				{ remoteFilePath: "/remote/artifact.bin", targetPath: fixture.downloads },
				undefined,
				(update) => updates.push(update.details),
			);

		const progress = updates.filter((update) => update.status === "downloading");
		expect(progress[0]).toMatchObject({ bytesTransferred: 0, progressPercent: 0 });
		expect(progress.some((update) => (update.progressPercent ?? 0) > 0 && (update.progressPercent ?? 0) < 100)).toBe(
			true,
		);
		expect(progress.at(-1)).toMatchObject({ bytesTransferred: 700 * 1024, progressPercent: 100 });
	});
});

async function createFixture(): Promise<{
	directory: string;
	downloads: string;
	broker: FakeSftpBroker;
	tool(approval: RequestSftpDownloadOverwriteApproval): ReturnType<typeof createSftpDownloadTool>;
}> {
	const directory = await mkdtemp(join(tmpdir(), "sftp-download-tool-"));
	temporaryDirectories.push(directory);
	const downloads = join(directory, "downloads");
	await mkdir(downloads);
	const broker = new FakeSftpBroker();
	const env = new NodeExecutionEnv({ cwd: directory });
	const targets: SshTargetResolver = { resolve: async () => target };
	return {
		directory,
		downloads,
		broker,
		tool: (requestOverwriteApproval) =>
			createSftpDownloadTool({
				sessionId: "session-1",
				env,
				targets,
				broker,
				requestOverwriteApproval,
			}),
	};
}

function entry(path: string, type: SftpDirectoryEntry["type"], size: number): SftpDirectoryEntry {
	return {
		name: path.slice(path.lastIndexOf("/") + 1),
		path,
		type,
		size,
		modifiedAt: 1,
		permissions: 0o644,
	};
}
