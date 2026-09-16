"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { sftpApi } from "../api/sftp-api";
import { canRetryTransfer, isTransferActive, isUploadTaskActive } from "../model/sftp-state";
import type { FileTransfer, SftpDirectoryEntry, StartUploadResult, UploadTask } from "../model/sftp";
import { ApiError } from "@/shared/errors/api-error";

interface SftpTransferManagerValue {
	tasks: UploadTask[];
	activeUploadCount: number;
	completedVersion: number;
	startUpload(file: File, remotePath: string): Promise<StartUploadResult>;
	confirmOverwrite(taskId: string): Promise<void>;
	retryUpload(taskId: string): Promise<void>;
	cancelUpload(taskId: string): Promise<void>;
	dismissTask(taskId: string): void;
	syncTransfer(transfer: FileTransfer): void;
	confirmNavigation(): boolean;
}

const SftpTransferManagerContext = createContext<SftpTransferManagerValue | null>(null);

export function SftpTransferProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const [tasks, setTasks] = useState<UploadTask[]>([]);
	const [completedVersion, setCompletedVersion] = useState(0);
	const tasksRef = useRef(tasks);
	const controllers = useRef(new Map<string, AbortController>());

	const replaceTasks = useCallback((update: (current: UploadTask[]) => UploadTask[]) => {
		const next = update(tasksRef.current);
		tasksRef.current = next;
		setTasks(next);
	}, []);

	const updateTask = useCallback((taskId: string, update: (task: UploadTask) => UploadTask) => {
		replaceTasks((current) => current.map((task) => task.clientId === taskId ? update(task) : task));
	}, [replaceTasks]);

	const syncTransfer = useCallback((transfer: FileTransfer) => {
		let becameCompleted = false;
		replaceTasks((current) => current.map((task) => {
			if (task.transfer?.id !== transfer.id) return task;
			becameCompleted = task.transfer.status !== "completed" && transfer.status === "completed";
			return {
				...task,
				transfer,
				phase: isTransferActive(transfer) ? task.phase : "idle",
				...(transfer.status === "failed" && transfer.failure ? { error: transfer.failure.message } : {}),
			};
		}));
		if (becameCompleted) setCompletedVersion((version) => version + 1);
	}, [replaceTasks]);

	const runUpload = useCallback(async (taskId: string, overwrite: boolean): Promise<StartUploadResult> => {
		const task = tasksRef.current.find((item) => item.clientId === taskId);
		if (!task) return { status: "failed", taskId };
		updateTask(taskId, (current) => ({
			...current,
			overwrite,
			phase: "creating",
			browserBytes: 0,
			transfer: undefined,
			error: undefined,
		}));
		let transfer: FileTransfer;
		try {
			transfer = await sftpApi.createUpload(workspaceId, task.remotePath, task.file.size, overwrite);
		} catch (requestError) {
			const conflict = requestError instanceof ApiError && requestError.code === "file_already_exists";
			updateTask(taskId, (current) => ({ ...current, phase: "idle", error: localizedErrorMessage(requestError) }));
			if (conflict) {
				return {
					status: "conflict",
					taskId,
					entry: requestError.details?.entry as SftpDirectoryEntry | undefined,
				};
			}
			return { status: "failed", taskId };
		}

		const controller = new AbortController();
		controllers.current.set(taskId, controller);
		updateTask(taskId, (current) => ({ ...current, transfer, phase: "uploading", error: undefined }));
		try {
			const completed = await sftpApi.uploadContent(
				workspaceId,
				transfer,
				task.file,
				controller.signal,
				(browserBytes) => updateTask(taskId, (current) => ({ ...current, browserBytes })),
			);
			let becameCompleted = false;
			updateTask(taskId, (current) => {
				becameCompleted = current.transfer?.status !== "completed" && completed.status === "completed";
				return { ...current, transfer: completed, phase: "idle", error: undefined };
			});
			if (becameCompleted) setCompletedVersion((version) => version + 1);
			return { status: "completed", taskId };
		} catch (requestError) {
			if (!(requestError instanceof ApiError) || requestError.code !== "transfer_cancelled") {
				updateTask(taskId, (current) => ({ ...current, phase: "idle", error: localizedErrorMessage(requestError) }));
			}
			return { status: "failed", taskId };
		} finally {
			controllers.current.delete(taskId);
		}
	}, [localizedErrorMessage, updateTask, workspaceId]);

	const startUpload = useCallback(async (file: File, remotePath: string): Promise<StartUploadResult> => {
		const duplicate = tasksRef.current.find((task) => task.remotePath === remotePath && isUploadTaskActive(task));
		if (duplicate) return { status: "duplicate", taskId: duplicate.clientId };
		const clientId = `local-upload-${crypto.randomUUID()}`;
		const task: UploadTask = {
			clientId,
			file,
			remotePath,
			overwrite: false,
			browserBytes: 0,
			phase: "creating",
		};
		replaceTasks((current) => [task, ...current]);
		return await runUpload(clientId, false);
	}, [replaceTasks, runUpload]);

	const confirmOverwrite = useCallback(async (taskId: string) => {
		await runUpload(taskId, true);
	}, [runUpload]);

	const retryUpload = useCallback(async (taskId: string) => {
		const task = tasksRef.current.find((item) => item.clientId === taskId);
		if (!task || task.transfer?.status === "uncertain") return;
		if (task.transfer && !canRetryTransfer(task.transfer)) return;
		await runUpload(taskId, task.overwrite);
	}, [runUpload]);

	const cancelUpload = useCallback(async (taskId: string) => {
		const task = tasksRef.current.find((item) => item.clientId === taskId);
		if (!task || task.phase === "cancelling") return;
		updateTask(taskId, (current) => ({ ...current, phase: "cancelling", error: undefined }));
		controllers.current.get(taskId)?.abort();
		if (!task.transfer) {
			updateTask(taskId, (current) => ({ ...current, phase: "idle" }));
			return;
		}
		try {
			const cancelled = await sftpApi.cancel(workspaceId, task.transfer.id);
			updateTask(taskId, (current) => ({ ...current, transfer: cancelled, phase: "idle", error: undefined }));
		} catch (requestError) {
			updateTask(taskId, (current) => ({ ...current, phase: "idle", error: localizedErrorMessage(requestError) }));
		}
	}, [localizedErrorMessage, updateTask, workspaceId]);

	const dismissTask = useCallback((taskId: string) => {
		replaceTasks((current) => current.filter((task) => task.clientId !== taskId || isUploadTaskActive(task)));
	}, [replaceTasks]);

	const activeUploadCount = tasks.filter(isUploadTaskActive).length;
	useEffect(() => {
		if (activeUploadCount === 0) return;
		const warnBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warnBeforeUnload);
		return () => window.removeEventListener("beforeunload", warnBeforeUnload);
	}, [activeUploadCount]);

	useEffect(() => () => {
		for (const controller of controllers.current.values()) controller.abort();
	}, []);

	const confirmNavigation = useCallback(() => {
		if (!tasksRef.current.some(isUploadTaskActive)) return true;
		if (!window.confirm(intl.formatMessage({ id: "sftp.navigation.confirm" }))) return false;
		for (const task of tasksRef.current.filter(isUploadTaskActive)) {
			controllers.current.get(task.clientId)?.abort();
			if (task.transfer) void sftpApi.cancel(workspaceId, task.transfer.id);
		}
		return true;
	}, [intl, workspaceId]);

	const value = useMemo<SftpTransferManagerValue>(() => ({
		tasks,
		activeUploadCount,
		completedVersion,
		startUpload,
		confirmOverwrite,
		retryUpload,
		cancelUpload,
		dismissTask,
		syncTransfer,
		confirmNavigation,
	}), [
		tasks,
		activeUploadCount,
		completedVersion,
		startUpload,
		confirmOverwrite,
		retryUpload,
		cancelUpload,
		dismissTask,
		syncTransfer,
		confirmNavigation,
	]);

	return <SftpTransferManagerContext.Provider value={value}>{children}</SftpTransferManagerContext.Provider>;
}

export function useSftpTransferManager(): SftpTransferManagerValue {
	const value = useContext(SftpTransferManagerContext);
	if (!value) throw new Error("useSftpTransferManager must be used inside SftpTransferProvider");
	return value;
}

export function useSftpTransferManagerOptional(): SftpTransferManagerValue | null {
	return useContext(SftpTransferManagerContext);
}
