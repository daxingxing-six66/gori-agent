import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSshAgentServerEnvironment } from "../src/server/environment.ts";

describe("SSH Agent server environment", () => {
	it("reads required secrets and applies safe local defaults", () => {
		const key = Buffer.alloc(32, 9).toString("base64");
		const config = readSshAgentServerEnvironment({
			SSH_AGENT_DATABASE_PATH: "./data/management.sqlite",
			SSH_AGENT_CREDENTIAL_KEY_BASE64: key,
		});

		expect(config.databasePath).toBe(resolve("./data/management.sqlite"));
		expect(config.credentialEncryptionKey).toEqual(Buffer.alloc(32, 9));
		expect(config.host).toBe("127.0.0.1");
		expect(config.port).toBe(3001);
		expect(config.maxConcurrentOperations).toBe(16);
		expect(config.allowedOrigins).toContain("http://localhost:3000");
		expect(config.localCwd).toBe(join(homedir(), ".gori-agent", "workspace"));
	});

	it("accepts an absolute local working directory", () => {
		const key = Buffer.alloc(32, 9).toString("base64");
		const config = readSshAgentServerEnvironment({
			SSH_AGENT_DATABASE_PATH: ":memory:",
			SSH_AGENT_CREDENTIAL_KEY_BASE64: key,
			SSH_AGENT_LOCAL_CWD: "/tmp/ssh-agent-users",
		});
		expect(config.localCwd).toBe("/tmp/ssh-agent-users");
	});

	it("reads and validates the process command concurrency limit", () => {
		const key = Buffer.alloc(32, 9).toString("base64");
		expect(
			readSshAgentServerEnvironment({
				SSH_AGENT_DATABASE_PATH: ":memory:",
				SSH_AGENT_CREDENTIAL_KEY_BASE64: key,
				SSH_AGENT_MAX_CONCURRENT_OPERATIONS: "4",
			}).maxConcurrentOperations,
		).toBe(4);
		expect(() =>
			readSshAgentServerEnvironment({
				SSH_AGENT_DATABASE_PATH: ":memory:",
				SSH_AGENT_CREDENTIAL_KEY_BASE64: key,
				SSH_AGENT_MAX_CONCURRENT_OPERATIONS: "0",
			}),
		).toThrow("SSH_AGENT_MAX_CONCURRENT_OPERATIONS must be between 1 and 9007199254740991");
	});

	it("rejects malformed explicitly configured encryption keys", () => {

		expect(() =>
			readSshAgentServerEnvironment({
				SSH_AGENT_DATABASE_PATH: ":memory:",
				SSH_AGENT_CREDENTIAL_KEY_BASE64: "not-a-key",
			}),
		).toThrow("must be canonical base64 for exactly 32 bytes");
	});
});
