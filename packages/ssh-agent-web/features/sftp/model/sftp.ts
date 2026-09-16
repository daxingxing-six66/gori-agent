export type TransferStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "uncertain";
export type WorkspaceEventStreamState = "connecting" | "connected" | "reconnecting" | "closed";

export interface MonitorError {
	sampledAt: number;
	code: string;
	message: string;
}

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
	direction: "upload" | "download";
	remotePath: string;
	fileName: string;
	totalBytes: number;
	bytesTransferred: number;
	overwrite: boolean;
	status: TransferStatus;
	failure?: { code: string; message: string; retryable: boolean };
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	updatedAt: number;
}

export type UploadTaskPhase = "creating" | "uploading" | "cancelling" | "idle";

export interface UploadTask {
	clientId: string;
	file: File;
	remotePath: string;
	overwrite: boolean;
	browserBytes: number;
	phase: UploadTaskPhase;
	transfer?: FileTransfer;
	error?: string;
}

export type StartUploadResult =
	| { status: "completed" | "failed" | "duplicate"; taskId: string }
	| { status: "conflict"; taskId: string; entry?: SftpDirectoryEntry };

export interface ConnectionPoolSnapshot {
	workspaceId: string;
	state: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
	activeChannels: number;
	waitingChannels: number;
	generation: number;
	connectedAt?: number;
	lastError?: { code: string; message: string };
}

export interface RemoteMetricsSnapshot {
	workspaceId: string;
	sampledAt: number;
	cpu: { usagePercent: number; cores: number; loadAverage: [number, number, number] };
	memory: { usedBytes: number; totalBytes: number; usagePercent: number };
	filesystems: Array<{ device: string; mountPoint: string; usedBytes: number; totalBytes: number; usagePercent: number }>;
	uptimeSeconds: number;
	processes: Array<{ pid: number; parentPid: number; user: string; state: string; cpuPercent: number; memoryPercent: number; residentBytes: number; elapsedSeconds: number; command: string }>;
}
