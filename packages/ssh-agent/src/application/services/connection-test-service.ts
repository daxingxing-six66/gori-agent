import type { CredentialSecret } from "../../domain/credential.ts";
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
	close(): void;
}

export class ConnectionTestService {
	readonly #tester: SshConnectionTester;
	constructor(tester: SshConnectionTester) { this.#tester = tester; }

	async test(input: TestWorkspaceConnectionInput, signal?: AbortSignal): Promise<{ success: true }> {
		const { host, connection } = validateWorkspaceConnection(input);
		// Unlike a persistent connection, a test must always have a bounded deadline.
		if (connection.connectTimeoutMs < 1 || connection.connectTimeoutMs > 2_147_483_647) {
			throw new ManagementError("validation_error", "Invalid test connection timeout", "connection.connectTimeoutMs");
		}
		const { remoteUser } = validateCredentialInput(input.credential);
		await this.#tester.test({ host, connection, remoteUser, secret: input.credential.secret }, signal);
		return { success: true };
	}

	close(): void { this.#tester.close(); }
}
