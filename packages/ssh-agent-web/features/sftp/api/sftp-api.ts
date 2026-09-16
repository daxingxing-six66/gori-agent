import { apiRequest, apiUrl } from "@/shared/api/client";
import { ApiError } from "@/shared/errors/api-error";
import type { FileTransfer, SftpDirectoryEntry } from "../model/sftp";

function base(workspaceId: string): string {
	return `/api/workspaces/${encodeURIComponent(workspaceId)}/sftp`;
}

export const sftpApi = {
	listDirectory: (workspaceId: string, path?: string) => apiRequest<{ workspaceId: string; path: string; entries: SftpDirectoryEntry[] }>(`${base(workspaceId)}/entries${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`),
	listTransfers: (workspaceId: string) => apiRequest<{ transfers: FileTransfer[] }>(`${base(workspaceId)}/transfers?limit=50`),
	createUpload: (workspaceId: string, remotePath: string, totalBytes: number, overwrite: boolean) => apiRequest<FileTransfer>(`${base(workspaceId)}/transfers`, { method: "POST", body: { direction: "upload", remotePath, totalBytes, overwrite } }),
	createDownload: (workspaceId: string, remotePath: string) => apiRequest<FileTransfer>(`${base(workspaceId)}/transfers`, { method: "POST", body: { direction: "download", remotePath } }),
	deleteFile: (workspaceId: string, path: string) => apiRequest<void>(`${base(workspaceId)}/file?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
	cancel: (workspaceId: string, transferId: string) => apiRequest<FileTransfer>(`${base(workspaceId)}/transfers/${encodeURIComponent(transferId)}/cancel`, { method: "POST" }),
	downloadUrl: (workspaceId: string, transferId: string) => apiUrl(`${base(workspaceId)}/transfers/${encodeURIComponent(transferId)}/content`),
	uploadContent(
		workspaceId: string,
		transfer: FileTransfer,
		file: File,
		signal: AbortSignal,
		onProgress: (sentBytes: number) => void,
	): Promise<FileTransfer> {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			let settled = false;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", abort);
				callback();
			};
			const abort = () => xhr.abort();
			xhr.open("PUT", apiUrl(`${base(workspaceId)}/transfers/${encodeURIComponent(transfer.id)}/content`));
			xhr.setRequestHeader("content-type", "application/octet-stream");
			xhr.responseType = "json";
			xhr.upload.onprogress = (event) => onProgress(event.loaded);
			xhr.onerror = () => finish(() => reject(new ApiError(0, "network_error", "")));
			xhr.onabort = () => finish(() => reject(new ApiError(0, "transfer_cancelled", "")));
			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) finish(() => resolve(xhr.response as FileTransfer));
				else {
					const payload = xhr.response as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null;
					finish(() => reject(new ApiError(xhr.status, payload?.error?.code ?? "internal_error", payload?.error?.message ?? `Request failed with HTTP ${xhr.status}`, undefined, payload?.error?.details)));
				}
			};
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) {
				abort();
				return;
			}
			xhr.send(file);
		});
	},
};
