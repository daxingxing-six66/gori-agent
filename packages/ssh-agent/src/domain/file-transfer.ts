import type { BackendMessageKey, BackendMessageValues } from "../i18n/message.ts";
import type { SshTargetSnapshot } from "./ssh-target.ts";

export type TransferDirection = "upload" | "download";
export type TransferStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "uncertain";

export interface SftpDirectoryEntry {
	name: string;
	path: string;
	type: "file" | "directory" | "symlink" | "other";
	size: number;
	modifiedAt: number;
	permissions: number;
}

export interface FileTransfer {
	id: string;
	workspaceId: string;
	direction: TransferDirection;
	remotePath: string;
	fileName: string;
	totalBytes: number;
	bytesTransferred: number;
	overwrite: boolean;
	status: TransferStatus;
	target: SshTargetSnapshot;
	failure?: {
		code: string;
		message: string;
		messageKey?: BackendMessageKey;
		messageValues?: BackendMessageValues;
		retryable: boolean;
	};
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	updatedAt: number;
}

export interface CreateUploadTransferInput {
	direction: "upload";
	remotePath: string;
	totalBytes: number;
	overwrite?: boolean;
}

export interface CreateDownloadTransferInput {
	direction: "download";
	remotePath: string;
}

export type CreateFileTransferInput = CreateUploadTransferInput | CreateDownloadTransferInput;

export type FileTransferErrorCode =
	| "file_already_exists"
	| "file_not_found"
	| "not_a_directory"
	| "cannot_download_directory"
	| "cannot_delete_directory"
	| "unsupported_file_type"
	| "atomic_overwrite_unsupported"
	| "transfer_not_found"
	| "transfer_direction_mismatch"
	| "transfer_invalid_state"
	| "transfer_size_mismatch"
	| "transfer_cancelled"
	| "transfer_queue_full"
	| "transfer_interrupted"
	| "transfer_result_uncertain"
	| "sftp_permission_denied"
	| "sftp_operation_failed";

export class FileTransferError extends Error {
	readonly code: FileTransferErrorCode;
	readonly status: number;
	readonly details?: Record<string, unknown>;

	constructor(code: FileTransferErrorCode, message: string, status: number, details?: Record<string, unknown>) {
		super(message);
		this.name = "FileTransferError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}
