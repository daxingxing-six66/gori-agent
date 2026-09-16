import { describe, expect, it } from "vitest";
import type { FileTransferRepository } from "../src/application/repositories/file-transfer-repository.ts";
import { FileTransferService } from "../src/application/services/file-transfer-service.ts";
import type { WorkspaceSshTargetResolver } from "../src/application/services/ssh-target-resolver.ts";
import type { SshChannelBroker } from "../src/application/ssh-channel-broker.ts";
import { WorkspaceEventHub } from "../src/application/workspace-event-hub.ts";
import { type FileTransfer, FileTransferError, type TransferStatus } from "../src/domain/file-transfer.ts";
import { SshAgentError } from "../src/domain/ssh-failure.ts";
import type { SshTargetSnapshot } from "../src/domain/ssh-target.ts";

const target: SshTargetSnapshot = {
	workspaceId: "ws-1",
	workspaceRevision: 1,
	hostname: "server",
	port: 22,
	hostKeyAlgorithm: "ssh-ed25519",
	hostKeyFingerprint: "SHA256:test",
	credentialId: "cred-1",
	credentialAuthVersion: 1,
	remoteUser: "root",
	defaultCwd: "/srv",
	connectTimeoutMs: 1_000,
	keepaliveIntervalMs: 1_000,
	keepaliveMaxCount: 3,
};

class MemoryTransfers implements FileTransferRepository {
	readonly items = new Map<string, FileTransfer>();
	readonly observedStatuses: TransferStatus[] = [];
	async insert(transfer: FileTransfer): Promise<void> {
		this.items.set(transfer.id, structuredClone(transfer));
		this.observedStatuses.push(transfer.status);
	}
	async findById(id: string): Promise<FileTransfer | undefined> {
		const value = this.items.get(id);
		return value && structuredClone(value);
	}
	async listByWorkspaceId(workspaceId: string, limit: number): Promise<FileTransfer[]> {
		return [...this.items.values()]
			.filter((item) => item.workspaceId === workspaceId)
			.slice(0, limit)
			.map((item) => structuredClone(item));
	}
	async listByStatuses(statuses: readonly TransferStatus[]): Promise<FileTransfer[]> {
		return [...this.items.values()]
			.filter((item) => statuses.includes(item.status))
			.map((item) => structuredClone(item));
	}
	async update(transfer: FileTransfer, expected: readonly TransferStatus[]): Promise<boolean> {
		const current = this.items.get(transfer.id);
		if (!current || !expected.includes(current.status)) return false;
		this.items.set(transfer.id, structuredClone(transfer));
		this.observedStatuses.push(transfer.status);
		return true;
	}
}

class FakeBroker implements SshChannelBroker {
	private readonly uncertainOnAbort: boolean;
	readonly started: Promise<void>;
	private markStarted: () => void = () => {};

	constructor(uncertainOnAbort = false) {
		this.uncertainOnAbort = uncertainOnAbort;
		this.started = new Promise((resolve) => {
			this.markStarted = resolve;
		});
	}
	async execute(): Promise<{ exitCode: number }> {
		return { exitCode: 0 };
	}
	async listDirectory(): Promise<{ path: string; entries: [] }> {
		return { path: "/srv", entries: [] };
	}
	async stat(input: Parameters<SshChannelBroker["stat"]>[0]) {
		if (input.remotePath.endsWith("new.bin")) throw new FileTransferError("file_not_found", "missing", 404);
		return {
			name: input.remotePath.split("/").at(-1) ?? "",
			path: input.remotePath,
			type: "file" as const,
			size: 4,
			modifiedAt: 1,
			permissions: 420,
		};
	}
	async upload(input: Parameters<SshChannelBroker["upload"]>[0]) {
		this.markStarted();
		if (this.uncertainOnAbort) {
			await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
			throw new SshAgentError({
				code: "upload_result_uncertain",
				category: "execution",
				phase: "commit",
				message: "uncertain",
				retryable: false,
			});
		}
		let bytes = 0;
		for await (const chunk of input.data) {
			bytes += chunk.byteLength;
			await input.onProgress(bytes);
		}
		return { bytesTransferred: bytes };
	}
	async download(): Promise<{ bytesTransferred: number }> {
		return { bytesTransferred: 4 };
	}
	async deleteFile(): Promise<void> {}
	snapshotWorkspace(workspaceId: string) {
		return { workspaceId, state: "idle" as const, activeChannels: 0, waitingChannels: 0, generation: 0 };
	}
	invalidateWorkspace(): void {}
	invalidateCredential(): void {}
	close(): void {}
}

describe("FileTransferService", () => {
	it("persists only pending, running, and completed during a successful upload", async () => {
		const repository = new MemoryTransfers();
		const service = createService(repository);
		const transfer = await service.create("ws-1", { direction: "upload", remotePath: "/srv/new.bin", totalBytes: 4 });
		async function* content() {
			yield new Uint8Array([1, 2]);
			yield new Uint8Array([3, 4]);
		}
		await expect(service.upload("ws-1", transfer.id, content(), new AbortController().signal)).resolves.toMatchObject(
			{ status: "completed", bytesTransferred: 4 },
		);
		expect(repository.observedStatuses).toEqual(["pending", "running", "running", "completed"]);
		expect(repository.observedStatuses).not.toContain("queued");
	});

	it("marks pending and running transfers failed after service restart", async () => {
		const repository = new MemoryTransfers();
		repository.items.set("pending", existing("pending"));
		repository.items.set("running", existing("running"));
		const service = createService(repository);
		const result = await service.list("ws-1", 50);
		expect(result.transfers).toHaveLength(2);
		for (const transfer of result.transfers)
			expect(transfer).toMatchObject({
				status: "failed",
				failure: { code: "transfer_interrupted", retryable: true },
			});
	});

	it("returns uncertain when cancellation happens after rename was sent", async () => {
		const repository = new MemoryTransfers();
		const broker = new FakeBroker(true);
		const service = createService(repository, broker);
		const transfer = await service.create("ws-1", { direction: "upload", remotePath: "/srv/new.bin", totalBytes: 0 });
		async function* content() {}
		const execution = service.upload("ws-1", transfer.id, content(), new AbortController().signal);
		const executionResult = expect(execution).rejects.toMatchObject({ failure: { code: "upload_result_uncertain" } });
		await broker.started;
		await expect(service.cancel("ws-1", transfer.id)).resolves.toMatchObject({ status: "uncertain" });
		await executionResult;
	});
});

function createService(
	transfers: FileTransferRepository,
	broker: SshChannelBroker = new FakeBroker(),
): FileTransferService {
	let id = 0;
	const targets: WorkspaceSshTargetResolver = { resolveWorkspace: async () => target };
	return new FileTransferService({
		transfers,
		targets,
		broker,
		events: new WorkspaceEventHub(),
		clock: { now: () => ++id },
		ids: { next: () => `transfer-${id}` },
	});
}

function existing(status: "pending" | "running"): FileTransfer {
	return {
		id: status,
		workspaceId: "ws-1",
		direction: "upload",
		remotePath: `/srv/${status}`,
		fileName: status,
		totalBytes: 4,
		bytesTransferred: status === "running" ? 2 : 0,
		overwrite: false,
		status,
		target,
		createdAt: 1,
		updatedAt: 1,
	};
}
