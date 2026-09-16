import type { FileTransfer, TransferStatus } from "../../domain/file-transfer.ts";

export interface FileTransferRepository {
	insert(transfer: FileTransfer): Promise<void>;
	findById(id: string): Promise<FileTransfer | undefined>;
	listByWorkspaceId(workspaceId: string, limit: number): Promise<FileTransfer[]>;
	listByStatuses(statuses: readonly TransferStatus[]): Promise<FileTransfer[]>;
	update(transfer: FileTransfer, expectedStatuses: readonly TransferStatus[]): Promise<boolean>;
}
