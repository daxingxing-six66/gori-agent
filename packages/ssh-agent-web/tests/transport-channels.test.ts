import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatEventStream } from "../features/chat/runtime/chat-event-stream";
import { subscribeDeploymentEvents } from "../features/deploy/runtime/deployment-event-stream";
import { openServerMetricsStream } from "../features/server-metrics/runtime/server-metrics-stream";
import { SessionActivityConnection } from "../features/session-activity/runtime/session-activity-connection";
import { SessionActivityStore } from "../features/session-activity/runtime/session-activity-store";
import { useWorkspaceEvents } from "../features/sftp/components/use-workspace-events";
import { TerminalEventStream } from "../features/terminal/runtime/terminal-event-stream";
import { apiRequest } from "../shared/api/client";
import { eventUrlWithLocale } from "../shared/events/client";

const effects = vi.hoisted(() => ({ cleanup: [] as (() => void)[] }));
vi.mock("react", () => ({
	useRef: (value: unknown) => ({ current: value }),
	useState: (value: unknown) => [value, () => {}],
	useEffect: (effect: () => (() => void) | void) => { const cleanup = effect(); if (cleanup) effects.cleanup.push(cleanup); },
}));
vi.mock("../features/i18n/components/locale-context", () => ({ useLocale: () => ({ locale: "en-US" }) }));

class TestEventSource extends EventTarget {
	static sources: TestEventSource[] = [];
	readonly url: string;
	onopen = null;
	onerror = null;
	close = vi.fn();
	constructor(url: string) { super(); this.url = url; TestEventSource.sources.push(this); }
}

afterEach(() => {
	for (const cleanup of effects.cleanup.splice(0)) cleanup();
	TestEventSource.sources = [];
	vi.unstubAllGlobals();
});

describe("browser transport channels", () => {
	it("routes every event adapter to the events origin and keeps REST on its request origin", async () => {
		vi.stubGlobal("EventSource", TestEventSource);
		const fetchMock = vi.fn(async () => Response.json({ providers: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const chat = new ChatEventStream("session / 1", "run / 1", "en-US");
		const terminal = new TerminalEventStream("session / 1", "attachment / 1", 9, "en-US");
		const activity = new SessionActivityConnection(new SessionActivityStore());
		activity.start();
		const closeMetrics = openServerMetricsStream({ workspaceId: "ws / 1", locale: "en-US", onSnapshot: vi.fn(), onConnection: vi.fn(), onError: vi.fn() });
		const closeDeploy = subscribeDeploymentEvents({ workspaceId: "ws / 1", sessionId: "session / 1", locale: "en-US",
			onRun: vi.fn(), onDiscussion: vi.fn(), onTask: vi.fn(), onLog: vi.fn(), onReconnect: vi.fn() });
		useWorkspaceEvents("ws / 1", ["sessions", "transfers"], {});
		try {
			const urls = TestEventSource.sources.map((source) => new URL(source.url));
			expect(urls).toHaveLength(6);
			expect(urls.every((url) => url.origin === "http://127.0.0.1:3002")).toBe(true);
			expect(urls.filter((url) => url.pathname !== "/api/session-activity/events").every((url) => url.searchParams.get("locale") === "en-US")).toBe(true);
			expect(urls[0]!.pathname).toBe("/api/sessions/session%20%2F%201/chat/runs/run%20%2F%201/events");
			expect(urls[1]!.searchParams.get("afterSequence")).toBe("9");
			expect(urls[5]!.searchParams.get("topics")).toBe("sessions,transfers");
			await apiRequest("/api/llm/providers");
			expect(fetchMock).toHaveBeenCalledWith("/api/llm/providers", expect.any(Object));
		} finally {
			chat.close(); terminal.close(); activity.stop(); closeMetrics(); closeDeploy();
			for (const cleanup of effects.cleanup.splice(0)) cleanup();
		}
		expect(TestEventSource.sources.every((source) => source.close.mock.calls.length === 1)).toBe(true);
	});

	it("preserves event cursors and replaces an existing locale without changing channels", () => {
		const url = new URL(eventUrlWithLocale("/api/sessions/s/terminal/attachments/a/events?afterSequence=12&locale=zh-CN", "en-US"));
		expect(url.origin).toBe("http://127.0.0.1:3002");
		expect(url.searchParams.get("afterSequence")).toBe("12");
		expect(url.searchParams.getAll("locale")).toEqual(["en-US"]);
	});
});
