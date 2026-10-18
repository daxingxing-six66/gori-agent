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

	it("searches the Session directory through one no-store request and ranks exact names", async () => {
		await mkdir(join(rootPath, "src", "test", "java"), { recursive: true });
		await writeFile(join(rootPath, "src", "test", "java", "MidAutumnLoginConverterTest.java"), "fixture");
		const response = await backend.handleRequest(new Request("http://localhost/api/sessions/id-4/local-files/search?query=MidAutumnLoginConverterTest"));
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toMatchObject({ incomplete: false, truncated: false,
			entries: [{ name: "MidAutumnLoginConverterTest.java", relativePath: join("src", "test", "java", "MidAutumnLoginConverterTest.java") }] });
	});

	it("keeps search roots scoped to the current Session and supports explicit refresh and ignored files", async () => {
		await writeFile(join(outsidePath, "OutsideOnly.java"), "outside");
		await writeFile(join(rootPath, ".gitignore"), "Hidden.java\n");
		await writeFile(join(rootPath, "Hidden.java"), "hidden");
		expect(await request(backend, "/api/sessions/id-4/local-files/search?query=OutsideOnly"))
			.toMatchObject({ status: 200, body: { entries: [], incomplete: false } });
		expect(await request(backend, "/api/sessions/id-4/local-files/search?query=Hidden"))
			.toMatchObject({ status: 200, body: { entries: [] } });
		expect(await request(backend, "/api/sessions/id-4/local-files/search?query=Hidden&includeIgnored=true"))
			.toMatchObject({ status: 200, body: { entries: [{ name: "Hidden.java" }] } });
		await writeFile(join(rootPath, "NewlyAdded.java"), "new");
		expect(await request(backend, "/api/sessions/id-4/local-files/search?query=NewlyAdded&refresh=true"))
			.toMatchObject({ status: 200, body: { entries: [{ name: "NewlyAdded.java" }] } });
	});

	it("validates search flags, paths and Session identity through the ordinary API error contract", async () => {
		for (const [suffix, status, code] of [
			["?query=../outside/file", 403, "local_file_path_outside_work_dir"],
			["?query=outside-link/file", 403, "local_file_path_symlink_not_allowed"],
			["?query=x&includeIgnored=invalid", 400, "validation_error"],
			["?query=x&refresh=invalid", 400, "validation_error"],
			[`?query=${"x".repeat(513)}`, 400, "validation_error"],
		] as const) {
			expect(await request(backend, `/api/sessions/id-4/local-files/search${suffix}`))
				.toMatchObject({ status, body: { error: { code } } });
		}
		expect(await request(backend, "/api/sessions/missing/local-files/search?query=x"))
			.toMatchObject({ status: 404, body: { error: { code: "session_not_found" } } });
	});

	it("uses the updated Session workDir instead of a cached previous root", async () => {
		expect(await request(backend, "/api/sessions/id-4/local-files/search?query=release.tar"))
			.toMatchObject({ body: { entries: [{ name: "release.tar" }] } });
		await writeFile(join(outsidePath, "Different.java"), "new root");
		const updated = await backend.handleRequest(new Request("http://localhost/api/sessions/id-4", {
			method: "PATCH", headers: { "content-type": "application/json" },
			body: JSON.stringify({ workDir: outsidePath, expectedRevision: 1 }),
		}));
		expect(updated.status).toBe(200);
		expect(await request(backend, "/api/sessions/id-4/local-files/search?query=release.tar"))
			.toMatchObject({ body: { entries: [] } });
		expect(await request(backend, "/api/sessions/id-4/local-files/search?query=Different"))
			.toMatchObject({ body: { entries: [{ path: join(outsidePath, "Different.java") }] } });
	});

	it("reads complete UTF-8 file contents using relative and absolute paths without caching", async () => {
		const filePath = join(rootPath, "nested", "说明.md");
		const content = "# 文件预览\n\n" + "完整内容\n".repeat(4000);
		await writeFile(filePath, content);
		for (const path of ["nested/说明.md", filePath]) {
			const response = await backend.handleRequest(new Request(`http://localhost/api/sessions/id-4/local-files/content?path=${encodeURIComponent(path)}`));
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await response.json()).toMatchObject({ path: filePath, name: "说明.md", content, size: Buffer.byteLength(content) });
		}
		await writeFile(filePath, "Updated");
		expect(await request(backend, `/api/sessions/id-4/local-files/content?path=${encodeURIComponent(filePath)}`))
			.toMatchObject({ status: 200, body: { content: "Updated" } });
	});

	it("rejects file path escapes, symlinks, directories, missing files and unknown sessions", async () => {
		await symlink(join(rootPath, "release.tar"), join(rootPath, "file-link"));
		const cases = [
			[outsidePath, 403, "local_file_path_outside_work_dir"],
			["../escape.txt", 403, "local_file_path_outside_work_dir"],
			["outside-link/app.txt", 403, "local_file_path_symlink_not_allowed"],
			["file-link", 403, "local_file_path_symlink_not_allowed"],
			["nested", 400, "local_file_path_not_file"],
			["missing.txt", 404, "local_file_path_not_found"],
			["\0.txt", 400, "local_file_path_invalid"],
		] as const;
		await writeFile(join(outsidePath, "app.txt"), "outside");
		for (const [path, status, code] of cases) {
			expect(await request(backend, `/api/sessions/id-4/local-files/content?path=${encodeURIComponent(path)}`))
				.toMatchObject({ status, body: { error: { code } } });
		}
		expect(await request(backend, "/api/sessions/missing/local-files/content?path=file.txt"))
			.toMatchObject({ status: 404, body: { error: { code: "session_not_found" } } });
		expect(await request(backend, "/api/sessions/id-4/local-files/content"))
			.toMatchObject({ status: 400, body: { error: { code: "validation_error" } } });
	});

	it("supports empty files and enforces byte and text limits with localized errors", async () => {
		await writeFile(join(rootPath, "empty.txt"), "");
		await writeFile(join(rootPath, "large.txt"), Buffer.alloc(1024 * 1024, "a"));
		expect(await request(backend, "/api/sessions/id-4/local-files/content?path=empty.txt"))
			.toMatchObject({ status: 200, body: { content: "", size: 0 } });
		expect(await request(backend, "/api/sessions/id-4/local-files/content?path=large.txt"))
			.toMatchObject({ status: 200, body: { size: 1024 * 1024 } });
		await writeFile(join(rootPath, "large.txt"), Buffer.alloc(1024 * 1024 + 1, "a"));
		await writeFile(join(rootPath, "binary.bin"), Buffer.from([0, 1, 2]));
		await writeFile(join(rootPath, "invalid.txt"), Buffer.from([0xff, 0xfe]));
		for (const [name, status, code] of [["large.txt", 413, "local_file_too_large"], ["binary.bin", 415, "local_file_not_text"], ["invalid.txt", 415, "local_file_not_text"]] as const) {
			for (const locale of ["zh-CN", "en-US"]) {
				const response = await backend.handleRequest(new Request(`http://localhost/api/sessions/id-4/local-files/content?path=${name}`, { headers: { "accept-language": locale } }));
				expect(response.status).toBe(status);
				const body = await response.json() as { error: { code: string; message: string } };
				expect(body.error.code).toBe(code);
				expect(body.error.message).toContain(code === "local_file_too_large" ? "1 MiB" : "UTF-8");
				expect(response.headers.get("content-language")).toBe(locale);
			}
		}
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
