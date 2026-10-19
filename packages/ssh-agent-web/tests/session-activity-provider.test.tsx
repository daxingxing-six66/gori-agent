import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionActivityStore } from "../features/session-activity/runtime/session-activity-store";

const route = vi.hoisted(() => ({ params: {} as { sessionId?: string } | null }));
const connection = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
let hooks: HookDriver;
vi.mock("next/navigation", () => ({ useParams: () => route.params }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useState: (initial: () => SessionActivityStore) => [hooks.store ??= initial(), () => {}],
	useEffect: (effect: () => (() => void), deps: readonly unknown[]) => hooks.effect(effect, deps),
}));
vi.mock("../features/session-activity/runtime/session-activity-connection", () => ({
	SessionActivityConnection: class { start = connection.start; stop = connection.stop; },
}));
import { SessionActivityProvider } from "../features/session-activity/components/session-activity-provider";

class HookDriver {
	store?: SessionActivityStore;
	private effects: { deps: readonly unknown[]; cleanup: () => void }[] = [];
	private index = 0;
	effect(effect: () => (() => void), deps: readonly unknown[]) {
		const index = this.index++, previous = this.effects[index];
		if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
		previous?.cleanup();
		this.effects[index] = { deps, cleanup: effect() };
	}
	render() { this.index = 0; SessionActivityProvider({ children: null }); return this.store!; }
	unmount() { for (const effect of this.effects) effect.cleanup(); this.effects = []; }
}

class TestDocument extends EventTarget {
	visibilityState: DocumentVisibilityState = "visible";
	setVisibility(state: DocumentVisibilityState) { this.visibilityState = state; this.dispatchEvent(new Event("visibilitychange")); }
}

const result = { sessionId: "session-a", workspaceId: "workspace-a", runId: "run-a", state: "completed" as const };
let page: TestDocument;
beforeEach(() => {
	vi.clearAllMocks();
	hooks = new HookDriver(); page = new TestDocument();
	route.params = { sessionId: "session-a" };
	vi.stubGlobal("document", page);
});
afterEach(() => { hooks.unmount(); vi.unstubAllGlobals(); });

describe("viewed session activity", () => {
	it("tracks navigation without reconnecting and leaves other sessions' success results unread", () => {
		const store = hooks.render();
		store.applySnapshot([result, { ...result, sessionId: "session-b", runId: "run-b" }]);
		expect(store.state("session-a")).toBe("idle");
		expect(store.state("session-b")).toBe("completed");
		route.params = { sessionId: "session-b" }; hooks.render();
		expect(store.state("session-b")).toBe("idle");
		store.applyUpdate({ sessionId: "session-a", runId: "next", activity: { ...result, runId: "next", state: "running" } });
		store.applyUpdate({ sessionId: "session-a", runId: "next", activity: { ...result, runId: "next" } });
		expect(store.state("session-a")).toBe("completed");
		expect(connection.start).toHaveBeenCalledOnce();
		expect(connection.stop).not.toHaveBeenCalled();
	});

	it("keeps background completions unread until the session becomes visible", () => {
		page.setVisibility("hidden");
		const store = hooks.render();
		store.applySnapshot([result]);
		expect(store.state("session-a")).toBe("completed");
		page.setVisibility("visible");
		expect(store.state("session-a")).toBe("idle");
		page.setVisibility("hidden");
		store.applySnapshot([{ ...result, runId: "background" }]);
		expect(store.state("session-a")).toBe("completed");
		page.setVisibility("visible");
		expect(store.state("session-a")).toBe("idle");
	});

	it.each([{}, null])("stops automatic acknowledgement on a page without a session: %s", (params) => {
		const store = hooks.render();
		route.params = params; hooks.render();
		store.applySnapshot([result]);
		expect(store.state("session-a")).toBe("completed");
		page.setVisibility("hidden"); page.setVisibility("visible");
		expect(store.state("session-a")).toBe("completed");
	});

	it("releases visibility listeners and viewed-session presence on unmount", () => {
		const store = hooks.render();
		hooks.unmount();
		page.setVisibility("hidden"); page.setVisibility("visible");
		store.applySnapshot([result]);
		expect(store.state("session-a")).toBe("completed");
		expect(connection.stop).toHaveBeenCalledOnce();
	});
});
