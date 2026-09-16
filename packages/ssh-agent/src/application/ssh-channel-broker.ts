import type { SftpDirectoryEntry } from "../domain/file-transfer.ts";
import type { SshTargetSnapshot } from "../domain/ssh-target.ts";
import type { TerminalGeometry } from "../domain/terminal.ts";

export interface RemoteExecutionResult {
	exitCode?: number;
	exitSignal?: string;
}

export interface ExecuteRemoteCommandInput {
	target: SshTargetSnapshot;
	command: string;
	signal: AbortSignal;
	onStdout(chunk: Uint8Array): Promise<void>;
	onStderr(chunk: Uint8Array): Promise<void>;
}

export interface UploadRemoteFileInput {
	target: SshTargetSnapshot;
	remotePath: string;
	data: AsyncIterable<Uint8Array>;
	signal: AbortSignal;
	onProgress(bytesTransferred: number): Promise<void>;
	overwrite: boolean;
}

export interface RemoteUploadResult {
	bytesTransferred: number;
}

export interface SftpPathInput {
	target: SshTargetSnapshot;
	remotePath: string;
	signal: AbortSignal;
}

export interface DownloadRemoteFileInput extends SftpPathInput {
	onData(chunk: Uint8Array): Promise<void>;
	onProgress(bytesTransferred: number): Promise<void>;
}

export interface RemoteDownloadResult {
	bytesTransferred: number;
}

export interface ConnectionPoolSnapshot {
	workspaceId: string;
	state: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
	activeChannels: number;
	waitingChannels: number;
	generation: number;
	connectedAt?: number;
	lastError?: { code: string; message: string };
}

/** Application-facing channel boundary. Callers never receive a physical SSH connection. */
export interface RemoteCommandBroker {
	execute(input: ExecuteRemoteCommandInput): Promise<RemoteExecutionResult>;
}

export interface SftpFileBroker {
	listDirectory(input: SftpPathInput): Promise<{ path: string; entries: SftpDirectoryEntry[] }>;
	stat(input: SftpPathInput): Promise<SftpDirectoryEntry>;
	upload(input: UploadRemoteFileInput): Promise<RemoteUploadResult>;
	download(input: DownloadRemoteFileInput): Promise<RemoteDownloadResult>;
	deleteFile(input: SftpPathInput): Promise<void>;
}

export interface SshConnectionPoolControl {
	snapshotWorkspace(workspaceId: string): ConnectionPoolSnapshot;
	invalidateWorkspace(workspaceId: string): void;
	invalidateCredential(credentialId: string): void;
	close(): void;
}

export interface TerminalChannelExit {
	readonly kind: "closed" | "error" | "connection_lost";
	readonly exitCode?: number;
	readonly exitSignal?: string;
	readonly message?: string;
}

export interface OpenTerminalChannelInput {
	readonly target: SshTargetSnapshot;
	readonly geometry: TerminalGeometry;
	readonly term: "xterm-256color";
	readonly signal: AbortSignal;
	readonly onData: (chunk: Uint8Array) => void;
}

export interface TerminalChannelHandle {
	readonly connectionGeneration: number;
	readonly closed: Promise<TerminalChannelExit>;
	write(data: Uint8Array): Promise<void>;
	resize(geometry: TerminalGeometry): Promise<void>;
	setReadPaused(paused: boolean): void;
	close(): Promise<void>;
	dispose(): void;
}

export interface TerminalChannelBroker {
	open(input: OpenTerminalChannelInput): Promise<TerminalChannelHandle>;
}

export interface SshChannelBroker extends RemoteCommandBroker, SftpFileBroker, SshConnectionPoolControl {}
