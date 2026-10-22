import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookDriver, deferred } from "./helpers/hook-driver";
import type { LocalDirectoryListing } from "../features/chat/api/local-files-api";

let driver: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof React>(),
	useState: (initial: unknown) => driver.state(initial), useMemo: <T,>(factory: () => T, deps: readonly unknown[]) => driver.memo(factory, deps),
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => driver.effect(effect, deps),
}));
const listSession = vi.hoisted(() => vi.fn<(sessionId: string, path?: string, signal?: AbortSignal) => Promise<LocalDirectoryListing>>());
vi.mock("../features/chat/api/local-files-api", () => ({ localFilesApi: { listSession } }));
import { useSessionWorkDir } from "../features/session/runtime/use-session-work-dir";

const listing = (path: string): LocalDirectoryListing => ({ rootPath: path, currentPath: path, relativePath: "", entries: [] });
let sessionId: string;
let workDir: string | null;
let open: boolean;
const render = () => driver.render(() => useSessionWorkDir(sessionId, workDir, open));
const settle = async () => { for (let tick = 0; tick < 10; tick++) await Promise.resolve(); };
beforeEach(() => { vi.resetAllMocks(); driver = new HookDriver(); sessionId = "s"; workDir = null; open = false; });
afterEach(() => driver.unmount());

describe("effective Session working directory", () => {
	it("uses the Session path directly and makes no request while the card is closed", () => {
		expect(render().path).toBeUndefined(); workDir = "/project"; open = true;
		expect(render()).toEqual({ path: "/project", failed: false }); expect(listSession).not.toHaveBeenCalled();
	});
	it("resolves the backend default lazily and reuses it when the card reopens", async () => {
		listSession.mockResolvedValue(listing("/backend/cwd")); render(); open = true; render(); await settle();
		expect(render()).toEqual({ path: "/backend/cwd", failed: false });
		open = false; render(); open = true; expect(render().path).toBe("/backend/cwd"); expect(listSession).toHaveBeenCalledOnce();
	});
	it("cancels old lookups and rejects a late path after a Session switch", async () => {
		const pending = deferred<LocalDirectoryListing>(); listSession.mockReturnValueOnce(pending.promise); open = true; render();
		const signal = listSession.mock.calls[0]![2]; sessionId = "new"; workDir = "/new/project"; render();
		expect(signal?.aborted).toBe(true); pending.resolve(listing("/old/project")); await settle();
		expect(render().path).toBe("/new/project");
	});
	it("reports failures without inventing a path and retries on the next open", async () => {
		listSession.mockRejectedValueOnce(new Error("offline")); open = true; render(); await settle();
		expect(render()).toEqual({ path: undefined, failed: true }); open = false; render();
		listSession.mockResolvedValue(listing("/recovered")); open = true; render(); await settle();
		expect(render().path).toBe("/recovered"); expect(listSession).toHaveBeenCalledTimes(2);
	});
});
