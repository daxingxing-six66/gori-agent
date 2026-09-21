import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, type ConnectConfig, Server, utils } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import { type SshConnectionTestInput } from "../src/application/services/connection-test-service.ts";
import { SshAgentError } from "../src/domain/ssh-failure.ts";
import { Ssh2ConnectionTester } from "../src/infrastructure/ssh/ssh2-connection-tester.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createNodeHttpServer } from "../src/server/node-http-server.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

const input: SshConnectionTestInput = {
	host: { hostname: "127.0.0.1", port: 22 }, remoteUser: "tester",
	secret: { type: "password", password: "test-only-password" },
	connection: { connectTimeoutMs: 1000, keepaliveIntervalMs: 15000, keepaliveMaxCount: 3 },
};
const body = { host: input.host, credential: { displayName: "Test", remoteUser: input.remoteUser, ...input.secret } };
function backend(tester?: { test: (input: SshConnectionTestInput, signal?: AbortSignal) => Promise<void>; close: () => void }) {
	return createSqliteManagementBackend({ databasePath: ":memory:", credentialEncryptionKey: new Uint8Array(32).fill(1), llmModelsFactory: createTestLlmModels, connectionTester: tester });
}

describe("temporary SSH authentication", () => {
	it("loads in native Node ESM without transpiler interop", () => {
		const modulePath = new URL("../src/infrastructure/ssh/ssh2-connection-tester.ts", import.meta.url).href;
		expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(modulePath)})`], { cwd: fileURLToPath(new URL("..", import.meta.url)) })).not.toThrow();
	});
	it.each(["password", "private_key", "encrypted_key", "wrong_password"])("authenticates %s and closes without opening channels", async (mode) => {
		// ECDSA avoids ssh2's Ed25519 generator stripping leading zero public-key bytes.
		const host = utils.generateKeyPairSync("ecdsa", { bits: 256 });
		const key = utils.generateKeyPairSync("ecdsa", { bits: 256, ...(mode === "encrypted_key" ? { passphrase: "key-password", cipher: "aes256-cbc", rounds: 1 } : {}) });
		const parsed = utils.parseKey(key.private, mode === "encrypted_key" ? "key-password" : undefined);
		if (parsed instanceof Error) throw parsed;
		let channels = 0;
		let connections = 0;
		let release!: () => void;
		const closed = new Promise<void>((resolve) => { release = resolve; });
		const server = new Server({ hostKeys: [host.private] }, (client) => {
			connections++;
			client.on("error", () => {});
			client.on("close", release);
			client.on("authentication", (context) => {
				if (context.username !== "tester") return context.reject();
				if (context.method === "password" && context.password === "test-only-password") return context.accept();
				if (context.method === "publickey" && context.key.data.equals(parsed.getPublicSSH()) && (!context.signature || parsed.verify(context.blob!, context.signature, context.hashAlgo) === true)) return context.accept();
				context.reject();
			});
			client.on("session", (_accept, reject) => { channels++; reject(); });
		});
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const tester = new Ssh2ConnectionTester();
		try {
			const secret = mode === "password" ? input.secret : mode === "wrong_password" ? { type: "password" as const, password: "wrong" } : { type: "private_key" as const, privateKey: key.private, ...(mode === "encrypted_key" ? { passphrase: "key-password" } : {}) };
			const result = tester.test({ ...input, host: { hostname: "127.0.0.1", port: (server.address() as AddressInfo).port }, secret });
			if (mode === "wrong_password") await expect(result).rejects.toMatchObject({ failure: { code: "authentication_failed" } });
			else await result;
			await closed;
			expect(channels).toBe(0);
			expect(connections).toBe(1);
		} finally { tester.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
	});

	it("rejects malformed and public-only keys without connecting", async () => {
		const connect = vi.spyOn(Client.prototype, "connect");
		try {
			for (const privateKey of ["SECRET-invalid", utils.generateKeyPairSync("ecdsa", { bits: 256 }).public]) {
				await expect(new Ssh2ConnectionTester().test({ ...input, secret: { type: "private_key", privateKey } })).rejects.toMatchObject({ failure: { code: "invalid_private_key" } });
			}
			expect(connect).not.toHaveBeenCalled();
		} finally { connect.mockRestore(); }
	});

	it.each([
		["ECONNREFUSED", undefined, "connection_refused"], ["ENOTFOUND", undefined, "dns_lookup_failed"],
		["EHOSTUNREACH", undefined, "network_unreachable"], [undefined, "client-timeout", "connection_timeout"],
		[undefined, "client-authentication", "authentication_failed"],
	])("classifies %s/%s without exposing raw errors", async (code, level, expected) => {
		const connect = vi.spyOn(Client.prototype, "connect").mockImplementation(function (this: Client) { queueMicrotask(() => this.emit("error", Object.assign(new Error("SECRET"), { code, level }))); return this; });
		const destroy = vi.spyOn(Client.prototype, "destroy").mockImplementation(function (this: Client) { return this; });
		try {
			await expect(new Ssh2ConnectionTester().test(input)).rejects.toMatchObject({ failure: { code: expected } });
			expect(destroy).toHaveBeenCalledOnce();
		} finally { connect.mockRestore(); destroy.mockRestore(); }
	});

	it.each(["timeout", "cancel", "shutdown", "close", "throw"])("releases a temporary client on %s", async (mode) => {
		vi.useFakeTimers();
		let client: Client | undefined;
		const connect = vi.spyOn(Client.prototype, "connect").mockImplementation(function (this: Client, _config: ConnectConfig) { client = this; if (mode === "throw") throw new Error("SECRET"); return this; });
		const destroy = vi.spyOn(Client.prototype, "destroy").mockImplementation(function (this: Client) { return this; });
		const tester = new Ssh2ConnectionTester();
		const abort = new AbortController();
		try {
			const pending = tester.test(input, abort.signal);
			const assertion = expect(pending).rejects.toBeInstanceOf(SshAgentError);
			if (mode === "timeout") await vi.advanceTimersByTimeAsync(1000);
			if (mode === "cancel") abort.abort();
			if (mode === "shutdown") tester.close();
			if (mode === "close") client!.emit("close");
			await assertion;
			expect(destroy).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
			client!.emit("error", new Error("late error"));
			client!.emit("ready");
			expect(destroy).toHaveBeenCalledOnce();
		} finally { tester.close(); vi.restoreAllMocks(); vi.useRealTimers(); }
	});
});

describe("connection test HTTP API", () => {
	it("tests an unsaved draft with defaults and creates no records", async () => {
		const tester = { test: vi.fn(async () => {}), close: vi.fn() };
		const app = backend(tester);
		try {
			const response = await app.handleRequest(new Request("http://localhost/api/workspaces/test-connection", { method: "POST", body: JSON.stringify(body) }));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true });
			expect(tester.test).toHaveBeenCalledWith({ ...input, connection: { ...input.connection, connectTimeoutMs: 10000 } }, expect.any(AbortSignal));
			for (const table of ["workspaces", "credentials", "credential_secrets", "workspace_host_trusts", "command_operations"]) expect(app.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(0);
		} finally { await app.close(); }
		expect(tester.close).toHaveBeenCalledOnce();
	});
	it.each(["zh-CN", "en-US"])("localizes authentication failures in %s", async (locale) => {
		const app = backend({ test: async () => { throw new SshAgentError({ code: "authentication_failed", category: "authentication", phase: "authenticate", message: "SSH authentication failed", retryable: false }); }, close() {} });
		try {
			const response = await app.handleRequest(new Request("http://localhost/api/workspaces/test-connection", { method: "POST", headers: { "accept-language": locale }, body: JSON.stringify(body) }));
			expect(response.status).toBe(401);
			const result = await response.json();
			expect(result.error.message).toBe(locale === "zh-CN" ? "SSH 身份验证失败" : "SSH authentication failed");
			expect(JSON.stringify(result)).not.toContain("test-only-password");
		} finally { await app.close(); }
	});
	it.each([{ ...body, host: { hostname: "", port: 22 } }, { ...body, host: { hostname: "localhost", port: 65536 } }, { ...body, connection: { connectTimeoutMs: 0 } }, { ...body, connection: { keepaliveMaxCount: -1 } }, { ...body, credential: { ...body.credential, privateKey: "unexpected" } }])("validates before connecting", async (invalid) => {
		const tester = { test: vi.fn(async () => {}), close() {} };
		const app = backend(tester);
		try {
			const response = await app.handleRequest(new Request("http://localhost/api/workspaces/test-connection", { method: "POST", body: JSON.stringify(invalid) }));
			expect(response.status).toBe(400);
			expect(tester.test).not.toHaveBeenCalled();
		} finally { await app.close(); }
	});
	it("propagates disconnect after the POST body is fully read", async () => {
		let started!: () => void;
		let disconnected!: () => void;
		const began = new Promise<void>((resolve) => { started = resolve; });
		const cancelled = new Promise<void>((resolve) => { disconnected = resolve; });
		const server = createNodeHttpServer({ host: "127.0.0.1", port: 0, handleRequest: async (request) => {
			await request.json(); started();
			await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => { disconnected(); resolve(); }, { once: true }));
			return Response.json({ success: true });
		} });
		const address = await server.listen();
		try {
			const req = httpRequest(`${address.origin}/api/workspaces/test-connection`, { method: "POST" });
			req.on("error", () => {}); req.end(JSON.stringify(body));
			await began; req.destroy(); await cancelled;
		} finally { await server.close(); }
	});
});
