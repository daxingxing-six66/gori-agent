import { describe, expect, it } from "vitest";
import { BuiltinGuardRulePackCatalog } from "../src/application/services/guard-rule-pack-catalog.ts";
import type { CommandGuardRule, Guard, UpdateCommandGuardRuleInput } from "../src/domain/guard.ts";
import type { GuardRulePackDefinition } from "../src/domain/guard-rule-pack.ts";
import type { IdGenerator } from "../src/domain/ids.ts";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

class SequentialIds implements IdGenerator {
	private nextValue = 1;

	next(): string {
		const id = `id-${this.nextValue}`;
		this.nextValue += 1;
		return id;
	}
}

describe("Guard rule pack HTTP API", () => {
	it("lists backend-owned packs and imports missing rules in one Guard revision", async () => {
		const backend = createBackend();
		try {
			await createWorkspace(backend.handleRequest);
			const catalog = await request(backend.handleRequest, "GET", "/api/workspaces/id-1/guard/rule-packs");
			expect(catalog).toMatchObject({
				status: 200,
				body: {
					workspaceId: "id-1",
					guardRevision: 1,
					packs: [
						{ id: "linux-critical", ruleCount: 7, importedRuleCount: 0, availableRuleCount: 7 },
						{ id: "ssh-protection", ruleCount: 4, importedRuleCount: 0, availableRuleCount: 4 },
						{ id: "disk-protection", ruleCount: 4, importedRuleCount: 0, availableRuleCount: 4 },
						{ id: "network-protection", ruleCount: 3, importedRuleCount: 0, availableRuleCount: 3 },
					],
				},
			});

			const imported = await request(backend.handleRequest, "POST", "/api/workspaces/id-1/guard/rule-packs/import", {
				packIds: ["linux-critical", "ssh-protection"],
				expectedRevision: 1,
			});
			expect(imported.status).toBe(200);
			expect(imported.body).toMatchObject({
				guard: { workspaceId: "id-1", enabled: true, revision: 2 },
				results: [
					{ packId: "linux-critical", importedCount: 7, skippedCount: 0 },
					{ packId: "ssh-protection", importedCount: 4, skippedCount: 0 },
				],
			});
			const guard = (imported.body as { guard: Guard }).guard;
			expect(guard.rules).toHaveLength(11);
			expect(guard.rules[0]).toMatchObject({
				id: "id-4",
				source: "builtin",
				originRuleId: "linux.power.shutdown",
				packId: "linux-critical",
				packVersion: "1.0.0",
				level: "critical",
			});

			const state = await request(backend.handleRequest, "GET", "/api/workspaces/id-1/guard/rule-packs");
			expect(state.body).toMatchObject({ guardRevision: 2 });
			expect((state.body as { packs: unknown[] }).packs).toEqual(
				expect.arrayContaining(
					[
						{ id: "linux-critical", importedRuleCount: 7, availableRuleCount: 0 },
						{ id: "ssh-protection", importedRuleCount: 4, availableRuleCount: 0 },
					].map((pack) => expect.objectContaining(pack)),
				),
			);
		} finally {
			backend.close();
		}
	});

	it("keeps imported metadata through normal PATCH and marks new rules as user-owned", async () => {
		const backend = createBackend();
		try {
			await createWorkspace(backend.handleRequest);
			const imported = await request(backend.handleRequest, "POST", "/api/workspaces/id-1/guard/rule-packs/import", {
				packIds: ["network-protection"],
				expectedRevision: 1,
			});
			const importedGuard = (imported.body as { guard: Guard }).guard;
			const editedRules: UpdateCommandGuardRuleInput[] = importedGuard.rules.map((rule, index) =>
				editableRule(rule, index === 0 ? "自定义名称" : undefined),
			);
			editedRules.push({
				displayName: "用户规则",
				pattern: "dangerous-command",
				match: "contains",
				enabled: false,
			});
			const updated = await request(backend.handleRequest, "PATCH", "/api/workspaces/id-1/guard", {
				enabled: true,
				rules: editedRules,
				expectedRevision: 2,
			});
			const guard = updated.body as Guard;
			expect(guard.rules[0]).toMatchObject({
				displayName: "自定义名称",
				source: "builtin",
				originRuleId: "network.ip-link-down",
				packId: "network-protection",
				packVersion: "1.0.0",
				level: "critical",
			});
			expect(guard.rules.at(-1)).toMatchObject({ source: "user", level: "critical" });

			const forbiddenMetadata = await request(backend.handleRequest, "PATCH", "/api/workspaces/id-1/guard", {
				enabled: true,
				rules: [{ ...editableRule(guard.rules[0]), source: "user" }],
				expectedRevision: 3,
			});
			expect(forbiddenMetadata).toMatchObject({
				status: 400,
				body: { error: { code: "validation_error", field: "rules[0].source" } },
			});
		} finally {
			backend.close();
		}
	});

	it("skips already imported origins without writing a new revision", async () => {
		const backend = createBackend();
		try {
			await createWorkspace(backend.handleRequest);
			await request(backend.handleRequest, "POST", "/api/workspaces/id-1/guard/rule-packs/import", {
				packIds: ["disk-protection"],
				expectedRevision: 1,
			});
			const repeated = await request(backend.handleRequest, "POST", "/api/workspaces/id-1/guard/rule-packs/import", {
				packIds: ["disk-protection"],
				expectedRevision: 2,
			});
			expect(repeated.body).toMatchObject({
				guard: { revision: 2 },
				results: [{ packId: "disk-protection", importedCount: 0, skippedCount: 4 }],
			});
			expect(backend.database.prepare("SELECT revision FROM guards WHERE workspace_id = ?").get("id-1")).toEqual({
				revision: 2,
			});
		} finally {
			backend.close();
		}
	});

	it("rejects stale, empty, duplicate, and unknown imports without changing Guard", async () => {
		const backend = createBackend();
		try {
			await createWorkspace(backend.handleRequest);
			for (const [body, code] of [
				[{ packIds: [], expectedRevision: 1 }, "validation_error"],
				[{ packIds: ["linux-critical", "linux-critical"], expectedRevision: 1 }, "validation_error"],
				[{ packIds: ["linux-critical", "unknown"], expectedRevision: 1 }, "validation_error"],
				[{ packIds: ["linux-critical"], expectedRevision: 2 }, "revision_conflict"],
			] as const) {
				const response = await request(
					backend.handleRequest,
					"POST",
					"/api/workspaces/id-1/guard/rule-packs/import",
					body,
				);
				expect(response.body).toMatchObject({ error: { code } });
			}
			expect(await request(backend.handleRequest, "GET", "/api/workspaces/id-1/guard")).toMatchObject({
				body: { revision: 1, rules: [] },
			});
		} finally {
			backend.close();
		}
	});

	it("normalizes historical rules as user-owned and fails fast for an invalid catalog", async () => {
		const backend = createBackend();
		try {
			await createWorkspace(backend.handleRequest);
			backend.database
				.prepare("UPDATE guards SET rules_json = ? WHERE workspace_id = ?")
				.run(
					JSON.stringify([
						{ id: "legacy", displayName: "Legacy", pattern: "halt", match: "contains", enabled: true },
					]),
					"id-1",
				);
			const response = await request(backend.handleRequest, "GET", "/api/workspaces/id-1/guard");
			expect(response.body).toMatchObject({ rules: [{ id: "legacy", source: "user", level: "critical" }] });
		} finally {
			backend.close();
		}

		const duplicatedOrigin = [
			pack("one", "shared.origin"),
			pack("two", "shared.origin"),
		] satisfies readonly GuardRulePackDefinition[];
		expect(() => new BuiltinGuardRulePackCatalog(duplicatedOrigin)).toThrow("Duplicate Guard origin rule id");
	});
});

function editableRule(rule: CommandGuardRule, displayName = rule.displayName) {
	return {
		id: rule.id,
		displayName,
		pattern: rule.pattern,
		match: rule.match,
		...(rule.reason === undefined ? {} : { reason: rule.reason }),
		enabled: rule.enabled,
	};
}

function pack(id: string, originRuleId: string): GuardRulePackDefinition {
	return {
		id,
		name: id,
		description: id,
		version: "1.0.0",
		recommended: false,
		rules: [
			{
				originRuleId,
				displayName: originRuleId,
				pattern: originRuleId,
				match: "contains",
				enabled: true,
				level: "critical",
			},
		],
	};
}

function createBackend() {
	return createSqliteManagementBackend({
		databasePath: ":memory:",
		credentialEncryptionKey: new Uint8Array(32).fill(7),
		clock: { now: () => 1_000 },
		ids: new SequentialIds(),
		llmModelsFactory: createTestLlmModels,
	});
}

function createWorkspace(handleRequest: (request: Request) => Promise<Response>): Promise<HttpResult> {
	return request(handleRequest, "POST", "/api/workspaces", {
		displayName: "workspace",
		environment: "development",
		host: { hostname: "localhost", port: 22 },
		credential: { displayName: "root", remoteUser: "root", type: "password", password: "password" },
		defaultCwd: "/tmp",
	});
}

interface HttpResult {
	status: number;
	body: unknown;
}

async function request(
	handleRequest: (request: Request) => Promise<Response>,
	method: string,
	path: string,
	body?: unknown,
): Promise<HttpResult> {
	const response = await handleRequest(
		new Request(`http://localhost${path}`, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
}
