import type { CredentialSecret } from "../../domain/credential.ts";
import type { SftpDirectoryEntry } from "../../domain/file-transfer.ts";
import { ManagementError } from "../../domain/errors.ts";
import type { WorkspaceConnectionOptions, WorkspaceHostAddress } from "../../domain/workspace.ts";
import { validateCredentialInput } from "../credential-factory.ts";
import { type TestWorkspaceConnectionInput, validateWorkspaceConnection } from "../workspace-connection.ts";

export interface SshConnectionTestInput {
	host: WorkspaceHostAddress;
	connection: WorkspaceConnectionOptions;
	remoteUser: string;
	secret: CredentialSecret;
}

export interface SshConnectionTester {
	test(input: SshConnectionTestInput, signal?: AbortSignal): Promise<void>;
	listDirectory(input: SshConnectionTestInput, path: string, signal?: AbortSignal): Promise<{ path: string; entries: SftpDirectoryEntry[] }>;
	close(): void;
}

export class ConnectionTestService {
	readonly #tester: SshConnectionTester;
	constructor(tester: SshConnectionTester) { this.#tester = tester; }

	async test(input: TestWorkspaceConnectionInput, signal?: AbortSignal): Promise<{ success: true }> {
		await this.#tester.test(this.validatedInput(input), signal);
		return { success: true };
	}

	async listDirectory(input: TestWorkspaceConnectionInput, path: string, signal?: AbortSignal): Promise<{ path: string; entries: SftpDirectoryEntry[] }> {
		if (!path.startsWith("/") || path.includes("\0") || path.length > 4096)
			throw new ManagementError("validation_error", "Remote directory path must be absolute", "path");
		return this.#tester.listDirectory(this.validatedInput(input), path, signal);
	}

	private validatedInput(input: TestWorkspaceConnectionInput): SshConnectionTestInput {
		const { host, connection } = validateWorkspaceConnection(input);
		// Unlike a persistent connection, a test must always have a bounded deadline.
		if (connection.connectTimeoutMs < 1 || connection.connectTimeoutMs > 2_147_483_647) {
			throw new ManagementError("validation_error", "Invalid test connection timeout", "connection.connectTimeoutMs");
		}
		const { remoteUser } = validateCredentialInput(input.credential);
		return { host, connection, remoteUser, secret: input.credential.secret };
	}

	close(): void { this.#tester.close(); }
}
