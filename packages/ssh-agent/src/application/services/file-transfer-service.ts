import {
	type CreateFileTransferInput,
	type FileTransfer,
	FileTransferError,
	type SftpDirectoryEntry,
	type TransferStatus,
} from "../../domain/file-transfer.ts";
import type { Clock, IdGenerator } from "../../domain/ids.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import { descriptorForPublicCode } from "../../i18n/public-error.ts";
import type { FileTransferRepository } from "../repositories/file-transfer-repository.ts";
import type { SftpFileBroker, SshConnectionPoolControl } from "../ssh-channel-broker.ts";
import type { WorkspaceEventHub } from "../workspace-event-hub.ts";
import type { WorkspaceSshTargetResolver } from "./ssh-target-resolver.ts";

const TERMINAL_STATUSES: readonly TransferStatus[] = ["completed", "failed", "cancelled", "uncertain"];

interface ActiveTransfer {
	controller: AbortController;
	settled: Promise<FileTransfer>;
	resolve(transfer: FileTransfer): void;
}

export class FileTransferService {
	private readonly active = new Map<string, ActiveTransfer>();
	private readonly recovery: Promise<void>;
	private readonly options: {
		transfers: FileTransferRepository;
		targets: WorkspaceSshTargetResolver;
		broker: SftpFileBroker & Pick<SshConnectionPoolControl, "snapshotWorkspace">;
		events: WorkspaceEventHub;
		clock: Clock;
		ids: IdGenerator;
	};

	constructor(options: {
		transfers: FileTransferRepository;
		targets: WorkspaceSshTargetResolver;
		broker: SftpFileBroker & Pick<SshConnectionPoolControl, "snapshotWorkspace">;
		events: WorkspaceEventHub;
		clock: Clock;
		ids: IdGenerator;
	}) {
		this.options = options;
		this.recovery = this.recover();
	}

	async listDirectory(
		workspaceId: string,
		path?: string,
	): Promise<{ workspaceId: string; path: string; entries: SftpDirectoryEntry[] }> {
		await this.recovery;
		const target = await this.options.targets.resolveWorkspace(workspaceId);
		const remotePath = path ?? target.defaultCwd;
		if (!remotePath.startsWith("/"))
			throw new FileTransferError("not_a_directory", "Remote directory path must be absolute", 400);
		try {
			const result = await this.options.broker.listDirectory({
				target,
				remotePath,
				signal: new AbortController().signal,
			});
			return { workspaceId, ...result };
		} finally {
			this.publishConnection(workspaceId);
		}
	}

	async deleteFile(workspaceId: string, remotePath: string): Promise<void> {
		await this.recovery;
		validatePath(remotePath);
		const target = await this.options.targets.resolveWorkspace(workspaceId);
		try {
			await this.options.broker.deleteFile({ target, remotePath, signal: new AbortController().signal });
		} finally {
			this.publishConnection(workspaceId);
		}
	}

	async create(workspaceId: string, input: CreateFileTransferInput): Promise<FileTransfer> {
		await this.recovery;
		validatePath(input.remotePath);
		const target = await this.options.targets.resolveWorkspace(workspaceId);
		const entry = await this.statOptional(target, input.remotePath);
		if (input.direction === "upload") {
			if (entry && !input.overwrite)
				throw new FileTransferError("file_already_exists", "A file already exists at the remote path", 409, {
					entry,
				});
			if (entry && entry.type !== "file")
				throw new FileTransferError("unsupported_file_type", "Only regular files can be overwritten", 409);
		} else {
			if (!entry) throw new FileTransferError("file_not_found", "The remote file does not exist", 404);
			if (entry.type === "directory")
				throw new FileTransferError("cannot_download_directory", "Directories cannot be downloaded", 409);
			if (entry.type !== "file")
				throw new FileTransferError("unsupported_file_type", "Only regular files can be downloaded", 409);
		}
		const now = this.options.clock.now();
		const transfer: FileTransfer = {
			id: this.options.ids.next(),
			workspaceId,
			direction: input.direction,
			remotePath: input.remotePath,
			fileName: basename(input.remotePath),
			totalBytes: input.direction === "upload" ? input.totalBytes : (entry?.size ?? 0),
			bytesTransferred: 0,
			overwrite: input.direction === "upload" ? (input.overwrite ?? false) : false,
			status: "pending",
			target,
			createdAt: now,
			updatedAt: now,
		};
		await this.options.transfers.insert(transfer);
		this.publish(transfer);
		return transfer;
	}

	async list(workspaceId: string, limit: number): Promise<{ transfers: FileTransfer[] }> {
		await this.recovery;
		return {
			transfers: await this.options.transfers.listByWorkspaceId(workspaceId, Math.min(100, Math.max(1, limit))),
		};
	}

	async get(workspaceId: string, transferId: string): Promise<FileTransfer> {
		await this.recovery;
		return await this.getOwned(workspaceId, transferId);
	}

	async upload(
		workspaceId: string,
		transferId: string,
		data: AsyncIterable<Uint8Array>,
		signal: AbortSignal,
	): Promise<FileTransfer> {
		const transfer = await this.claim(workspaceId, transferId, "upload");
		const controller = linkedAbortController(signal);
		const active = activeTransfer(controller);
		this.active.set(transfer.id, active);
		let observedBytes = 0;
		const counted = countBytes(data, (size) => {
			observedBytes = size;
			if (size > transfer.totalBytes)
				throw new FileTransferError("transfer_size_mismatch", "Uploaded bytes exceed the declared file size", 400);
		});
		try {
			const result = await this.options.broker.upload({
				target: transfer.target,
				remotePath: transfer.remotePath,
				data: counted,
				signal: active.controller.signal,
				overwrite: transfer.overwrite,
				onProgress: (bytes) => this.progress(transfer, bytes),
			});
			if (observedBytes !== transfer.totalBytes || result.bytesTransferred !== transfer.totalBytes)
				throw new FileTransferError(
					"transfer_size_mismatch",
					"Uploaded bytes do not match the declared file size",
					400,
				);
			return await this.finish(transfer, "completed", result.bytesTransferred);
		} catch (error) {
			return await this.fail(transfer, error);
		} finally {
			this.active.delete(transfer.id);
			active.resolve(await this.getOwned(workspaceId, transfer.id));
		}
	}

	async download(
		workspaceId: string,
		transferId: string,
		signal: AbortSignal,
		onData: (chunk: Uint8Array) => Promise<void>,
	): Promise<FileTransfer> {
		const transfer = await this.claim(workspaceId, transferId, "download");
		const controller = linkedAbortController(signal);
		const active = activeTransfer(controller);
		this.active.set(transfer.id, active);
		try {
			const result = await this.options.broker.download({
				target: transfer.target,
				remotePath: transfer.remotePath,
				signal: active.controller.signal,
				onData,
				onProgress: (bytes) => this.progress(transfer, bytes),
			});
			if (result.bytesTransferred !== transfer.totalBytes)
				throw new FileTransferError(
					"transfer_size_mismatch",
					"Downloaded bytes do not match the remote file size",
					502,
				);
			return await this.finish(transfer, "completed", result.bytesTransferred);
		} catch (error) {
			return await this.fail(transfer, error);
		} finally {
			this.active.delete(transfer.id);
			active.resolve(await this.getOwned(workspaceId, transfer.id));
		}
	}

	async cancel(workspaceId: string, transferId: string): Promise<FileTransfer> {
		await this.recovery;
		const transfer = await this.getOwned(workspaceId, transferId);
		if (TERMINAL_STATUSES.includes(transfer.status)) return transfer;
		const active = this.active.get(transfer.id);
		if (active) {
			active.controller.abort(new FileTransferError("transfer_cancelled", "File transfer was cancelled", 409));
			return await active.settled;
		}
		return await this.finish(transfer, "cancelled", transfer.bytesTransferred, {
			code: "transfer_cancelled",
			message: "File transfer was cancelled",
			retryable: false,
		});
	}

	private async claim(
		workspaceId: string,
		transferId: string,
		direction: FileTransfer["direction"],
	): Promise<FileTransfer> {
		await this.recovery;
		const transfer = await this.getOwned(workspaceId, transferId);
		if (transfer.direction !== direction)
			throw new FileTransferError(
				"transfer_direction_mismatch",
				"Transfer direction does not match this endpoint",
				409,
			);
		if (transfer.status !== "pending")
			throw new FileTransferError("transfer_invalid_state", "Transfer is not pending", 409);
		const running = {
			...transfer,
			status: "running" as const,
			startedAt: this.options.clock.now(),
			updatedAt: this.options.clock.now(),
		};
		if (!(await this.options.transfers.update(running, ["pending"])))
			throw new FileTransferError("transfer_invalid_state", "Transfer is no longer pending", 409);
		this.publish(running);
		return running;
	}

	private async progress(transfer: FileTransfer, bytes: number): Promise<void> {
		const now = this.options.clock.now();
		if (
			bytes < transfer.totalBytes &&
			bytes - transfer.bytesTransferred < 256 * 1024 &&
			now - transfer.updatedAt < 200
		)
			return;
		transfer.bytesTransferred = bytes;
		transfer.updatedAt = now;
		await this.options.transfers.update(transfer, ["running"]);
		this.publish(transfer);
	}

	private async finish(
		transfer: FileTransfer,
		status: TransferStatus,
		bytes: number,
		failure?: FileTransfer["failure"],
	): Promise<FileTransfer> {
		const now = this.options.clock.now();
		const persistedFailure = failure === undefined ? undefined : addFailureDescriptor(failure);
		const finished: FileTransfer = {
			...transfer,
			status,
			bytesTransferred: bytes,
			updatedAt: now,
			finishedAt: now,
			...(persistedFailure === undefined ? {} : { failure: persistedFailure }),
		};
		if (!(await this.options.transfers.update(finished, ["pending", "running"]))) {
			return await this.getOwned(transfer.workspaceId, transfer.id);
		}
		this.publish(finished);
		return finished;
	}

	private async fail(transfer: FileTransfer, error: unknown): Promise<never> {
		const uncertain = error instanceof SshAgentError && error.failure.code === "upload_result_uncertain";
		const cancelled =
			(error instanceof FileTransferError && error.code === "transfer_cancelled") ||
			(error instanceof SshAgentError && error.failure.code === "upload_cancelled");
		const failure = failureFrom(
			error,
			uncertain ? "transfer_result_uncertain" : cancelled ? "transfer_cancelled" : "sftp_operation_failed",
		);
		await this.finish(
			transfer,
			uncertain ? "uncertain" : cancelled ? "cancelled" : "failed",
			transfer.bytesTransferred,
			failure,
		);
		throw error;
	}

	private async getOwned(workspaceId: string, id: string): Promise<FileTransfer> {
		const transfer = await this.options.transfers.findById(id);
		if (!transfer || transfer.workspaceId !== workspaceId)
			throw new FileTransferError("transfer_not_found", "File transfer was not found", 404);
		return transfer;
	}

	private async statOptional(target: FileTransfer["target"], path: string): Promise<SftpDirectoryEntry | undefined> {
		try {
			return await this.options.broker.stat({ target, remotePath: path, signal: new AbortController().signal });
		} catch (error) {
			if (error instanceof FileTransferError && error.code === "file_not_found") return undefined;
			throw error;
		}
	}

	private publish(transfer: FileTransfer): void {
		this.options.events.publish(transfer.workspaceId, { type: "transfer.updated", data: { ...transfer } });
		this.publishConnection(transfer.workspaceId);
	}

	private publishConnection(workspaceId: string): void {
		this.options.events.publish(workspaceId, {
			type: "connection.snapshot",
			data: this.options.broker.snapshotWorkspace(workspaceId),
		});
	}

	private async recover(): Promise<void> {
		for (const transfer of await this.options.transfers.listByStatuses(["pending", "running"])) {
			await this.finish(transfer, "failed", transfer.bytesTransferred, {
				code: "transfer_interrupted",
				message: "File transfer was interrupted by a service restart",
				retryable: true,
			});
		}
	}
}

function addFailureDescriptor(failure: NonNullable<FileTransfer["failure"]>): NonNullable<FileTransfer["failure"]> {
	if (failure.messageKey !== undefined) return failure;
	const descriptor = descriptorForPublicCode(failure.code);
	return descriptor === undefined
		? failure
		: {
				...failure,
				messageKey: descriptor.key,
				...(descriptor.values === undefined ? {} : { messageValues: descriptor.values }),
			};
}

function validatePath(path: string): void {
	if (!path.startsWith("/") || path.endsWith("/"))
		throw new FileTransferError(
			"sftp_operation_failed",
			"Remote file path must be absolute and identify a file",
			400,
		);
}
function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
function linkedAbortController(signal: AbortSignal): AbortController {
	const controller = new AbortController();
	if (signal.aborted) controller.abort(signal.reason);
	else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
	return controller;
}
function activeTransfer(controller: AbortController): ActiveTransfer {
	let resolve = (_transfer: FileTransfer): void => {};
	const settled = new Promise<FileTransfer>((settle) => {
		resolve = settle;
	});
	return { controller, settled, resolve };
}
async function* countBytes(
	data: AsyncIterable<Uint8Array>,
	observe: (bytes: number) => void,
): AsyncIterable<Uint8Array> {
	let bytes = 0;
	for await (const chunk of data) {
		bytes += chunk.byteLength;
		observe(bytes);
		yield chunk;
	}
}
function failureFrom(error: unknown, fallbackCode: string): NonNullable<FileTransfer["failure"]> {
	const failure =
		error instanceof SshAgentError
			? { code: error.failure.code, message: error.failure.message, retryable: error.failure.retryable }
			: error instanceof FileTransferError
				? { code: error.code, message: error.message, retryable: error.status >= 500 }
				: { code: fallbackCode, message: "File transfer failed", retryable: false };
	const descriptor = descriptorForPublicCode(failure.code);
	return descriptor === undefined
		? failure
		: {
				...failure,
				messageKey: descriptor.key,
				...(descriptor.values === undefined ? {} : { messageValues: descriptor.values }),
			};
}
