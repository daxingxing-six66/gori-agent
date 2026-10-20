import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentDiscussion, DeploymentDiscovery, DeploymentRun } from "../features/deploy/model/deployment";
import type { DeploymentTask } from "../features/deploy/model/deployment-task";

type HistoryPage = { runs: DeploymentRun[]; nextCursor: string | null };

const api = vi.hoisted(() => ({
	mode: vi.fn<(sessionId: string) => Promise<DeploymentTask | null>>(),
	task: vi.fn<(sessionId: string, id: string) => Promise<DeploymentTask>>(),
	finish: vi.fn<(sessionId: string, id: string, outcome: "cancelled" | "failed") => Promise<DeploymentTask>>(),
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
let sessionIdForProbe = "session";

vi.mock("react", async (importOriginal) => ({
	...await importOriginal<typeof import("react")>(),
	useState: (initial: unknown) => hooks.useState(initial),
	useRef: (initial: unknown) => hooks.useRef(initial),
	useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => hooks.useEffect(effect, deps),
	useCallback: <T,>(callback: T, deps?: readonly unknown[]) => hooks.useMemo(() => callback, deps),
	useMemo: <T,>(factory: () => T, deps?: readonly unknown[]) => hooks.useMemo(factory, deps),
}));
vi.mock("../features/i18n/components/locale-context", () => ({ useLocale: () => ({ locale: "en-US" }) }));
vi.mock("../features/deploy/api/deployment-api", () => ({ deploymentApi: api }));

import { ApiError } from "../shared/errors/api-error";
import { useDeployment } from "../features/deploy/runtime/use-deployment";

function DeploymentProbe() { return useDeployment(sessionIdForProbe, workspaceIdForProbe); }

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
	private memoIndex = 0;
	private readonly memos: { deps?: readonly unknown[]; value: unknown }[] = [];
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
	useMemo<T>(factory: () => T, deps?: readonly unknown[]): T {
		const index = this.memoIndex++;
		const previous = this.memos[index];
		if (!previous || !deps || !previous.deps || !deps.every((value, offset) => Object.is(value, previous.deps?.[offset])))
			this.memos[index] = { deps, value: factory() };
		return this.memos[index]!.value as T;
	}

	render(): ReturnType<typeof useDeployment> {
		this.stateIndex = this.refIndex = this.effectIndex = this.memoIndex = 0;
		this.value = DeploymentProbe();
		const pending = this.pendingEffects;
		this.pendingEffects = [];
		for (const run of pending) run();
		return this.value;
	}
	unmount(): void { for (const effect of this.effects) effect.cleanup?.(); }
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => { resolve = complete; });
	return { promise, resolve };
}

async function settle() {
	for (let count = 0; count < 20; count++) await Promise.resolve();
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


const activeTask = (item = discussion, run: DeploymentRun | null = null): DeploymentTask => ({
 deployment: { id: item.id, title: item.module.name, sessionId: item.sessionId, workspaceId: item.workspaceId, createdAt: item.createdAt },
 run, phase: run ? "review" : "discussion", stage: run ? "prepare" : null, stageStatus: run ? "success" : null, nextStage: run ? "build" : null,
});
const finishedTask = (run = oldRun): DeploymentTask => ({ ...activeTask({ ...discussion, id: run.id }, run), phase: "finished",
 deployment: { ...activeTask({ ...discussion, id: run.id }).deployment, createdAt: run.createdAt, outcome: "success", finishedAt: 10 } });
const missing = () => new ApiError(404, "not_found", "Legacy record has no deployment mode");
async function renderSettled() { for (let count = 0; count < 3; count++) { await settle(); hooks.render(); } }

beforeEach(async () => {
 vi.resetAllMocks();
 workspaceIdForProbe = undefined; sessionIdForProbe = "session"; FakeEventSource.current = null;
 api.discover.mockResolvedValue(discovery("example.org")); api.mode.mockResolvedValue(null);
 api.task.mockRejectedValue(missing()); api.history.mockResolvedValue(page); api.get.mockResolvedValue(oldRun);
 api.beginDiscussion.mockResolvedValue(discussion); api.getDiscussion.mockResolvedValue(discussion);
 hooks = new HookDriver(); hooks.render(); await renderSettled();
});
afterEach(() => { hooks.unmount(); vi.unstubAllGlobals(); });

describe("deployment task selection and durable mode", () => {
 it("opens module selection above the Composer without creating a task tab or deployment", async () => {
  expect(await hooks.value.show()).toBe("picker"); hooks.render();
  expect(hooks.value).toMatchObject({ pickerOpen: true, pickerLoading: false, open: false });
  expect(api.beginDiscussion).not.toHaveBeenCalled(); expect(api.finish).not.toHaveBeenCalled();
  hooks.value.closePicker(); hooks.render(); expect(hooks.value.pickerOpen).toBe(false);
 });

 it("keeps a displayed historical task while opening the module picker", async () => {
  api.task.mockResolvedValue(finishedTask()); await hooks.value.openHistory(oldRun.id); hooks.render();
  await hooks.value.show(); hooks.render();
  expect(hooks.value).toMatchObject({ pickerOpen: true, open: true, run: { id: oldRun.id } });
 });

 it("does not reopen either surface after the picker closes during a mode lookup", async () => {
  const pending = deferred<DeploymentTask | null>(); api.mode.mockReturnValueOnce(pending.promise);
  const opening = hooks.value.show(); hooks.render();
  hooks.value.closePicker(); hooks.render(); pending.resolve(activeTask());
  expect(await opening).toBeUndefined(); await renderSettled();
  expect(hooks.value).toMatchObject({ open: false, pickerOpen: false, pickerLoading: false });
 });

 it("moves from selection to the existing task only after a module is explicitly chosen", async () => {
  await hooks.value.show(); hooks.render(); api.mode.mockResolvedValue(activeTask());
  expect(await hooks.value.beginDiscussion(discussion.profileFile, discussion.module.id)).toEqual(discussion); hooks.render();
  expect(hooks.value).toMatchObject({ open: true, pickerOpen: false, selectedDiscussion: { id: discussion.id } });
 });

 it("keeps mode lookup errors in the picker and allows a clean retry", async () => {
  api.mode.mockRejectedValueOnce(new Error("Mode unavailable")); await hooks.value.show(); hooks.render();
  expect(hooks.value).toMatchObject({ pickerOpen: true, pickerLoading: false, open: false, error: "Mode unavailable" });
  await hooks.value.show(); hooks.render(); expect(hooks.value.error).toBeNull();
 });

 it("restores server mode over older discovery, closes only the page and reopens that identity", async () => {
  api.mode.mockResolvedValue(activeTask()); api.task.mockResolvedValue(activeTask());
  hooks = new HookDriver(); hooks.render(); await renderSettled();
  expect(hooks.value).toMatchObject({ open: true, activeTask: { deployment: { id: discussion.id } }, selectedDiscussion: { id: discussion.id } });
  hooks.value.hide(); hooks.render();
  expect(hooks.value.open).toBe(false); expect(hooks.value.activeTask?.deployment.id).toBe(discussion.id); expect(api.finish).not.toHaveBeenCalled();
  await hooks.value.show(); hooks.render();
  expect(hooks.value).toMatchObject({ open: true, selectedTask: { deployment: { id: discussion.id } } });
 });

 it("opens old history without changing the current mode or its approval target", async () => {
  const run = { ...proposal("agent"), id: discussion.id };
  api.mode.mockResolvedValue(activeTask(discussion, run)); api.task.mockResolvedValue(finishedTask());
  hooks = new HookDriver(); hooks.render(); await renderSettled();
  await hooks.value.openHistory(oldRun.id); hooks.render();
  expect(hooks.value.run?.id).toBe(oldRun.id); expect(hooks.value.activeTask?.run?.id).toBe(discussion.id);
  expect(api.beginDiscussion).not.toHaveBeenCalled(); expect(api.finish).not.toHaveBeenCalled();
 });

 it("does not reactivate a finished deployment after delayed starts or stale mode replies", async () => {
  vi.stubGlobal("EventSource", FakeEventSource); workspaceIdForProbe = "workspace";
  api.mode.mockResolvedValue(activeTask()); hooks = new HookDriver(); hooks.render(); await renderSettled();
  const pending = deferred<DeploymentTask | null>(); api.mode.mockReturnValueOnce(pending.promise);
  const opening = hooks.value.show();
  const ended: DeploymentTask = { ...activeTask(), phase: "finished", deployment: { ...activeTask().deployment, outcome: "cancelled", finishedAt: 10 } };
  FakeEventSource.current?.emit("deployment.finished", ended); hooks.render();
  pending.resolve(activeTask()); await opening; hooks.render(); expect(hooks.value.activeTask).toBeNull();
  api.mode.mockResolvedValue(null); FakeEventSource.current?.emit("deployment.started", activeTask()); await renderSettled();
  expect(hooks.value.activeTask).toBeNull(); expect(hooks.value.selectedTask?.deployment.outcome).toBe("cancelled");
 });

 it("does not replace a selected page when initial discovery resolves late", async () => {
  const initial = deferred<DeploymentDiscovery>(); api.discover.mockReturnValueOnce(initial.promise);
  hooks = new HookDriver(); hooks.render();
  api.task.mockResolvedValue(finishedTask()); await hooks.value.openHistory(oldRun.id); hooks.render();
  initial.resolve({ ...discovery("stale.example.org"), activeDiscussion: discussion }); await renderSettled();
  expect(hooks.value.run?.id).toBe(oldRun.id); expect(hooks.value.selectedDiscussion).toBeNull();
 });

 it("keeps the newest open intent when two mode lookups finish in reverse order", async () => {
  const first = deferred<DeploymentTask | null>(); const second = deferred<DeploymentTask | null>();
  api.mode.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const opening1 = hooks.value.show(); hooks.render(); const opening2 = hooks.value.show();
  second.resolve(activeTask()); await opening2; hooks.render(); expect(hooks.value.selectedDiscussion?.id).toBe(discussion.id);
  first.resolve(null); await opening1; hooks.render(); expect(hooks.value.selectedTask?.deployment.id).toBe(discussion.id);
 });

 it("does not reopen a page closed while its lookup is pending", async () => {
  const pending = deferred<DeploymentTask | null>(); api.mode.mockReturnValueOnce(pending.promise);
  const opening = hooks.value.show(); hooks.render(); expect(hooks.value.pickerLoading).toBe(true);
  hooks.value.hide(); hooks.render(); pending.resolve(activeTask()); await opening; await renderSettled();
  expect(hooks.value).toMatchObject({ open: false, loading: false }); expect(hooks.value.activeTask?.deployment.id).toBe(discussion.id);
 });

 it("does not start a planning Chat Run after history selection supersedes creation", async () => {
  const pending = deferred<DeploymentDiscussion>(); api.beginDiscussion.mockReturnValueOnce(pending.promise);
  const creating = hooks.value.beginDiscussion(discussion.profileFile, discussion.module.id);
  api.task.mockResolvedValue(finishedTask()); await hooks.value.openHistory(oldRun.id); hooks.render();
  api.mode.mockResolvedValue(activeTask()); pending.resolve(discussion); expect(await creating).toBeNull(); hooks.render();
  expect(hooks.value.run?.id).toBe(oldRun.id); expect(hooks.value.activeTask?.deployment.id).toBe(discussion.id);
 });

 it("coalesces double module clicks without invalidating the first planning request", async () => {
  const pending = deferred<DeploymentDiscussion>(); api.beginDiscussion.mockReturnValueOnce(pending.promise); api.mode.mockResolvedValue(activeTask());
  const first = hooks.value.beginDiscussion(discussion.profileFile, discussion.module.id);
  expect(await hooks.value.beginDiscussion(discussion.profileFile, discussion.module.id)).toBeNull();
  pending.resolve(discussion); expect(await first).toEqual(discussion); hooks.render(); expect(api.beginDiscussion).toHaveBeenCalledTimes(1);
 });

 it("does not start planning for a deployment already ended or replaced by another tab", async () => {
  api.mode.mockResolvedValue(activeTask({ ...discussion, id: "other" }));
  expect(await hooks.value.beginDiscussion(discussion.profileFile, discussion.module.id)).toBeNull(); hooks.render();
  expect(hooks.value.activeTask?.deployment.id).toBe("other");
 });

 it("binds plans across Chat Runs by deployment identity and rejects older snapshots", async () => {
  vi.stubGlobal("EventSource", FakeEventSource); workspaceIdForProbe = "workspace";
  api.mode.mockResolvedValue(activeTask()); hooks = new HookDriver(); hooks.render(); await renderSettled();
  FakeEventSource.current?.emit("deployment.updated", { ...proposal("unrelated"), discussionId: "other-discussion" }); hooks.render();
  expect(hooks.value.run).toBeNull();
  const plan = { ...proposal("later-agent"), id: discussion.id, updatedAt: 8 };
  FakeEventSource.current?.emit("deployment.updated", plan); hooks.render(); expect(hooks.value.run?.updatedAt).toBe(8);
  api.task.mockResolvedValue(activeTask(discussion, { ...plan, updatedAt: 4 }));
  await hooks.value.openHistory(discussion.id); hooks.render(); expect(hooks.value.run?.updatedAt).toBe(8);
 });

 it("recovers missed proposal events through a reconnect without duplicating subscriptions", async () => {
  vi.stubGlobal("EventSource", FakeEventSource); workspaceIdForProbe = "workspace";
  api.mode.mockResolvedValue(activeTask()); hooks = new HookDriver(); hooks.render(); await renderSettled();
  const stream = FakeEventSource.current; const plan = { ...proposal("later-agent"), id: discussion.id };
  api.mode.mockResolvedValue(activeTask(discussion, plan)); api.task.mockResolvedValue(activeTask(discussion, plan));
  stream?.emit("stream.ready", {}); await renderSettled();
  expect(hooks.value.run?.id).toBe(discussion.id); expect(FakeEventSource.current).toBe(stream);
 });

 it("does not request a separate history page for the Chat timeline", async () => {
  await hooks.value.refresh(); await hooks.value.show(); hooks.render();
  expect(api.history).not.toHaveBeenCalled();
 });

 it("discards pending responses and errors from the previous Session", async () => {
  const pending = deferred<DeploymentTask | null>(); api.mode.mockReturnValueOnce(pending.promise);
  const opening = hooks.value.show(); hooks.render();
  sessionIdForProbe = "session-2"; hooks.render(); await renderSettled();
  pending.resolve(activeTask()); await opening; await renderSettled();
  expect(hooks.value).toMatchObject({ open: false, activeTask: null, error: null });
 });

 it("replays explicit exit only once and retains the returned historical task", async () => {
  api.mode.mockResolvedValue(activeTask()); hooks = new HookDriver(); hooks.render(); await renderSettled();
  const ended: DeploymentTask = { ...activeTask(), phase: "finished", deployment: { ...activeTask().deployment, outcome: "cancelled", finishedAt: 10 } };
  api.finish.mockResolvedValue(ended); await hooks.value.finish(); hooks.render();
  expect(hooks.value.activeTask).toBeNull(); expect(hooks.value.selectedTask?.deployment.outcome).toBe("cancelled");
  await hooks.value.finish(); expect(api.finish).toHaveBeenCalledTimes(1);
 });
});
