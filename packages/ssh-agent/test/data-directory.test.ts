import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDataDirectory } from "../src/data-directory.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { readSshAgentServerEnvironment } from "../src/server/environment.ts";
import { createFileConsole } from "../src/server/file-logger.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

const directories: string[] = [];
function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "gori-data-"));
	directories.push(directory);
	return directory;
}
afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("private application data directory", () => {
	it("defaults to the home directory and expands explicit home-relative paths", () => {
		expect(resolveDataDirectory({})).toBe(join(homedir(), ".gori-agent"));
		expect(resolveDataDirectory({ SSH_AGENT_DATA_DIR: "~/gori-test" })).toBe(join(homedir(), "gori-test"));
		const options = readSshAgentServerEnvironment({ SSH_AGENT_CREDENTIAL_KEY_BASE64: Buffer.alloc(32, 1).toString("base64") });
		expect(options.databasePath).toBe(join(homedir(), ".gori-agent", "ssh-agent.sqlite"));
		expect(options.attachmentBaseDir).toBe(join(homedir(), ".gori-agent"));
		expect(options.logDirectory).toBe(join(homedir(), ".gori-agent", "logs"));
	});

	it("creates and reuses a private key for direct backend startup", () => {
		const data = join(temporaryDirectory(), "private");
		const environment = { SSH_AGENT_DATA_DIR: data };
		const first = readSshAgentServerEnvironment(environment);
		const keyPath = join(data, "credential-key");
		const saved = readFileSync(keyPath, "utf8");
		expect(first.localCwd).toBe(join(data, "workspace"));
		expect(first.credentialEncryptionKey).toHaveLength(32);
		expect(readSshAgentServerEnvironment(environment).credentialEncryptionKey).toEqual(first.credentialEncryptionKey);
		expect(readFileSync(keyPath, "utf8")).toBe(saved);
		if (process.platform !== "win32") {
			expect(statSync(keyPath).mode & 0o777).toBe(0o600);
			expect(statSync(data).mode & 0o777).toBe(0o700);
		}
	});

	it("never creates a replacement key for an existing database", () => {
		const data = temporaryDirectory();
		const databasePath = join(data, "custom.sqlite");
		writeFileSync(databasePath, "existing database");
		expect(() => readSshAgentServerEnvironment({ SSH_AGENT_DATA_DIR: data, SSH_AGENT_DATABASE_PATH: databasePath }))
			.toThrow("key is missing");
		expect(existsSync(join(data, "credential-key"))).toBe(false);
		expect(readFileSync(databasePath, "utf8")).toBe("existing database");
	});

	it("rejects a corrupt saved key without changing it", () => {
		const data = temporaryDirectory();
		const keyPath = join(data, "credential-key");
		writeFileSync(keyPath, "broken");
		expect(() => readSshAgentServerEnvironment({ SSH_AGENT_DATA_DIR: data })).toThrow("canonical base64");
		expect(readFileSync(keyPath, "utf8")).toBe("broken");
	});

	it("preserves explicit database, key and local directory overrides", () => {
		const data = temporaryDirectory();
		const databasePath = join(data, "legacy.sqlite");
		const localCwd = join(data, "chosen-workspace");
		const key = Buffer.alloc(32, 7);
		const options = readSshAgentServerEnvironment({ SSH_AGENT_DATA_DIR: data, SSH_AGENT_DATABASE_PATH: databasePath,
			SSH_AGENT_LOCAL_CWD: localCwd, SSH_AGENT_CREDENTIAL_KEY_BASE64: key.toString("base64") });
		expect(options.databasePath).toBe(databasePath);
		expect(options.localCwd).toBe(localCwd);
		expect(options.credentialEncryptionKey).toEqual(key);
		expect(readdirSync(data)).toEqual([]);
	});

	it("keeps database, uploaded attachments and logs together across backend restart", async () => {
		const data = temporaryDirectory();
		vi.stubEnv("SSH_AGENT_DATA_DIR", data);
		const options = readSshAgentServerEnvironment({ SSH_AGENT_DATA_DIR: data });
		mkdirSync(options.localCwd!, { recursive: true });
		const backend = createSqliteManagementBackend({ ...options, llmModelsFactory: createTestLlmModels });
		let sessionId = "";
		let attachmentId = "";
		try {
			const workspaceResponse = await backend.handleRequest(new Request("http://localhost/api/workspaces", {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
					displayName: "test", environment: "development", host: { hostname: "localhost", port: 22 },
					credential: { displayName: "test", remoteUser: "test", type: "password", password: "test" },
					defaultCwd: options.localCwd,
				}),
			}));
			expect(workspaceResponse.status).toBe(201);
			const workspace = await workspaceResponse.json() as { workspace: { id: string } };
			const sessionResponse = await backend.handleRequest(new Request(`http://localhost/api/workspaces/${workspace.workspace.id}/sessions`, {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "test" }),
			}));
			expect(sessionResponse.status).toBe(201);
			sessionId = (await sessionResponse.json() as { id: string }).id;
			const uploaded = await backend.handleRequest(new Request(`http://localhost/api/sessions/${sessionId}/attachments?name=test.txt`, {
				method: "POST", body: "private attachment",
			}));
			expect(uploaded.status).toBe(201);
			attachmentId = (await uploaded.json() as { id: string }).id;
			expect(readFileSync(join(data, "attachments", "sessions", sessionId, "test.txt"), "utf8")).toBe("private attachment");
			createFileConsole().info("private log");
			expect(readdirSync(join(data, "logs"))).toHaveLength(1);
		} finally { await backend.close(); }
		const reopened = createSqliteManagementBackend({ ...readSshAgentServerEnvironment({ SSH_AGENT_DATA_DIR: data }), llmModelsFactory: createTestLlmModels });
		try {
			expect(await reopened.attachments.list(sessionId)).toMatchObject([{ id: attachmentId }]);
			expect(existsSync(join(data, "ssh-agent.sqlite"))).toBe(true);
		} finally { await reopened.close(); }
	});
});
