import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentDiscussion, DeploymentDiscovery, DeploymentRun } from "../features/deploy/model/deployment";

type HistoryPage = { runs: DeploymentRun[]; nextCursor: string | null };

const api = vi.hoisted(() => ({
	discover: vi.fn<(sessionId: string) => Promise<DeploymentDiscovery>>(),
	history: vi.fn<(sessionId: string, cursor?: string) => Promise<HistoryPage>>(),
	get: vi.fn<(sessionId: string, id: string) => Promise<DeploymentRun>>(),
	getDiscussion: vi.fn<(sessionId: string, id: string) => Promise<DeploymentDiscussion>>(),
	activeDiscussion: vi.fn<(sessionId: string) => Promise<DeploymentDiscussion | null>>(),
	beginDiscussion: vi.fn<(sessionId: string, file: string, moduleId: string) => Promise<DeploymentDiscussion>>(),
	cancelDiscussion: vi.fn<(sessionId: string, id: string) => Promise<DeploymentDiscussion>>(),
}));

let hooks: HookDriver;
let workspaceIdForProbe: string | undefined;

vi.mock("react", async (importOriginal) => ({
	...await importOriginal<typeof import("react")>(),
	useState: (initial: unknown) => hooks.useState(initial),
	useRef: (initial: unknown) => hooks.useRef(initial),
	useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => hooks.useEffect(effect, deps),
	useCallback: <T,>(callback: T) => callback,
}));
vi.mock("../features/i18n/components/locale-context", () => ({ useLocale: () => ({ locale: "en-US" }) }));
vi.mock("../features/deploy/api/deployment-api", () => ({ deploymentApi: api }));

import { useDeployment } from "../features/deploy/runtime/use-deployment";

function DeploymentProbe() { return useDeployment("session", workspaceIdForProbe); }

class FakeEventSource {
	static current: FakeEventSource | null = null;
	private readonly listeners = new Map<string, Array<(event: Event) => void>>();
	constructor(_url: string) { FakeEventSource.current = this; }
	addEventListener(type: string, listener: (event: Event) => void): void {
		const callbacks = this.listeners.get(type) ?? [];
		callbacks.push(listener);
		this.listeners.set(type, callbacks);
	}
	emit(type: string, value: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(value) }));
	}
	close(): void { FakeEventSource.current = null; }
}

/** Runs hook effects after render while keeping async API responses under test control. */
class HookDriver {
	private readonly states: unknown[] = [];
	private readonly refs: { current: unknown }[] = [];
	private readonly effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
	private pendingEffects: Array<() => void> = [];
	private stateIndex = 0;
	private refIndex = 0;
	private effectIndex = 0;
	value!: ReturnType<typeof useDeployment>;

	useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void] {
		const index = this.stateIndex++;
		if (!(index in this.states)) this.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
		return [this.states[index] as T, (next) => {
			this.states[index] = typeof next === "function" ? (next as (current: T) => T)(this.states[index] as T) : next;
		}];
	}

	useRef<T>(initial: T): { current: T } {
		const index = this.refIndex++;
		this.refs[index] ??= { current: initial };
		return this.refs[index] as { current: T };
	}

	useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
		const index = this.effectIndex++;
		const previous = this.effects[index];
		if (previous && deps && previous.deps && deps.length === previous.deps.length &&
			deps.every((value, offset) => Object.is(value, previous.deps?.[offset]))) return;
		this.pendingEffects.push(() => {
			previous?.cleanup?.();
			const cleanup = effect();
			this.effects[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
		});
	}

	render(): ReturnType<typeof useDeployment> {
		this.stateIndex = this.refIndex = this.effectIndex = 0;
		this.value = DeploymentProbe();
		const pending = this.pendingEffects;
		this.pendingEffects = [];
		for (const run of pending) run();
		return this.value;
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => { resolve = complete; });
	return { promise, resolve };
}

async function settle() {
	for (let count = 0; count < 4; count++) await Promise.resolve();
}

const oldRun: DeploymentRun = {
	id: "old", sessionId: "session", workspaceId: "workspace", createdAt: 1, updatedAt: 1, status: "success",
	plan: {
		profilePath: "/project/.gori/deploy-example.md", profileHash: "hash", project: "example",
		remoteAccess: { mode: "workspace_write" }, target: { host: "example.org" },
		targetBinding: { port: 22, hostKeyFingerprint: "SHA256:test", credentialId: "credential", credentialAuthVersion: 1, remoteUser: "user", writableRoot: "/srv/app" },
		module: { id: "api", name: "API" }, build: { cwd: "/project", command: "build", artifact: "/project/app.tar.gz" },
		upload: { remotePath: "/srv/app/app.tar.gz" }, restart: { command: "restart" },
	},
	stages: {
		prepare: { status: "success", log: "" }, build: { status: "success", log: "" },
		upload: { status: "success", log: "" }, restart: { status: "success", log: "" },
		verify: { status: "skipped", log: "" },
	},
};

const discussion: DeploymentDiscussion = {
	id: "discussion-1", sessionId: "session", workspaceId: "workspace", status: "discussing", revision: 1,
	profileFile: "deploy-example.md", profileHash: "a".repeat(64), projectRoot: "/project", project: "example",
	module: { id: "api", name: "API" },
	targetBinding: { hostname: "example.org", port: 22, workspaceRevision: 1, hostKeyAlgorithm: "ssh-ed25519",
		hostKeyFingerprint: "SHA256:test", credentialId: "credential", credentialAuthVersion: 1, remoteUser: "user", writableRoot: "/srv/app" },
	createdAt: 2, updatedAt: 2,
};
const discovery = (host: string): DeploymentDiscovery => ({ host, profiles: [], errors: [], latest: oldRun, activeDiscussion: null });
const page: HistoryPage = { runs: [oldRun], nextCursor: null };

function proposal(planningAgentRunId: string): DeploymentRun {
	const plan = oldRun.plan;
	if (plan.version !== undefined) throw new Error("Expected a legacy fixture");
	const { build, upload, ...common } = plan;
	return { ...oldRun, id: "new", discussionId: discussion.id, createdAt: 3, updatedAt: 3, status: "preparing", planningAgentRunId,
		plan: { ...common, version: 2, buildSteps: [{ cwd: build.cwd, command: build.command }],
			artifacts: [{ source: build.artifact, remotePath: upload.remotePath }] } };
}

beforeEach(async () => {
	vi.resetAllMocks();
	workspaceIdForProbe = undefined;
	FakeEventSource.current = null;
	api.discover.mockResolvedValue(discovery("example.org"));
	api.history.mockResolvedValue(page);
	api.beginDiscussion.mockResolvedValue(discussion);
	api.getDiscussion.mockResolvedValue(discussion);
	api.activeDiscussion.mockResolvedValue(null);
	api.cancelDiscussion.mockResolvedValue({ ...discussion, status: "cancelled", revision: 2, updatedAt: 3 });
	hooks = new HookDriver();
	hooks.render();
	await settle();
	hooks.render();
});

afterEach(() => vi.unstubAllGlobals());

describe("deployment panel async selection", () => {
	it("ignores initial page discovery after an explicit /deploy has started", async () => {
		const initialDiscovery = deferred<DeploymentDiscovery>();
		vi.resetAllMocks();
		api.discover.mockReturnValueOnce(initialDiscovery.promise).mockResolvedValue(discovery("current.example.org"));
		api.history.mockResolvedValue(page);
		hooks = new HookDriver();
		hooks.render();

		await hooks.value.show();
		hooks.render();
		expect(hooks.value).toMatchObject({ open: true, run: null, loading: false });
		expect(hooks.value.discovery?.host).toBe("current.example.org");

		initialDiscovery.resolve(discovery("stale.example.org"));
		await settle();
		hooks.render();
		expect(hooks.value).toMatchObject({ open: true, run: null, loading: false });
		expect(hooks.value.discovery?.host).toBe("current.example.org");
	});

	it("keeps the newest /deploy discovery when an earlier open resolves last", async () => {
		const firstDiscovery = deferred<DeploymentDiscovery>();
		const firstHistory = deferred<HistoryPage>();
		const secondDiscovery = deferred<DeploymentDiscovery>();
		const secondHistory = deferred<HistoryPage>();
		api.discover.mockReturnValueOnce(firstDiscovery.promise).mockReturnValueOnce(secondDiscovery.promise);
		api.history.mockReturnValueOnce(firstHistory.promise).mockReturnValueOnce(secondHistory.promise);

		const firstOpen = hooks.value.show();
		hooks.render();
		expect(hooks.value).toMatchObject({ open: true, run: null, discovery: null, loading: true });
		const secondOpen = hooks.value.show();
		hooks.render();
		expect(hooks.value.freshOpenRevision).toBe(2);

		secondDiscovery.resolve(discovery("new.example.org"));
		secondHistory.resolve(page);
		await secondOpen;
		hooks.render();
		expect(hooks.value).toMatchObject({ open: true, run: null, loading: false });
		expect(hooks.value.discovery?.host).toBe("new.example.org");

		firstDiscovery.resolve(discovery("stale.example.org"));
		firstHistory.resolve(page);
		await firstOpen;
		hooks.render();
		expect(hooks.value).toMatchObject({ open: true, run: null, loading: false });
		expect(hooks.value.discovery?.host).toBe("new.example.org");
	});

	it("keeps a selected history run when a discussion creation resolves later", async () => {
		await hooks.value.show();
		hooks.render();
		const pendingDiscussion = deferred<DeploymentDiscussion>();
		api.beginDiscussion.mockReturnValueOnce(pendingDiscussion.promise);
		const creating = hooks.value.beginDiscussion(discussion.profileFile, discussion.module.id);

		api.get.mockResolvedValueOnce({ ...oldRun, updatedAt: 2 });
		await hooks.value.openHistory(oldRun.id);
		hooks.render();
		expect(hooks.value).toMatchObject({ readOnly: true, run: { id: "old", updatedAt: 2 } });

		pendingDiscussion.resolve(discussion);
		expect(await creating).toBeNull();
		hooks.render();
		expect(hooks.value).toMatchObject({ readOnly: true, run: { id: "old", updatedAt: 2 } });
		api.discover.mockResolvedValueOnce({ ...discovery("example.org"), activeDiscussion: discussion });
		await hooks.value.refresh();
		hooks.render();
		expect(hooks.value).toMatchObject({ readOnly: true, run: { id: "old", updatedAt: 2 } });
		expect(hooks.value.activeDiscussion?.id).toBe(discussion.id);
	});

	it("selects only a proposal bound to the durable discussion across Chat Runs", async () => {
		await hooks.value.show();
		hooks.render();
		await hooks.value.beginDiscussion(discussion.profileFile, discussion.module.id);
		hooks.render();
		expect(hooks.value.selectedDiscussion?.id).toBe(discussion.id);
		const unrelated = { ...proposal("other-agent"), discussionId: "other-discussion" };
		api.discover.mockResolvedValueOnce({ ...discovery("example.org"), latest: unrelated });
		api.history.mockResolvedValueOnce({ runs: [unrelated, oldRun], nextCursor: null });
		await hooks.value.refresh();
		hooks.render();
		expect(hooks.value.run).toBeNull();

		const matched = proposal("later-agent-run");
		api.discover.mockResolvedValueOnce({ ...discovery("example.org"), latest: matched });
		api.history.mockResolvedValueOnce({ runs: [matched, oldRun], nextCursor: null });
		await hooks.value.refresh();
		hooks.render();
		expect(hooks.value.run).toMatchObject({ id: "new", discussionId: discussion.id });
	});

	it("recovers a proposed plan after missing its SSE event", async () => {
		await hooks.value.beginDiscussion(discussion.profileFile, discussion.module.id);
		hooks.render();
		const proposed = proposal("later-agent-run");
		api.getDiscussion.mockResolvedValueOnce({ ...discussion, status: "proposed", revision: 2, updatedAt: 3, deploymentRunId: proposed.id });
		api.get.mockResolvedValueOnce(proposed);
		await hooks.value.refresh();
		hooks.render();
		expect(hooks.value.run?.id).toBe(proposed.id);
		expect(hooks.value.selectedDiscussion?.status).toBe("proposed");
	});

	it("restores an active discussion after remount and clears it only on explicit cancellation", async () => {
		api.discover.mockResolvedValueOnce({ ...discovery("example.org"), activeDiscussion: discussion });
		hooks = new HookDriver();
		hooks.render();
		await settle();
		hooks.render();
		expect(hooks.value).toMatchObject({ open: true, run: null, selectedDiscussion: { id: discussion.id } });
		await hooks.value.cancelDiscussion();
		hooks.render();
		expect(hooks.value.activeDiscussion).toBeNull();
		expect(hooks.value.selectedDiscussion).toBeNull();
	});

	it("opens a fresh module picker without cancelling the active discussion", async () => {
		await hooks.value.beginDiscussion(discussion.profileFile, discussion.module.id);
		hooks.render();
		expect(hooks.value.activeDiscussion?.id).toBe(discussion.id);
		api.discover.mockResolvedValueOnce({ ...discovery("example.org"), activeDiscussion: discussion });
		await hooks.value.show();
		hooks.render();
		expect(hooks.value.selectedDiscussion).toBeNull();
		expect(hooks.value.activeDiscussion?.id).toBe(discussion.id);
		expect(api.cancelDiscussion).not.toHaveBeenCalled();
		const replacement = { ...discussion, id: "discussion-2", createdAt: 4, updatedAt: 4 };
		api.beginDiscussion.mockResolvedValueOnce(replacement);
		await hooks.value.beginDiscussion(replacement.profileFile, replacement.module.id);
		hooks.render();
		expect(hooks.value.activeDiscussion?.id).toBe(replacement.id);
		expect(hooks.value.selectedDiscussion?.id).toBe(replacement.id);
	});

	it("keeps the discussion open when a model turn ends without a proposal", async () => {
		await hooks.value.beginDiscussion(discussion.profileFile, discussion.module.id);
		hooks.render();
		api.discover.mockResolvedValueOnce({ ...discovery("example.org"), activeDiscussion: { ...discussion, revision: 2, updatedAt: 3 } });
		api.history.mockResolvedValueOnce(page);
		await hooks.value.refresh();
		hooks.render();
		expect(hooks.value.run).toBeNull();
		expect(hooks.value.selectedDiscussion).toMatchObject({ id: discussion.id, status: "discussing", revision: 2 });
		expect(hooks.value.activeDiscussion?.id).toBe(discussion.id);
	});

	it("clears a selected discussion when another tab cancels it", async () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		workspaceIdForProbe = "workspace";
		hooks = new HookDriver();
		hooks.render();
		await settle();
		hooks.render();
		await hooks.value.beginDiscussion(discussion.profileFile, discussion.module.id);
		hooks.render();
		FakeEventSource.current?.emit("deployment.discussion.updated", { ...discussion, status: "cancelled", revision: 2, updatedAt: 3 });
		hooks.render();
		expect(hooks.value.selectedDiscussion).toBeNull();
		expect(hooks.value.activeDiscussion).toBeNull();
		expect(hooks.value.open).toBe(true);
	});

	it("uses the server's active discussion when cross-tab SSE events share timestamps", async () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		workspaceIdForProbe = "workspace";
		hooks = new HookDriver();
		hooks.render();
		await settle();
		hooks.render();
		const newer = { ...discussion, id: "discussion-newer" };
		api.beginDiscussion.mockResolvedValueOnce(newer);
		await hooks.value.beginDiscussion(newer.profileFile, newer.module.id);
		hooks.render();
		api.activeDiscussion.mockResolvedValueOnce(newer);
		FakeEventSource.current?.emit("deployment.discussion.updated", discussion);
		await settle();
		hooks.render();
		expect(hooks.value.activeDiscussion?.id).toBe(newer.id);
		expect(api.activeDiscussion).toHaveBeenCalledWith("session");
	});

	it("ignores an active-discussion lookup that resolves after a newer selection", async () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		workspaceIdForProbe = "workspace";
		hooks = new HookDriver();
		hooks.render();
		await settle();
		hooks.render();
		const second = { ...discussion, id: "discussion-2" };
		api.beginDiscussion.mockResolvedValueOnce(second);
		await hooks.value.beginDiscussion(second.profileFile, second.module.id);
		hooks.render();
		const pendingLookup = deferred<DeploymentDiscussion | null>();
		api.activeDiscussion.mockReturnValueOnce(pendingLookup.promise);
		FakeEventSource.current?.emit("deployment.discussion.updated", discussion);
		const third = { ...discussion, id: "discussion-3" };
		api.beginDiscussion.mockResolvedValueOnce(third);
		await hooks.value.beginDiscussion(third.profileFile, third.module.id);
		hooks.render();
		pendingLookup.resolve(second);
		await settle();
		hooks.render();
		expect(hooks.value.activeDiscussion?.id).toBe(third.id);
	});

	it("does not let a stale initial discovery hide an SSE-restored discussion", async () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		workspaceIdForProbe = "workspace";
		const initialDiscovery = deferred<DeploymentDiscovery>();
		api.discover.mockReturnValueOnce(initialDiscovery.promise);
		api.activeDiscussion.mockResolvedValueOnce(discussion);
		hooks = new HookDriver();
		hooks.render();
		FakeEventSource.current?.emit("deployment.discussion.updated", discussion);
		await settle();
		hooks.render();
		expect(hooks.value).toMatchObject({ open: true, selectedDiscussion: { id: discussion.id } });
		initialDiscovery.resolve(discovery("example.org"));
		await settle();
		hooks.render();
		expect(hooks.value.activeDiscussion?.id).toBe(discussion.id);
		expect(hooks.value.selectedDiscussion?.id).toBe(discussion.id);
	});

	it("does not bind an older module selection when its create response arrives last", async () => {
		const first = deferred<DeploymentDiscussion>();
		const second = deferred<DeploymentDiscussion>();
		api.beginDiscussion.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const firstRequest = hooks.value.beginDiscussion("deploy-old.md", "old");
		const secondRequest = hooks.value.beginDiscussion("deploy-new.md", "new");
		const newer = { ...discussion, id: "discussion-newer", profileFile: "deploy-new.md", module: { id: "new", name: "New" } };
		second.resolve(newer);
		expect(await secondRequest).toMatchObject({ id: newer.id });
		hooks.render();
		first.resolve(discussion);
		expect(await firstRequest).toBeNull();
		hooks.render();
		expect(hooks.value.activeDiscussion?.id).toBe(newer.id);
		expect(hooks.value.selectedDiscussion?.id).toBe(newer.id);
	});

	it("does not start a superseded discussion after another tab replaces it", async () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		workspaceIdForProbe = "workspace";
		hooks = new HookDriver();
		hooks.render();
		await settle();
		hooks.render();
		const pendingCreate = deferred<DeploymentDiscussion>();
		api.beginDiscussion.mockReturnValueOnce(pendingCreate.promise);
		const creating = hooks.value.beginDiscussion(discussion.profileFile, discussion.module.id);
		const replacement = { ...discussion, id: "discussion-from-other-tab" };
		api.activeDiscussion.mockResolvedValue(replacement);
		FakeEventSource.current?.emit("deployment.discussion.updated", replacement);
		await settle();

		pendingCreate.resolve(discussion);
		expect(await creating).toBeNull();
		hooks.render();
		expect(hooks.value.activeDiscussion?.id).toBe(replacement.id);
		expect(hooks.value.selectedDiscussion?.id).toBe(replacement.id);
		expect(api.activeDiscussion).toHaveBeenCalledTimes(2);
	});

	it("does not leave a closed panel loading after its discovery resolves", async () => {
		const pendingDiscovery = deferred<DeploymentDiscovery>();
		const pendingHistory = deferred<HistoryPage>();
		api.discover.mockReturnValueOnce(pendingDiscovery.promise);
		api.history.mockReturnValueOnce(pendingHistory.promise);
		const opening = hooks.value.show();
		hooks.render();
		expect(hooks.value.loading).toBe(true);

		hooks.value.hide();
		hooks.render();
		expect(hooks.value).toMatchObject({ open: false, loading: false });
		pendingDiscovery.resolve(discovery("stale.example.org"));
		pendingHistory.resolve(page);
		await opening;
		hooks.render();
		expect(hooks.value).toMatchObject({ open: false, loading: false, discovery: null });
	});
});
