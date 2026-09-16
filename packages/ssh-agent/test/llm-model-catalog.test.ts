import { describe, expect, it } from "vitest";
import { createSqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

describe("SSH Agent LLM model catalog", () => {
	it("refreshes only configured providers and exact-replaces the last successful snapshot", async () => {
		let response: Response = catalogResponse([model("remote-a", "Remote A"), model("remote-b", "Remote B")]);
		const requests: string[] = [];
		const requestEtags: Array<string | null> = [];
		const backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: new Uint8Array(32).fill(4),
			clock: { now: () => 10_000 },
			llmModelsFactory: createTestLlmModels,
			llmCatalogFetch: (input, init) => {
				requests.push(String(input));
				requestEtags.push(new Headers(init?.headers).get("if-none-match"));
				return Promise.resolve(response);
			},
		});
		try {
			await putCredential(backend.handleRequest, "anthropic");
			await backend.refreshLlmModels();
			expect(requests).toEqual(["https://pi.dev/api/models/providers/anthropic"]);
			expect(backend.llmModelCatalog.getModels("anthropic").map((entry) => entry.id)).toEqual([
				"remote-a",
				"remote-b",
			]);
			const stored = backend.database
				.prepare("SELECT models_json FROM llm_provider_model_catalogs WHERE provider_id = ?")
				.get("anthropic") as { models_json: string };
			expect(JSON.parse(stored.models_json)).toMatchObject([{ id: "remote-a" }, { id: "remote-b" }]);
			expect(backend.llmModelCatalog.getModels("openai").map((entry) => entry.id)).toEqual(["gpt-test"]);
			expect(backend.llmModelCatalog.removeModel("anthropic", "remote-b")).toBe(true);
			response = new Response(null, { status: 304 });
			await backend.refreshLlmModels();
			expect(requestEtags.at(-1)).toBe('"catalog-v1"');
			expect(backend.llmModelCatalog.getModels("anthropic").map((entry) => entry.id)).toEqual(["remote-a"]);

			response = catalogResponse([model("remote-b", "Remote B v2"), model("remote-c", "Remote C")]);
			await backend.refreshLlmModels();
			expect(backend.llmModelCatalog.getModels("anthropic").map((entry) => [entry.id, entry.name])).toEqual([
				["remote-b", "Remote B v2"],
				["remote-c", "Remote C"],
			]);

			response = new Response("temporary failure", { status: 503 });
			await backend.refreshLlmModels();
			expect(backend.llmModelCatalog.getModels("anthropic").map((entry) => entry.id)).toEqual([
				"remote-b",
				"remote-c",
			]);

			response = catalogResponse([]);
			await backend.refreshLlmModels();
			expect(backend.llmModelCatalog.getModels("anthropic")).toEqual([]);
		} finally {
			backend.close();
		}
	});
});

function model(id: string, name: string) {
	return {
		id,
		name,
		api: "faux",
		provider: "ignored-by-server",
		baseUrl: "https://api.example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_000,
		maxTokens: 4_000,
	};
}

function catalogResponse(models: readonly ReturnType<typeof model>[]): Response {
	return Response.json({ models }, { headers: { etag: '"catalog-v1"' } });
}

async function putCredential(
	handleRequest: (request: Request) => Promise<Response>,
	providerId: string,
): Promise<void> {
	const response = await handleRequest(
		new Request(`http://localhost/api/llm/providers/${providerId}/credential`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "api_key", apiKey: "test-key" }),
		}),
	);
	expect(response.status).toBe(200);
}
