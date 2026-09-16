import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SshTargetResolver } from "../src/application/services/ssh-target-resolver.ts";
import type { SftpFileBroker, UploadRemoteFileInput } from "../src/application/ssh-channel-broker.ts";
import {
	createSftpUploadTool,
	type RequestSftpOverwriteApproval,
	type SftpUploadDetails,
} from "../src/application/tools/sftp-upload-tool.ts";
import { FileTransferError, type SftpDirectoryEntry } from "../src/domain/file-transfer.ts";
import { SshAgentError } from "../src/domain/ssh-failure.ts";
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
	readonly uploads: Array<{ remotePath: string; overwrite: boolean; content: Uint8Array }> = [];
	readonly uploadStarted: Promise<void>;
	raceOnFirstUpload = false;
	uncertain = false;
	waitForAbort = false;
	private markUploadStarted: () => void = () => {};

	constructor() {
		this.entries.set("/remote", entry("/remote", "directory", 0));
		this.uploadStarted = new Promise((resolve) => {
			this.markUploadStarted = resolve;
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

	async upload(input: UploadRemoteFileInput): Promise<{ bytesTransferred: number }> {
		this.markUploadStarted();
		if (this.raceOnFirstUpload) {
			this.raceOnFirstUpload = false;
			this.entries.set(input.remotePath, entry(input.remotePath, "file", 3));
			throw new FileTransferError("file_already_exists", "exists", 409);
		}
		if (this.waitForAbort) {
			await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
			throw new SshAgentError({
				code: "upload_cancelled",
				category: "execution",
				phase: "cancel",
				message: "cancelled",
				retryable: false,
			});
		}
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		for await (const chunk of input.data) {
			chunks.push(chunk);
			bytes += chunk.byteLength;
			await input.onProgress(bytes);
		}
		if (this.uncertain)
			throw new SshAgentError({
				code: "upload_result_uncertain",
				category: "execution",
				phase: "commit",
				message: "uncertain",
				retryable: false,
			});
		this.uploads.push({
			remotePath: input.remotePath,
			overwrite: input.overwrite,
			content: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
		});
		return { bytesTransferred: bytes };
	}

	async download(): Promise<{ bytesTransferred: number }> {
		throw new Error("not implemented");
	}

	async deleteFile(): Promise<void> {
		throw new Error("not implemented");
	}
}

describe("sftp_upload Tool", () => {
	it("streams a local file to the remote directory without approval when the destination is absent", async () => {
		const fixture = await createFixture("artifact.bin", new Uint8Array([1, 2, 3, 4]));
		const approval = vi.fn<RequestSftpOverwriteApproval>();
		const updates: SftpUploadDetails[] = [];

		const result = await fixture
			.tool(approval)
			.execute("tool-1", { sourceFilePath: "artifact.bin", targetPath: "/remote" }, undefined, (update) =>
				updates.push(update.details),
			);

		expect(approval).not.toHaveBeenCalled();
		expect(fixture.broker.uploads).toHaveLength(1);
		expect(fixture.broker.uploads[0]).toMatchObject({ remotePath: "/remote/artifact.bin", overwrite: false });
		expect(Array.from(fixture.broker.uploads[0]!.content)).toEqual([1, 2, 3, 4]);
		expect(result.details).toMatchObject({
			status: "completed",
			remotePath: "/remote/artifact.bin",
			bytesTransferred: 4,
			overwrite: false,
		});
		expect(updates[0]?.update).toEqual({
			type: "status",
			detail: {
				status: "preparing",
				message: "Checking local file: artifact.bin",
				messageDescriptor: { key: "sftp.upload_checking", values: { path: "artifact.bin" } },
			},
		});
		expect(updates.at(-1)).toMatchObject({ status: "uploading", progressPercent: 100 });
		expect(updates.at(-1)?.update).toEqual({
			type: "progress",
			detail: {
				current: 4,
				total: 4,
				unit: "bytes",
				message: "Uploading /remote/artifact.bin",
				messageDescriptor: { key: "sftp.upload_running", values: { path: "/remote/artifact.bin" } },
			},
		});
	});

	it("waits for approval before atomically overwriting an existing regular file", async () => {
		const fixture = await createFixture("release.tar", new Uint8Array([5, 6, 7]));
		const existing = entry("/remote/release.tar", "file", 10);
		fixture.broker.entries.set(existing.path, existing);
		const approval = vi.fn<RequestSftpOverwriteApproval>().mockResolvedValue({ approved: true });
		const updates: SftpUploadDetails[] = [];

		const result = await fixture
			.tool(approval)
			.execute("tool-2", { sourceFilePath: "release.tar", targetPath: "/remote/" }, undefined, (update) =>
				updates.push(update.details),
			);

		expect(approval).toHaveBeenCalledWith("tool-2", existing, expect.any(AbortSignal));
		expect(fixture.broker.uploads[0]).toMatchObject({ remotePath: existing.path, overwrite: true });
		expect(result.details).toMatchObject({ status: "completed", overwrite: true });
		expect(updates).toContainEqual(
			expect.objectContaining({
				update: {
					type: "status",
					detail: {
						status: "waiting_for_approval",
						message: "Waiting for approval to overwrite /remote/release.tar",
						messageDescriptor: {
							key: "sftp.upload_waiting_approval",
							values: { path: "/remote/release.tar" },
						},
					},
				},
			}),
		);
	});

	it("does not open an upload when overwrite approval is rejected", async () => {
		const fixture = await createFixture("release.tar", new Uint8Array([5, 6, 7]));
		fixture.broker.entries.set("/remote/release.tar", entry("/remote/release.tar", "file", 10));
		const approval = vi
			.fn<RequestSftpOverwriteApproval>()
			.mockResolvedValue({ approved: false, reason: "user_rejected" });

		await expect(
			fixture.tool(approval).execute("tool-3", { sourceFilePath: "release.tar", targetPath: "/remote" }),
		).rejects.toMatchObject({
			name: "AgentToolError",
			terminate: true,
			details: { status: "cancelled", overwrite: false },
		});
		expect(fixture.broker.uploads).toEqual([]);
	});

	it("rechecks and requests approval when the destination appears concurrently", async () => {
		const fixture = await createFixture("artifact.bin", new Uint8Array([1, 2, 3]));
		fixture.broker.raceOnFirstUpload = true;
		const approval = vi.fn<RequestSftpOverwriteApproval>().mockResolvedValue({ approved: true });

		await fixture.tool(approval).execute("tool-race", {
			sourceFilePath: "artifact.bin",
			targetPath: "/remote",
		});

		expect(approval).toHaveBeenCalledOnce();
		expect(fixture.broker.uploads).toHaveLength(1);
		expect(fixture.broker.uploads[0]).toMatchObject({ remotePath: "/remote/artifact.bin", overwrite: true });
		expect(Array.from(fixture.broker.uploads[0]!.content)).toEqual([1, 2, 3]);
	});

	it("rejects symbolic-link sources", async () => {
		const fixture = await createFixture("source.txt", new Uint8Array([1]));
		await symlink(join(fixture.directory, "source.txt"), join(fixture.directory, "link.txt"));

		await expect(
			fixture.tool(vi.fn<RequestSftpOverwriteApproval>()).execute("tool-link", {
				sourceFilePath: "link.txt",
				targetPath: "/remote",
			}),
		).rejects.toMatchObject({ name: "AgentToolError", details: { status: "failed" } });
		expect(fixture.broker.uploads).toEqual([]);
	});

	it("returns a terminating uncertain result without retrying", async () => {
		const fixture = await createFixture("artifact.bin", new Uint8Array([1, 2, 3]));
		fixture.broker.uncertain = true;

		await expect(
			fixture.tool(vi.fn<RequestSftpOverwriteApproval>()).execute("tool-uncertain", {
				sourceFilePath: "artifact.bin",
				targetPath: "/remote",
			}),
		).rejects.toMatchObject({
			name: "AgentToolError",
			terminate: true,
			details: { status: "uncertain" },
		});
		expect(fixture.broker.uploads).toEqual([]);
	});

	it("passes cancellation to the SFTP upload and returns a cancelled result", async () => {
		const fixture = await createFixture("artifact.bin", new Uint8Array(512 * 1024));
		fixture.broker.waitForAbort = true;
		const controller = new AbortController();
		const execution = fixture
			.tool(vi.fn<RequestSftpOverwriteApproval>())
			.execute("tool-cancel", { sourceFilePath: "artifact.bin", targetPath: "/remote" }, controller.signal);
		await fixture.broker.uploadStarted;
		controller.abort();

		await expect(execution).rejects.toMatchObject({
			name: "AgentToolError",
			details: { status: "cancelled" },
		});
	});

	it("emits throttled intermediate progress and a final 100 percent update", async () => {
		const fixture = await createFixture("large.bin", new Uint8Array(700 * 1024));
		const updates: SftpUploadDetails[] = [];
		await fixture
			.tool(vi.fn<RequestSftpOverwriteApproval>())
			.execute("tool-progress", { sourceFilePath: "large.bin", targetPath: "/remote" }, undefined, (update) =>
				updates.push(update.details),
			);

		const progress = updates.filter((update) => update.status === "uploading");
		expect(progress[0]).toMatchObject({ bytesTransferred: 0, progressPercent: 0 });
		expect(progress.some((update) => (update.progressPercent ?? 0) > 0 && (update.progressPercent ?? 0) < 100)).toBe(
			true,
		);
		expect(progress.at(-1)).toMatchObject({ bytesTransferred: 700 * 1024, progressPercent: 100 });
	});
});

async function createFixture(
	fileName: string,
	content: Uint8Array,
): Promise<{
	directory: string;
	broker: FakeSftpBroker;
	tool(approval: RequestSftpOverwriteApproval): ReturnType<typeof createSftpUploadTool>;
}> {
	const directory = await mkdtemp(join(tmpdir(), "sftp-upload-tool-"));
	temporaryDirectories.push(directory);
	await writeFile(join(directory, fileName), content);
	const broker = new FakeSftpBroker();
	const env = new NodeExecutionEnv({ cwd: directory });
	const targets: SshTargetResolver = { resolve: async () => target };
	return {
		directory,
		broker,
		tool: (requestOverwriteApproval) =>
			createSftpUploadTool({
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
