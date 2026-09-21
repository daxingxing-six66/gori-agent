import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { applySessionUpdate, mergeSessionUpdates, parseSessionUpdate } from "../features/workspace/model/session-update";
import { WorkspaceSessionEvents } from "../features/workspace/components/workspace-session-events";
import type { WorkspaceSessionTree } from "../features/workspace/model/workspace";

const state = vi.hoisted(() => ({ pathname: "/sessions/session-1", subscribe: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("../features/sftp/components/use-workspace-events", () => ({ useWorkspaceEvents: state.subscribe }));

const tree: WorkspaceSessionTree = { workspaces: [{
	workspace: { id: "workspace-1", displayName: "server", environment: "development", host: { hostname: "localhost", port: 22, hostKey: null }, activeCredentialId: "key", defaultCwd: "/tmp", connection: { connectTimeoutMs: 1000, keepaliveIntervalMs: 1000, keepaliveMaxCount: 3 }, revision: 1, createdAt: 1, updatedAt: 1 },
	sessions: [{ id: "session-1", workspaceId: "workspace-1", displayName: "新会话", workDir: "/tmp", autoAudit: false, terminalContextCursor: 4, revision: 1, createdAt: 1, updatedAt: 1 }],
}] };
const update = { id: "session-1", workspaceId: "workspace-1", displayName: "SSH 终端问题排查", revision: 2, updatedAt: 2 };

describe("Session title SSE projection", () => {
	it("updates the shared Session used by the sidebar and header without changing settings", () => {
		const next = applySessionUpdate(tree, update)!;
		expect(next.workspaces[0]!.sessions[0]).toEqual({ ...tree.workspaces[0]!.sessions[0], ...update });
		expect(tree.workspaces[0]!.sessions[0]!.displayName).toBe("新会话");
		expect(applySessionUpdate(next, { ...update, displayName: "stale", revision: 1 })).toEqual(next);
		expect(applySessionUpdate(next, { ...update, workspaceId: "other", revision: 3 })).toEqual(next);
	});

	it("does not roll back an SSE title on a late tree response, and accepts a newer manual rename", () => {
		const updated = applySessionUpdate(tree, update)!;
		expect(mergeSessionUpdates(updated, tree)).toEqual(updated);
		const renamed = applySessionUpdate(updated, { ...update, displayName: "手动标题", revision: 3 })!;
		expect(mergeSessionUpdates(updated, renamed)).toEqual(renamed);
		expect(mergeSessionUpdates(updated, { workspaces: [{ ...tree.workspaces[0]!, sessions: [] }] }).workspaces[0]!.sessions).toEqual([]);
	});

	it("validates new event payloads", () => {
		expect(parseSessionUpdate(update)).toEqual(update);
		for (const invalid of [null, {}, { ...update, revision: "2" }, { ...update, displayName: "" }, { ...update, revision: NaN }]) {
			expect(parseSessionUpdate(invalid)).toBeNull();
		}
	});

	it.each(["/sessions/session-1", "/workspaces/workspace-1/chat/new", "/workspaces/workspace-1"])("subscribes to the existing workspace endpoint from %s", (pathname) => {
		state.pathname = pathname; state.subscribe.mockClear();
		const onSession = vi.fn(); const onReady = vi.fn();
		renderToStaticMarkup(<WorkspaceSessionEvents tree={tree} onSession={onSession} onReady={onReady} />);
		expect(state.subscribe).toHaveBeenCalledExactlyOnceWith("workspace-1", ["sessions"], { onSession, onReady });
	});
});
