import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SshAgentManagementApi } from "../application/management-api.ts";
import {
	createSqliteManagementBackend,
	type LlmModelsFactory,
	type SqliteManagementBackend,
} from "../runtime/create-sqlite-management-backend.ts";
import { acquireDatabaseOwnership, type DatabaseOwnership } from "./database-ownership.ts";
import { createNodeHttpServer, type NodeHttpServer, type NodeHttpServerAddress } from "./node-http-server.ts";

export interface CreateSshAgentServerOptions {
	databasePath: string;
	credentialEncryptionKey: Uint8Array;
	llmModelsFactory: LlmModelsFactory;
	host?: string;
	port?: number;
	allowedOrigins?: readonly string[];
	maxRequestBodyBytes?: number;
	maxConcurrentOperations?: number;
	localCwd?: string;
	attachmentBaseDir?: string;
}

export interface SshAgentServer {
	readonly api: SshAgentManagementApi;
	listen(): Promise<NodeHttpServerAddress>;
	close(): Promise<void>;
}

export function createSshAgentServer(options: CreateSshAgentServerOptions): SshAgentServer {
	if (options.databasePath !== ":memory:") mkdirSync(dirname(options.databasePath), { recursive: true });
	if (options.localCwd !== undefined) mkdirSync(options.localCwd, { recursive: true });
	const ownership = acquireDatabaseOwnership(options.databasePath);
	try {
		let backend: SqliteManagementBackend | undefined;
		const httpServer = createNodeHttpServer({
			handleRequest: (request) => {
				if (!backend) throw new Error("SSH Agent backend is not initialized");
				return backend.handleRequest(request);
			},
			host: options.host ?? "127.0.0.1",
			port: options.port ?? 3001,
			...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
			...(options.maxRequestBodyBytes === undefined ? {} : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
		});
		backend = createSqliteManagementBackend({
			databasePath: options.databasePath,
			credentialEncryptionKey: options.credentialEncryptionKey,
			llmModelsFactory: options.llmModelsFactory,
			...(options.localCwd === undefined ? {} : { localCwd: options.localCwd }),
			...(options.attachmentBaseDir === undefined ? {} : { attachmentBaseDir: options.attachmentBaseDir }),
			...(options.maxConcurrentOperations === undefined
				? {}
				: { maxConcurrentOperations: options.maxConcurrentOperations }),
		});
		return new DefaultSshAgentServer(backend, httpServer, ownership);
	} catch (error) {
		ownership.release();
		throw error;
	}
}

type ServerState = "created" | "starting" | "listening" | "closed";

class DefaultSshAgentServer implements SshAgentServer {
	readonly api: SshAgentManagementApi;
	private readonly backend: SqliteManagementBackend;
	private readonly httpServer: NodeHttpServer;
	private readonly ownership: DatabaseOwnership;
	private state: ServerState = "created";

	constructor(backend: SqliteManagementBackend, httpServer: NodeHttpServer, ownership: DatabaseOwnership) {
		this.backend = backend;
		this.httpServer = httpServer;
		this.ownership = ownership;
		this.api = backend.api;
	}

	async listen(): Promise<NodeHttpServerAddress> {
		if (this.state !== "created") throw new Error(`SSH Agent server cannot listen while ${this.state}`);
		this.state = "starting";
		try {
			const address = await this.httpServer.listen();
			this.state = "listening";
			return address;
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.state === "closed") return;
		this.state = "closed";
		const httpClose = this.httpServer.close();
		try {
			await this.backend.close();
		} finally {
			try { await httpClose; }
			finally { this.ownership.release(); }
		}
	}
}
