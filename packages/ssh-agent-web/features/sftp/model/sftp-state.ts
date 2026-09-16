import type {
	FileTransfer,
	MonitorError,
	RemoteMetricsSnapshot,
	UploadTask,
	WorkspaceEventStreamState,
} from "./sftp.ts";

export interface MonitoringState {
	snapshot?: RemoteMetricsSnapshot;
	error?: MonitorError;
}

export type WorkspaceEventStreamAction = "open" | "error" | "ready" | "close";

export function nextWorkspaceEventStreamState(
	current: WorkspaceEventStreamState,
	action: WorkspaceEventStreamAction,
): WorkspaceEventStreamState {
	if (action === "close") return "closed";
	if (action === "error") return "reconnecting";
	if (action === "open" || action === "ready") return "connected";
	return current;
}

export function applyMonitorSnapshot(
	_state: MonitoringState,
	snapshot: RemoteMetricsSnapshot,
): MonitoringState {
	return { snapshot };
}

export function applyMonitorError(state: MonitoringState, error: MonitorError): MonitoringState {
	return { ...state, error };
}

export function isAbsoluteRemotePath(path: string): boolean {
	return path.startsWith("/");
}

export function initialSftpDirectory(defaultCwd: string): { path: string; requiresRootFallback: boolean } {
	return isAbsoluteRemotePath(defaultCwd)
		? { path: defaultCwd, requiresRootFallback: false }
		: { path: "/", requiresRootFallback: true };
}

export function isTransferActive(transfer: FileTransfer): boolean {
	return transfer.status === "pending" || transfer.status === "running";
}

export function isUploadTaskActive(task: UploadTask): boolean {
	return task.phase === "creating" || task.phase === "uploading" || task.phase === "cancelling"
		|| (task.transfer !== undefined && isTransferActive(task.transfer));
}

export function canRetryTransfer(transfer: FileTransfer): boolean {
	if (transfer.status === "uncertain") return false;
	if (transfer.status === "cancelled") return true;
	return transfer.status === "failed" && transfer.failure?.retryable === true;
}
