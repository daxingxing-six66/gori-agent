import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server, utils } from "ssh2";
import { describe, expect, it } from "vitest";
import type { IdGenerator } from "../src/domain/ids.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

class SequentialIds implements IdGenerator {
	private value = 1;

	next(): string {
		const id = `id-${this.value}`;
		this.value += 1;
		return id;
	}
}

describe("automatic Workspace host trust bootstrap", () => {
	it("performs one TOFU probe for concurrent first commands and preserves trust across Credential switches", async () => {
		const hostKey = utils.generateKeyPairSync("ed25519");
		const parsed = utils.parseKey(hostKey.private);
		if (parsed instanceof Error) throw parsed;
		const expectedFingerprint = `SHA256:${createHash("sha256")
			.update(parsed.getPublicSSH())
			.digest("base64")
			.replace(/=+$/, "")}`;
		let connectionCount = 0;
		let authenticationCount = 0;
		const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
			connectionCount += 1;
			client.on("error", () => {});
			client.on("authentication", (context) => {
				if (context.method === "password" && ["password-one", "password-two"].includes(context.password)) {
					authenticationCount += 1;
					context.accept();
				} else {
					context.reject();
				}
			});
			client.on("ready", () => {
				client.on("session", (accept) => {
					const session = accept();
					session.on("exec", (acceptExec, _reject, info) => {
						const channel = acceptExec();
						channel.write(`ran:${info.command}`);
						channel.exit(0);
						channel.end();
					});
				});
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const port = (server.address() as AddressInfo).port;
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: new Uint8Array(32).fill(7),
			ids: new SequentialIds(),
			llmModelsFactory: createTestLlmModels,
		});
		try {
			const workspace = await request(backend.handleRequest, "POST", "/api/workspaces", {
				displayName: "Local SSH",
				environment: "development",
				host: { hostname: "127.0.0.1", port },
				credential: {
					displayName: "Primary",
					remoteUser: "root",
					type: "password",
					password: "password-one",
				},
				defaultCwd: "/tmp",
			});
			expect(workspace.workspace).toMatchObject({ host: { hostKey: null } });
			const firstSession = await request(backend.handleRequest, "POST", "/api/workspaces/id-1/sessions", {
				displayName: "First",
			});
			const secondSession = await request(backend.handleRequest, "POST", "/api/workspaces/id-1/sessions", {
				displayName: "Second",
			});

			const [first, second] = await Promise.all([
				backend.commandOperations.submit({
					toolCallId: "tool-first",
					sessionId: stringField(firstSession, "id"),
					command: "echo first",
				}),
				backend.commandOperations.submit({
					toolCallId: "tool-second",
					sessionId: stringField(secondSession, "id"),
					command: "echo second",
				}),
			]);
			expect(first.operation.status).toBe("completed");
			expect(second.operation.status).toBe("completed");
			expect(connectionCount).toBe(2);
			expect(authenticationCount).toBe(1);

			const trust = backend.database
				.prepare("SELECT algorithm, fingerprint, verified_at FROM workspace_host_trusts WHERE workspace_id = ?")
				.get("id-1");
			expect(trust).toMatchObject({
				algorithm: "ssh-ed25519",
				fingerprint: expectedFingerprint,
			});
			expect(typeof trust?.verified_at).toBe("number");

			const tree = await request(backend.handleRequest, "GET", "/api/workspace-session-tree");
			expect(tree.workspaces).toMatchObject([
				{
					workspace: {
						host: {
							hostKey: { algorithm: "ssh-ed25519", fingerprint: expectedFingerprint },
						},
					},
				},
			]);

			const added = await request(backend.handleRequest, "POST", "/api/workspaces/id-1/credentials", {
				displayName: "Secondary",
				remoteUser: "deploy",
				type: "password",
				password: "password-two",
			});
			await request(backend.handleRequest, "PUT", "/api/workspaces/id-1/active-credential", {
				credentialId: stringField(added, "id"),
				expectedRevision: 1,
			});
			const afterSwitch = await backend.commandOperations.submit({
				toolCallId: "tool-after-switch",
				sessionId: stringField(firstSession, "id"),
				command: "echo switched",
			});
			expect(afterSwitch.operation.status).toBe("completed");
			expect(connectionCount).toBe(3);
			expect(authenticationCount).toBe(2);
			expect(
				backend.database
					.prepare("SELECT algorithm, fingerprint, verified_at FROM workspace_host_trusts WHERE workspace_id = ?")
					.get("id-1"),
			).toEqual(trust);
		} finally {
			backend.close();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});

async function request(
	handler: (request: Request) => Promise<Response>,
	method: string,
	path: string,
	body?: unknown,
): Promise<Record<string, unknown>> {
	const response = await handler(
		new Request(`http://localhost${path}`, {
			method,
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		}),
	);
	expect(response.status).toBeLessThan(400);
	return (await response.json()) as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, field: string): string {
	const value = source[field];
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	return value;
}
