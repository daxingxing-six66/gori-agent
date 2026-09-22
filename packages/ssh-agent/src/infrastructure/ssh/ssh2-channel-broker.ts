import type { CredentialSecretStore } from "../../application/repositories/credential-repository.ts";
import type {
	ConnectionPoolSnapshot,
	DownloadRemoteFileInput,
	ExecuteRemoteCommandInput,
	RemoteDownloadResult,
	RemoteExecutionResult,
	RemoteUploadResult,
	SftpPathInput,
	SshChannelBroker,
	UploadRemoteFileInput,
} from "../../application/ssh-channel-broker.ts";
import { FileTransferError, type SftpDirectoryEntry } from "../../domain/file-transfer.ts";
import { createSshError } from "./ssh2-errors.ts";
import { SftpTransferLimiter } from "./sftp-transfer-limiter.ts";
import { Ssh2ConnectionPool, type Ssh2ConnectionPoolOptions } from "./ssh2-connection-pool.ts";
import { Ssh2ExecCommandBroker } from "./ssh2-exec-command-broker.ts";
import { Ssh2SftpFileBroker } from "./ssh2-sftp-file-broker.ts";
import { Ssh2TerminalChannelBroker } from "./ssh2-terminal-channel-broker.ts";

export class Ssh2ChannelBroker implements SshChannelBroker {
	private readonly pool: Ssh2ConnectionPool;
	private readonly commands: Ssh2ExecCommandBroker;
	private readonly files: Ssh2SftpFileBroker;
	private readonly transfers = new SftpTransferLimiter();
	readonly terminals: Ssh2TerminalChannelBroker;

	constructor(secrets: CredentialSecretStore, options: Ssh2ConnectionPoolOptions = {}) {
		this.pool = new Ssh2ConnectionPool(secrets, options);
		this.commands = new Ssh2ExecCommandBroker(this.pool);
		this.files = new Ssh2SftpFileBroker(this.pool);
		this.terminals = new Ssh2TerminalChannelBroker(this.pool);
	}

	execute(input: ExecuteRemoteCommandInput): Promise<RemoteExecutionResult> {
		return this.commands.execute(input);
	}

	listDirectory(input: SftpPathInput): Promise<{ path: string; entries: SftpDirectoryEntry[] }> {
		return this.files.listDirectory(input);
	}

	stat(input: SftpPathInput): Promise<SftpDirectoryEntry> {
		return this.files.stat(input);
	}

	upload(input: UploadRemoteFileInput): Promise<RemoteUploadResult> {
		return this.transfers.run(input, () => this.files.upload(input),
			() => createSshError("upload_cancelled", "execution", "cancel", "File upload was cancelled"));
	}

	download(input: DownloadRemoteFileInput): Promise<RemoteDownloadResult> {
		return this.transfers.run(input, () => this.files.download(input),
			() => new FileTransferError("transfer_cancelled", "File download was cancelled", 409));
	}

	deleteFile(input: SftpPathInput): Promise<void> {
		return this.files.deleteFile(input);
	}

	snapshotWorkspace(workspaceId: string): ConnectionPoolSnapshot {
		return this.pool.snapshotWorkspace(workspaceId);
	}

	invalidateWorkspace(workspaceId: string): void {
		this.transfers.cancelQueued((target) => target.workspaceId === workspaceId);
		this.pool.invalidateWorkspace(workspaceId);
	}

	invalidateCredential(credentialId: string): void {
		this.transfers.cancelQueued((target) => target.credentialId === credentialId);
		this.pool.invalidateCredential(credentialId);
	}

	close(): void {
		this.transfers.close();
		this.files.close();
		this.pool.close();
	}
}
