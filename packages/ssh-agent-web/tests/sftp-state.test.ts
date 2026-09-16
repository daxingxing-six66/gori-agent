import { describe, expect, it } from "vitest";
import {
	applyMonitorError,
	applyMonitorSnapshot,
	canRetryTransfer,
	initialSftpDirectory,
	isAbsoluteRemotePath,
	isUploadTaskActive,
	nextWorkspaceEventStreamState,
} from "../features/sftp/model/sftp-state.ts";
import type { FileTransfer, RemoteMetricsSnapshot, UploadTask } from "../features/sftp/model/sftp.ts";
import { DEFAULT_WORKSPACE_CWD } from "../features/workspace/model/workspace.ts";

const snapshot: RemoteMetricsSnapshot = {
	workspaceId: "ws-1",
	sampledAt: 10,
	cpu: { usagePercent: 20, cores: 4, loadAverage: [0.5, 0.4, 0.3] },
	memory: { usedBytes: 5, totalBytes: 10, usagePercent: 50 },
	filesystems: [],
	uptimeSeconds: 100,
	processes: [],
};

function transfer(status: FileTransfer["status"], retryable = false): FileTransfer {
	return {
		id: `transfer-${status}`,
		workspaceId: "ws-1",
		direction: "upload",
		remotePath: "/tmp/file",
		fileName: "file",
		totalBytes: 10,
		bytesTransferred: 0,
		overwrite: false,
		status,
		...(status === "failed" ? { failure: { code: "failed", message: "failed", retryable } } : {}),
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("SFTP frontend state", () => {
	it("uses an absolute root for new workspaces and requires fallback for existing tilde paths", () => {
		expect(DEFAULT_WORKSPACE_CWD).toBe("/");
		expect(isAbsoluteRemotePath("/srv/app")).toBe(true);
		expect(isAbsoluteRemotePath("~")).toBe(false);
		expect(initialSftpDirectory("/srv/app")).toEqual({ path: "/srv/app", requiresRootFallback: false });
		expect(initialSftpDirectory("~")).toEqual({ path: "/", requiresRootFallback: true });
	});

	it("tracks initial connection, reconnect, recovery, and close states", () => {
		let state = nextWorkspaceEventStreamState("connecting", "open");
		expect(state).toBe("connected");
		state = nextWorkspaceEventStreamState(state, "error");
		expect(state).toBe("reconnecting");
		state = nextWorkspaceEventStreamState(state, "ready");
		expect(state).toBe("connected");
		expect(nextWorkspaceEventStreamState(state, "close")).toBe("closed");
	});

	it("preserves the last metrics snapshot on failure and clears the error on recovery", () => {
		let state = applyMonitorSnapshot({}, snapshot);
		state = applyMonitorError(state, { sampledAt: 20, code: "monitor_probe_failed", message: "failed" });
		expect(state).toEqual({ snapshot, error: { sampledAt: 20, code: "monitor_probe_failed", message: "failed" } });
		expect(applyMonitorSnapshot(state, { ...snapshot, sampledAt: 30 })).toEqual({ snapshot: { ...snapshot, sampledAt: 30 } });
	});

	it("only offers automatic retry for cancelled or explicitly retryable failures", () => {
		expect(canRetryTransfer(transfer("failed", true))).toBe(true);
		expect(canRetryTransfer(transfer("failed", false))).toBe(false);
		expect(canRetryTransfer(transfer("cancelled"))).toBe(true);
		expect(canRetryTransfer(transfer("uncertain"))).toBe(false);
	});

	it("derives active upload state from the browser phase or server transfer", () => {
		const task: UploadTask = {
			clientId: "task-1",
			file: {} as File,
			remotePath: "/tmp/file",
			overwrite: false,
			browserBytes: 0,
			phase: "creating",
		};
		expect(isUploadTaskActive(task)).toBe(true);
		expect(isUploadTaskActive({ ...task, phase: "idle" })).toBe(false);
		expect(isUploadTaskActive({ ...task, phase: "idle", transfer: transfer("running") })).toBe(true);
		expect(isUploadTaskActive({ ...task, phase: "idle", transfer: transfer("completed") })).toBe(false);
	});
});
