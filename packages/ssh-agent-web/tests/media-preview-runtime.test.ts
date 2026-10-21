import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, HookDriver } from "./helpers/hook-driver";
import type { MediaFile } from "../features/media-preview/model/media-file";

let driver: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useState: <T,>(initial: T) => driver.state(initial),
	useMemo: <T,>(factory: () => T, deps: readonly unknown[]) => driver.memo(factory, deps),
	useCallback: <T,>(callback: T, deps: readonly unknown[]) => driver.memo(() => callback, deps),
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => driver.effect(effect, deps),
}));
vi.mock("../features/media-preview/api/media-preview-api", () => ({ mediaPreviewApi: { inspect: vi.fn() } }));
import { mediaPreviewApi } from "../features/media-preview/api/media-preview-api";
import { useMediaFile } from "../features/media-preview/runtime/use-media-file";
import { useMediaPreviewTabs } from "../features/media-preview/runtime/use-media-preview-tabs";

const file = (path: string): MediaFile => ({ path, name: path, kind: "video", mimeType: "video/mp4", size: 10, modifiedAt: 1 });
beforeEach(() => { driver = new HookDriver(); vi.mocked(mediaPreviewApi.inspect).mockReset(); });

describe("media preview lifecycle", () => {
	it("reuses a normalized path, refreshes it, and closes only the requested media tab", () => {
		const render = () => driver.render(() => useMediaPreviewTabs("a", "/work"));
		const id = render().open("./movie.mp4"); render().open("/work/movie.mp4");
		const other = render().open("other/movie.mp4");
		expect(render().documents).toHaveLength(2); expect(render().documents[0]).toMatchObject({ id, revision: 1 });
		render().close(id); expect(render().documents.map((entry) => entry.id)).toEqual([other]);
		expect(driver.render(() => useMediaPreviewTabs("b", "/work")).documents).toEqual([]);
		expect(driver.render(() => useMediaPreviewTabs("a", "/different")).documents).toEqual([]);
	});
	it("aborts stale metadata reads and ignores late replies after switching Sessions", async () => {
		const old = deferred<MediaFile>(), current = deferred<MediaFile>();
		vi.mocked(mediaPreviewApi.inspect).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
		driver.render(() => useMediaFile("a", "/work/a.mp4", 0));
		const oldSignal = vi.mocked(mediaPreviewApi.inspect).mock.calls[0]![2];
		expect(driver.render(() => useMediaFile("b", "/work/a.mp4", 0)).file).toBeNull();
		expect(oldSignal.aborted).toBe(true);
		old.resolve(file("old-session")); await old.promise;
		expect(driver.render(() => useMediaFile("b", "/work/a.mp4", 0)).file).toBeNull();
		current.resolve(file("new-session")); await current.promise;
		expect(driver.render(() => useMediaFile("b", "/work/a.mp4", 0)).file?.path).toBe("new-session");
		driver.unmount(); expect(vi.mocked(mediaPreviewApi.inspect).mock.calls[1]![2].aborted).toBe(true);
	});
	it("hides old content during a refresh and exposes inspect failures without affecting text readers", async () => {
		const first = deferred<MediaFile>(), retry = deferred<MediaFile>();
		vi.mocked(mediaPreviewApi.inspect).mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
		driver.render(() => useMediaFile("a", "video.mp4", 0)); first.resolve(file("first")); await first.promise;
		expect(driver.render(() => useMediaFile("a", "video.mp4", 0)).file?.path).toBe("first");
		expect(driver.render(() => useMediaFile("a", "video.mp4", 1)).file).toBeNull();
		retry.reject(new Error("missing")); await retry.promise.catch(() => undefined);
		expect(driver.render(() => useMediaFile("a", "video.mp4", 1)).error).toEqual(new Error("missing"));
	});
});
