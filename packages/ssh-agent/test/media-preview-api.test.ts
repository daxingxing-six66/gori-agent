import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mediaByteRange } from "../src/api/media-preview-routes.ts";
import { createSqliteManagementBackend, type SqliteManagementBackend } from "../src/runtime/create-sqlite-management-backend.ts";
import { createTestLlmModels } from "./test-llm-models.ts";

describe("independent media preview API", () => {
	let backend: SqliteManagementBackend;
	let root: string;
	let sessionId: string;
	const bytes = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
	const request = (path: string, init?: RequestInit) => backend.handleRequest(new Request(`http://localhost/api/sessions/${sessionId}/media-preview${path}`, init));
	beforeEach(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), "gori-media-preview-")));
		await writeFile(join(root, "片 段.mp4"), bytes);
		backend = createSqliteManagementBackend({ databasePath: ":memory:", credentialEncryptionKey: new Uint8Array(32).fill(7),
			llmModelsFactory: createTestLlmModels, localCwd: root });
		const workspace = await backend.handleRequest(new Request("http://localhost/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
			displayName: "media", environment: "development", host: { hostname: "localhost", port: 22 }, defaultCwd: root,
			credential: { displayName: "fixture", remoteUser: "test", type: "password", password: "fixture" },
		}) }));
		expect(workspace.status).toBe(201);
		const { workspace: { id } } = await workspace.json() as { workspace: { id: string } };
		const response = await backend.handleRequest(new Request(`http://localhost/api/workspaces/${id}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "preview", workDir: root }) }));
		expect(response.status).toBe(201);
		sessionId = (await response.json() as { id: string }).id;
	});
	afterEach(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });
	const query = (name = "片 段.mp4") => `?path=${encodeURIComponent(name)}`;

	it("returns metadata separately from text decoding, and refreshes changed files", async () => {
		const response = await request(query());
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ path: join(root, "片 段.mp4"), name: "片 段.mp4", kind: "video", mimeType: "video/mp4", size: bytes.length });
		expect(response.headers.get("cache-control")).toBe("no-store");
		await writeFile(join(root, "片 段.mp4"), "new");
		expect(await (await request(query())).json()).toMatchObject({ size: 3 });
	});

	it.each([["photo.JPG", "image/jpeg", "image"], ["动画.gif", "image/gif", "image"], ["vector.svg", "image/svg+xml", "image"], ["song.mp3", "audio/mpeg", "audio"], ["voice.wav", "audio/wav", "audio"], ["clip.webm", "video/webm", "video"]])("serves %s with an explicit media MIME type", async (name, mimeType, kind) => {
		await writeFile(join(root, name), bytes);
		expect(await (await request(query(name))).json()).toMatchObject({ mimeType, kind });
		const response = await request(`/content${query(name)}`);
		expect(response.headers.get("content-type")).toBe(mimeType);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-security-policy")).toContain("sandbox");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
	});

	it.each([["bytes=2-5", 2, 5], ["bytes=30-", 30, 35], ["bytes=-4", 32, 35], ["bytes=34-99", 34, 35]])("supports seeking with %s", async (range, start, end) => {
		const response = await request(`/content${query()}`, { headers: { range } });
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
		expect(response.headers.get("content-length")).toBe(String(end - start + 1));
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
	});

	it.each(["bytes=999-", "bytes=5-2", "bytes=-0", "bytes=", "bytes=0-2,5-9", "bytes=9007199254740992-", "bytes=-9007199254740992"])("rejects invalid ranges without reading a whole file: %s", async (range) => {
		const response = await request(`/content${query()}`, { headers: { range } });
		expect(response.status).toBe(416);
		expect(response.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
		expect(response.body).toBeNull();
	});

	it("supports HEAD, full GET, If-Range fallback, and empty files", async () => {
		const head = await request(`/content${query()}`, { method: "HEAD", headers: { range: "bytes=2-5" } });
		expect(head.status).toBe(200); expect(head.body).toBeNull();
		expect(head.headers.get("accept-ranges")).toBe("bytes");
		expect(head.headers.get("content-length")).toBe(String(bytes.length));
		const full = await request(`/content${query()}`, { headers: { range: "bytes=2-5", "if-range": '"old-version"' } });
		expect(full.status).toBe(200); expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
		await writeFile(join(root, "empty.mp4"), "");
		const empty = await request(`/content${query("empty.mp4")}`);
		expect(empty.status).toBe(200); expect(await empty.text()).toBe("");
		expect(mediaByteRange("bytes=0-", 0)).toBeNull();
	});

	it("streams large files with bounded ranges and supports cancellation", async () => {
		const file = await open(join(root, "large.mp4"), "w");
		await file.truncate(64 * 1024 * 1024); await file.close();
		const partial = await request(`/content${query("large.mp4")}`, { headers: { range: "bytes=1048576-1048580" } });
		expect(partial.status).toBe(206); expect((await partial.arrayBuffer()).byteLength).toBe(5);
		const response = await request(`/content${query("large.mp4")}`);
		const reader = response.body!.getReader();
		expect((await reader.read()).value!.byteLength).toBeLessThanOrEqual(64 * 1024);
		await reader.cancel();
		const abort = new AbortController();
		const aborted = await request(`/content${query("large.mp4")}`, { signal: abort.signal });
		abort.abort();
		await expect(aborted.arrayBuffer()).rejects.toThrow();
	});

	it("rejects escapes, user symlinks, directories, missing files and unsupported types", async () => {
		await writeFile(join(root, "secret.txt"), "plain text");
		await symlink(join(root, "片 段.mp4"), join(root, "link.mp4"));
		await mkdir(join(root, "folder.mp4"));
		for (const [name, status, code] of [["../escape.mp4", 403, "local_file_path_outside_work_dir"], ["link.mp4", 403, "local_file_path_symlink_not_allowed"], ["folder.mp4", 400, "local_file_path_not_file"], ["missing.mp4", 404, "local_file_path_not_found"], ["secret.txt", 415, "media_preview_type_unsupported"], ["", 400, "local_file_path_invalid"]] as const) {
			const response = await request(query(name));
			expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ error: { code } });
		}
		const missing = await backend.handleRequest(new Request("http://localhost/api/sessions/missing/media-preview?path=a.mp4"));
		expect(missing.status).toBe(404);
	});

	it.runIf(process.platform === "darwin")("accepts macOS /tmp aliases for both media and text while still rejecting user-created symlinks", async () => {
		const systemDir = await mkdtemp("/tmp/gori-preview-alias-");
		const canonical = await realpath(systemDir);
		try {
			await writeFile(join(systemDir, "image.jpg"), bytes);
			await writeFile(join(systemDir, "notes.md"), "# notes");
			await symlink(join(systemDir, "image.jpg"), join(systemDir, "user-link.jpg"));
			await backend.handleRequest(new Request(`http://localhost/api/sessions/${sessionId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workDir: canonical, expectedRevision: 1 }) }));
			expect(await (await request(query(join(systemDir, "image.jpg")))).json()).toMatchObject({ path: join(canonical, "image.jpg"), kind: "image" });
			const text = await backend.handleRequest(new Request(`http://localhost/api/sessions/${sessionId}/local-files/content?path=${encodeURIComponent(join(systemDir, "notes.md"))}`));
			expect(text.status).toBe(200); expect(await text.json()).toMatchObject({ content: "# notes" });
			expect((await request(query(join(systemDir, "user-link.jpg")))).status).toBe(403);
		} finally { await rm(systemDir, { recursive: true, force: true }); }
	});
});
