import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFileSearchIndex } from "../src/application/services/local-file-search-index.ts";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, opendir: vi.fn(actual.opendir) };
});

let root: string;
async function file(path: string) {
	const target = join(root, path);
	await fs.mkdir(join(target, ".."), { recursive: true });
	await fs.writeFile(target, "fixture");
}
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "gori-file-search-"))); vi.mocked(fs.opendir).mockClear(); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("indexed local file search", () => {
	it("finds a deep Java test beyond the old 800-directory cut-off", async () => {
		await Promise.all(Array.from({ length: 850 }, (_, index) => fs.mkdir(join(root, `module-${String(index).padStart(4, "0")}`))));
		const target = "z-api/src/test/java/com/tvjoy/ai/web/activity/midautumn/MidAutumnLoginConverterTest.java";
		await file(target);
		const result = await new LocalFileSearchIndex().search(root, "MidAutumnLoginConverterTest");
		expect(result).toMatchObject({ incomplete: false, truncated: false, entries: [{ relativePath: target, type: "file" }] });
	});

	it("ranks an exact stem globally ahead of early prefix matches before limiting results", async () => {
		await Promise.all(Array.from({ length: 100 }, (_, index) => file(`MidAutumnLoginConverterTestExtra${index}.java`)));
		await file("z/deep/MidAutumnLoginConverterTest.java");
		const result = await new LocalFileSearchIndex().search(root, "midautumnloginconvertertest");
		expect(result.entries).toHaveLength(80);
		expect(result.entries[0]?.relativePath).toBe("z/deep/MidAutumnLoginConverterTest.java");
		expect(result).toMatchObject({ truncated: true, incomplete: false });
	});

	it.each(["MALCT", "MidLoginConvTest", "mid-autumn-login-converter-test", "midautumn/MidAutumnLoginConverterTest", "z\\midautumn\\MidAutumnLoginConverterTest", "Z/MIDAUTUMN/MidAutumnLoginConverterTest"])("matches the filename, abbreviation or path %s", async (query) => {
		await file("z/midautumn/MidAutumnLoginConverterTest.java");
		const result = await new LocalFileSearchIndex().search(root, query);
		expect(result.entries[0]?.name).toBe("MidAutumnLoginConverterTest.java");
	});

	it("preserves Unicode paths and names while matching composed and decomposed queries", async () => {
		await file("说明/中秋登录测试.java");
		await file("Café.ts");
		const search = new LocalFileSearchIndex();
		expect((await search.search(root, "中秋登录")).entries[0]?.relativePath).toBe("说明/中秋登录测试.java");
		expect((await search.search(root, "Cafe\u0301")).entries[0]?.name).toBe("Café.ts");
	});

	it("applies nested ignore rules and negations without hiding legitimate source build folders", async () => {
		await fs.writeFile(join(root, ".gitignore"), "generated/\n*.tmp\n!keep.tmp\n!**/src/main/**/build/\n");
		await Promise.all([file("generated/Hidden.java"), file("node_modules/pkg/Hidden.java"), file("src/main/build/Source.java"), file("keep.tmp"), file("drop.tmp"), file("src/Drop.java"), file("src/Keep.java")]);
		await fs.writeFile(join(root, "src", ".gitignore"), "/*.java\n!Keep.java\n");
		const search = new LocalFileSearchIndex();
		expect((await search.search(root, "Hidden")).entries).toEqual([]);
		expect((await search.search(root, "tmp")).entries.map((entry) => entry.name)).toEqual(["keep.tmp"]);
		expect((await search.search(root, "Source")).entries[0]?.relativePath).toBe("src/main/build/Source.java");
		expect((await search.search(root, "Drop")).entries).toEqual([]);
		expect((await search.search(root, "Keep.java")).entries[0]?.name).toBe("Keep.java");
		expect((await search.search(root, "Hidden", { includeIgnored: true })).entries).toHaveLength(2);
	});

	it("reuses one cold index across overlapping queries and subsequent input without directory IO", async () => {
		await file("src/AlphaService.java");
		const search = new LocalFileSearchIndex();
		const controller = new AbortController();
		const first = search.search(root, "Alpha", { signal: controller.signal });
		while (vi.mocked(fs.opendir).mock.calls.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
		const second = search.search(root, "AlphaService");
		controller.abort(new Error("superseded"));
		await expect(first).rejects.toThrow("superseded");
		expect((await second).entries[0]?.name).toBe("AlphaService.java");
		const reads = vi.mocked(fs.opendir).mock.calls.length;
		expect(reads).toBe(2);
		await search.search(root, "Service");
		await search.search(root, "AlpSer");
		expect(vi.mocked(fs.opendir)).toHaveBeenCalledTimes(reads);
	});

	it("rejects accidental interior/extension subsequences while retaining intentional CamelCase abbreviations", async () => {
		await Promise.all([file("MidAutumnLoginConverterTest.java"), file("FileUploadNormalController.java"), file("TeamApplyController.java")]);
		const result = await new LocalFileSearchIndex().search(root, "MALCT");
		expect(result.entries.map((entry) => entry.name)).toEqual(["MidAutumnLoginConverterTest.java"]);
	});

	it("marks unreadable or oversized ignore rules as incomplete without losing readable files", async () => {
		await file("Needle.java");
		await fs.writeFile(join(root, ".gitignore"), "#".repeat(65_537));
		expect(await new LocalFileSearchIndex().search(root, "Needle")).toMatchObject({ incomplete: true, entries: [{ name: "Needle.java" }] });
	});

	it("refreshes additions on demand and on TTL expiry, and omits deleted cached files immediately", async () => {
		let now = 0;
		const search = new LocalFileSearchIndex({ now: () => now, cacheTtlMs: 100 });
		await file("First.java");
		await search.search(root, "First");
		await file("Added.java");
		expect((await search.search(root, "Added")).entries).toEqual([]);
		expect((await search.search(root, "Added", { refresh: true })).entries[0]?.name).toBe("Added.java");
		await fs.rm(join(root, "First.java"));
		expect((await search.search(root, "First")).entries).toEqual([]);
		await file("Newest.java"); now = 101;
		expect((await search.search(root, "Newest")).entries[0]?.name).toBe("Newest.java");
	});

	it("keeps roots and ignored-file scopes isolated and evicts the least recently used index", async () => {
		await Promise.all([file("one/First.java"), file("two/Second.java"), file("three/Third.java")]);
		const search = new LocalFileSearchIndex({ maxCachedRoots: 2 });
		await search.search(join(root, "one"), "First");
		await search.search(join(root, "two"), "Second");
		expect((await search.search(join(root, "two"), "First")).entries).toEqual([]);
		await search.search(join(root, "three"), "Third");
		const reads = vi.mocked(fs.opendir).mock.calls.length;
		await search.search(join(root, "one"), "First");
		expect(vi.mocked(fs.opendir)).toHaveBeenCalledTimes(reads + 1);
	});

	it.each([{ maxEntries: 1 }, { maxDirectories: 1 }, { maxDurationMs: 0 }, { maxPathCharacters: 1 }])("reports incomplete indexing when the resource budget is exhausted: %j", async (limits) => {
		await file("deep/nested/Needle.java");
		const result = await new LocalFileSearchIndex(limits).search(root, "Needle");
		expect(result.incomplete).toBe(true);
	});

	it("uses an explicit existing directory scope without walking unrelated subtrees", async () => {
		await Promise.all([file("src/Needle.java"), file("other/Needle.java"), file("node_modules/pkg/Explicit.java")]);
		const search = new LocalFileSearchIndex();
		expect((await search.search(root, "src/Needle")).entries.map((entry) => entry.relativePath)).toEqual(["src/Needle.java"]);
		expect(vi.mocked(fs.opendir)).toHaveBeenCalledTimes(1);
		expect((await search.search(root, "node_modules/pkg/Explicit")).entries[0]?.relativePath).toBe("node_modules/pkg/Explicit.java");
	});

	it("rejects scope escapes and symlinks and never follows newly replaced cached directories", async () => {
		await file("src/Needle.java");
		await file(".git/Private.java");
		await fs.symlink(join(root, "src"), join(root, "link"));
		const search = new LocalFileSearchIndex();
		expect((await search.search(root, "Needle")).entries.map((entry) => entry.relativePath)).toEqual(["src/Needle.java"]);
		await expect(search.search(root, "../outside/Needle")).rejects.toMatchObject({ code: "local_file_path_outside_work_dir" });
		await expect(search.search(root, "link/Needle")).rejects.toMatchObject({ code: "local_file_path_symlink_not_allowed" });
		expect((await search.search(root, "Private", { includeIgnored: true })).entries).toEqual([]);
		await fs.rename(join(root, "src"), join(root, "moved"));
		await fs.symlink(join(root, "moved"), join(root, "src"));
		expect((await search.search(root, "Needle")).entries).toEqual([]);
	});

	it("rejects invalid queries and honors an already cancelled request without starting a walk", async () => {
		const search = new LocalFileSearchIndex();
		await expect(search.search(root, "x".repeat(513))).rejects.toMatchObject({ code: "validation_error", field: "query" });
		await expect(search.search(root, "x\0")).rejects.toMatchObject({ code: "validation_error" });
		const controller = new AbortController(); controller.abort();
		await expect(search.search(root, "Needle", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
		expect(vi.mocked(fs.opendir)).not.toHaveBeenCalled();
	});

	it("abandons an unused cold build after the handoff window and rebuilds cleanly on retry", async () => {
		await file("Needle.java");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const actualOpen = vi.mocked(fs.opendir).getMockImplementation()!;
		vi.mocked(fs.opendir).mockImplementationOnce(async (path, options) => {
			const handle = await actualOpen(path, options);
			await gate;
			return handle;
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const search = new LocalFileSearchIndex();
			const controller = new AbortController();
			const first = search.search(root, "Needle", { signal: controller.signal });
			while (vi.mocked(fs.opendir).mock.calls.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			controller.abort(new Error("closed"));
			await expect(first).rejects.toThrow("closed");
			await vi.advanceTimersByTimeAsync(500);
			release();
			expect((await search.search(root, "Needle")).entries[0]?.name).toBe("Needle.java");
			expect(vi.mocked(fs.opendir)).toHaveBeenCalledTimes(2);
		} finally { release(); vi.useRealTimers(); }
	});
});
