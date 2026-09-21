import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IdGenerator } from "../src/domain/ids.ts";
import {
	createSqliteManagementBackend,
	type SqliteManagementBackend,
} from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

class SequentialIds implements IdGenerator {
	private nextValue = 1;

	next(): string {
		const id = `id-${this.nextValue}`;
		this.nextValue += 1;
		return id;
	}
}

describe("Session local file system API", () => {
	let backend: SqliteManagementBackend;
	let rootPath: string;
	let outsidePath: string;

	beforeEach(async () => {
		rootPath = await realpath(await mkdtemp(join(tmpdir(), "pi-local-files-root-")));
		outsidePath = await realpath(await mkdtemp(join(tmpdir(), "pi-local-files-outside-")));
		await mkdir(join(rootPath, "nested"));
		await writeFile(join(rootPath, "release.tar"), "release-data");
		await writeFile(join(rootPath, "nested", "app.txt"), "app-data");
		await symlink(outsidePath, join(rootPath, "outside-link"));
		backend = createSqliteManagementBackend({
			databasePath: ":memory:",
			credentialEncryptionKey: new Uint8Array(32).fill(7),
			clock: { now: () => 1_000 },
			ids: new SequentialIds(),
			llmModelsFactory: createTestLlmModels,
			localCwd: outsidePath,
		});
		await createWorkspace(backend, rootPath);
	});

	afterEach(async () => {
		backend.close();
		await Promise.all([
			rm(rootPath, { recursive: true, force: true }),
			rm(outsidePath, { recursive: true, force: true }),
		]);
	});

	it("lists direct children with absolute paths from the Session workDir", async () => {
		const listing = await request(backend, "/api/sessions/id-4/local-files");
		expect(listing.status).toBe(200);
		expect(listing.body).toMatchObject({
			rootPath,
			currentPath: rootPath,
			relativePath: "",
			entries: [
				{
					name: "nested",
					path: join(rootPath, "nested"),
					relativePath: "nested",
					type: "directory",
				},
				{
					name: "release.tar",
					path: join(rootPath, "release.tar"),
					relativePath: "release.tar",
					type: "file",
					size: 12,
				},
			],
		});
		expect((listing.body as { entries: { name: string }[] }).entries).not.toContainEqual({ name: "outside-link" });
	});

	it("uses localCwd when the Session workDir is null", async () => {
		await backend.handleRequest(
			new Request("http://localhost/api/workspaces/id-1/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ displayName: "default-directory" }),
			}),
		);
		const reset = await backend.handleRequest(new Request("http://localhost/api/sessions/id-5", {
			method: "PATCH", headers: { "content-type": "application/json" },
			body: JSON.stringify({ workDir: null, expectedRevision: 1 }),
		}));
		expect(reset.status).toBe(200);
		const listing = await request(backend, "/api/sessions/id-5/local-files");
		expect(listing.body).toMatchObject({ rootPath: outsidePath, currentPath: outsidePath });
	});

	it("lists an absolute child directory without recursively expanding it", async () => {
		const nestedPath = join(rootPath, "nested");
		const listing = await request(backend, `/api/sessions/id-4/local-files?path=${encodeURIComponent(nestedPath)}`);
		expect(listing.body).toMatchObject({
			rootPath,
			currentPath: nestedPath,
			relativePath: "nested",
			entries: [{ name: "app.txt", path: join(nestedPath, "app.txt"), relativePath: join("nested", "app.txt") }],
		});
	});

	it("rejects relative, outside, symlink, missing, and file paths", async () => {
		const cases = [
			["relative", 400, "local_file_path_invalid"],
			[outsidePath, 403, "local_file_path_outside_work_dir"],
			[join(rootPath, "outside-link"), 403, "local_file_path_symlink_not_allowed"],
			[join(rootPath, "missing"), 404, "local_file_path_not_found"],
			[join(rootPath, "release.tar"), 400, "local_file_path_not_directory"],
		] as const;
		for (const [path, status, code] of cases) {
			const response = await request(backend, `/api/sessions/id-4/local-files?path=${encodeURIComponent(path)}`);
			expect(response).toMatchObject({ status, body: { error: { code } } });
		}
	});

	it("returns a distinct not-found error for an unknown Session", async () => {
		const response = await request(backend, "/api/sessions/missing/local-files");
		expect(response).toMatchObject({ status: 404, body: { error: { code: "session_not_found" } } });
	});

	it("lists the whole local system from the filesystem root", async () => {
		const root = await request(backend, "/api/local-files");
		expect(root).toMatchObject({
			status: 200,
			body: { rootPath: "/", currentPath: "/", relativePath: "", entries: expect.any(Array) },
		});

		const directory = await request(backend, `/api/local-files?path=${encodeURIComponent(rootPath)}`);
		expect(directory).toMatchObject({
			status: 200,
			body: {
				rootPath: "/",
				currentPath: rootPath,
				entries: expect.arrayContaining([
					expect.objectContaining({ name: "release.tar", path: join(rootPath, "release.tar") }),
				]),
			},
		});
	});
});

async function createWorkspace(backend: SqliteManagementBackend, workDir: string): Promise<void> {
	await backend.handleRequest(
		new Request("http://localhost/api/workspaces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				displayName: "workspace",
				environment: "development",
				host: { hostname: "localhost", port: 22 },
				credential: {
					displayName: "root",
					remoteUser: "root",
					type: "password",
					password: "password",
				},
				defaultCwd: "/tmp",
			}),
		}),
	);
	await backend.handleRequest(
		new Request("http://localhost/api/workspaces/id-1/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ displayName: "session", workDir }),
		}),
	);
}

async function request(backend: SqliteManagementBackend, path: string): Promise<{ status: number; body: unknown }> {
	const response = await backend.handleRequest(new Request(`http://localhost${path}`));
	return { status: response.status, body: await response.json() };
}
