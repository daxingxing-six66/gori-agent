import { Children, isValidElement, type ChangeEvent, type ComponentProps, type SubmitEvent, type MouseEvent, type ReactElement, type ReactNode, type KeyboardEvent } from "react";
import { createIntl } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentRun } from "../features/deploy/model/deployment";
import type { DeploymentLogChunk, DeploymentTask } from "../features/deploy/model/deployment-task";
import { DeploymentLogStore } from "../features/deploy/runtime/deployment-log-store";
import { enUSMessages } from "../features/i18n/messages/en-US";

let host: ComponentHost;
const intl = createIntl({ locale: "en-US", messages: enUSMessages });
vi.mock("react-intl", async (original) => ({ ...await original<typeof import("react-intl")>(), useIntl: () => intl }));
vi.mock("react", async (original) => ({
 ...await original<typeof import("react")>(),
 useId: () => host.memo(() => "picker-title", []),
 useState: (initial: unknown) => host.state(initial), useRef: (initial: unknown) => host.ref(initial),
 useMemo: <T,>(factory: () => T, deps?: readonly unknown[]) => host.memo(factory, deps),
 useCallback: <T,>(callback: T, deps?: readonly unknown[]) => host.memo(() => callback, deps),
 useEffect: (effect: Effect, deps?: readonly unknown[]) => host.effect(effect, deps, false),
 useLayoutEffect: (effect: Effect, deps?: readonly unknown[]) => host.effect(effect, deps, true),
 useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
import { DeploymentPipeline } from "../features/deploy/components/deployment-pipeline";
import { DeploymentReview } from "../features/deploy/components/deployment-review";
import { deploymentReviewState } from "../features/deploy/model/deployment-review";
import { useDeploymentExecution } from "../features/deploy/runtime/use-deployment-execution";
import { DeploymentTaskPage } from "../features/deploy/components/deployment-task-page";
import { DeploymentModulePicker } from "../features/deploy/components/deployment-module-picker";
import { DeploymentLogs } from "../features/deploy/components/deployment-logs";
import { DeploymentBuildSteps } from "../features/deploy/components/deployment-build-steps";

type Effect = () => void | (() => void);
/** Exercises real handlers and commit order in Node, without a browser or network. */
class ComponentHost {
 private slots: unknown[] = []; private cursor = 0;
 private effects: (() => void)[] = []; private layouts: (() => void)[] = [];
 private cleanups = new Map<number, () => void>();
 render(component: () => ReactNode): ReactNode { this.cursor = 0; return component(); }
 state<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void] {
  const index = this.cursor++;
  if (!(index in this.slots)) this.slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
  return [this.slots[index] as T, (next) => { this.slots[index] = typeof next === "function" ? (next as (current: T) => T)(this.slots[index] as T) : next; }];
 }
 ref<T>(initial: T): { current: T } { const index = this.cursor++; if (!(index in this.slots)) this.slots[index] = { current: initial }; return this.slots[index] as { current: T }; }
 memo<T>(factory: () => T, deps?: readonly unknown[]): T {
  const index = this.cursor++; const saved = this.slots[index] as { deps?: readonly unknown[]; value: T } | undefined;
  if (!saved || !same(saved.deps, deps)) this.slots[index] = { deps, value: factory() };
  return (this.slots[index] as { value: T }).value;
 }
 effect(effect: Effect, deps: readonly unknown[] | undefined, layout: boolean): void {
  const index = this.cursor++; const saved = this.slots[index] as { deps?: readonly unknown[] } | undefined;
  if (saved && same(saved.deps, deps)) return;
  this.slots[index] = { deps };
  (layout ? this.layouts : this.effects).push(() => { this.cleanups.get(index)?.(); const cleanup = effect();
   if (cleanup) this.cleanups.set(index, cleanup); else this.cleanups.delete(index); });
 }
 commit(): void { this.flushLayout(); const effects = this.effects; this.effects = []; for (const effect of effects) effect(); }
 flushLayout(): void { const effects = this.layouts; this.layouts = []; for (const effect of effects) effect(); }
 dispose(): void { for (const cleanup of this.cleanups.values()) cleanup(); }
}
function same(a?: readonly unknown[], b?: readonly unknown[]): boolean { return Boolean(a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))); }
function elements(node: ReactNode): ReactElement<{ children?: ReactNode; className?: string }>[] {
 const result: ReactElement<{ children?: ReactNode; className?: string }>[] = [];
 Children.forEach(node, (child) => { if (isValidElement<{ children?: ReactNode; className?: string }>(child)) result.push(child, ...elements(child.props.children)); });
 return result;
}
function native<T extends "textarea" | "form" | "button" | "input" | "li" | "div" | "span" | "pre" | "code">(node: ReactNode, type: T): ReactElement<ComponentProps<T>>[] {
 return elements(node).filter((item) => item.type === type) as ReactElement<ComponentProps<T>>[];
}
function click(node: ReactElement<ComponentProps<"button">>) { node.props.onClick?.({} as MouseEvent<HTMLButtonElement>); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const run: DeploymentRun = {
 id: "deployment", sessionId: "session", workspaceId: "workspace", status: "running", createdAt: 1, updatedAt: 20,
 plan: { version: 2, project: "example", module: { id: "api", name: "API" }, profilePath: "/project/.gori/deploy-example.md", profileHash: "hash",
  target: { host: "example.org" }, targetBinding: { port: 22, credentialId: "key", credentialAuthVersion: 1, remoteUser: "test", hostKeyFingerprint: "SHA256:test", writableRoot: "/srv/app" },
  remoteAccess: { mode: "workspace_write" }, buildSteps: [{ cwd: "/project", command: "build" }], artifacts: [{ source: "/project/api.jar", remotePath: "/srv/app/api.jar" }], restart: { command: "restart" } },
 stages: { prepare: { status: "success", log: "" }, build: { status: "success", log: "", logCursor: 3, executionId: "build-2" },
  upload: { status: "running", log: "" }, restart: { status: "pending", log: "" }, verify: { status: "pending", log: "" } },
};
const task: DeploymentTask = { deployment: { id: run.id, sessionId: "session", workspaceId: "workspace", title: "API", createdAt: 1 }, run, phase: "execution", stage: "upload", stageStatus: "running", nextStage: "restart" };
function pageProps(): ComponentProps<typeof DeploymentTaskPage> { return { sessionId: "session", task, run, discussion: null,
 logs: new DeploymentLogStore("session", async (_s, _r, _t, cursor) => ({ chunks: [], nextSequence: cursor, hasMore: false })),
 loading: false, busy: false, error: null, fullscreen: true, pending: true,
 onReturnConversation: vi.fn(), onExit: vi.fn(), onSubmit: vi.fn(async () => true) }; }
function page(props: ComponentProps<typeof DeploymentTaskPage>) { return host.render(() => DeploymentTaskPage(props)); }
function typeDraft(view: ReactNode, value: string) { native(view, "textarea")[0]!.props.onChange?.({ target: { value } } as ChangeEvent<HTMLTextAreaElement>); }
async function submit(view: ReactNode) { await native(view, "form")[0]!.props.onSubmit?.({ preventDefault() {} } as SubmitEvent<HTMLFormElement>); }
beforeEach(() => {
 host = new ComponentHost();
 vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { host.dispose(); vi.unstubAllGlobals(); });

describe("deployment page interaction", () => {

	it("only submits the confirmed bound plan on click, locks duplicate starts and waits for backend facts", async () => {
		const pending = deferred<Awaited<ReturnType<Parameters<typeof useDeploymentExecution>[0]["submit"]>>>();
		const plan = { ...run, status: "preparing" as const };
		const options: Parameters<typeof useDeploymentExecution>[0] = { sessionId: "session", run: plan,
			model: { providerId: "test", id: "model" }, thinkingLevel: "off", serverInteractionMode: "terminal", disabled: false,
			submit: vi.fn(() => pending.promise), refresh: vi.fn(async () => undefined), setError: vi.fn() };
		const render = () => { let result!: ReturnType<typeof useDeploymentExecution>; host.render(() => { result = useDeploymentExecution(options); return null; }); return result; };
		let execution = render(); host.commit();
		expect(options.submit).not.toHaveBeenCalled();
		const first = execution.start(); const duplicate = execution.start();
		expect(options.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workflow: "deployment_execution", deploymentRunId: plan.id, serverInteractionMode: "terminal" }));
		expect(options.refresh).not.toHaveBeenCalled();
		execution = render(); expect(execution.starting).toBe(true);
		expect(plan.status).toBe("preparing");
		pending.resolve({ id: "agent" } as Awaited<ReturnType<typeof options.submit>>);
		await Promise.all([first, duplicate]);
		expect(options.refresh).toHaveBeenCalledOnce(); expect(render().starting).toBe(false);
	});

	it("keeps a failed start retryable and ignores an old Session's late response", async () => {
		const pending = deferred<Awaited<ReturnType<Parameters<typeof useDeploymentExecution>[0]["submit"]>>>();
		let options: Parameters<typeof useDeploymentExecution>[0] = { sessionId: "session", run: { ...run, status: "preparing" },
			model: { providerId: "test", id: "model" }, thinkingLevel: "off", serverInteractionMode: "command", disabled: false,
			submit: vi.fn(async () => null), refresh: vi.fn(async () => undefined), setError: vi.fn() };
		const render = () => { let result!: ReturnType<typeof useDeploymentExecution>; host.render(() => { result = useDeploymentExecution(options); return null; }); return result; };
		let execution = render(); host.commit(); await execution.start();
		expect(render().starting).toBe(false); expect(options.setError).toHaveBeenLastCalledWith("Deployment did not start. Try again.");
		options.submit = vi.fn(() => pending.promise); const old = options;
		execution = render(); const staleHandler = execution.start; const sending = execution.start();
		options = { ...options, sessionId: "next", submit: vi.fn(async () => null), setError: vi.fn(), refresh: vi.fn(async () => undefined) };
		expect(render().starting).toBe(false); host.commit();
		await staleHandler(); expect(options.submit).not.toHaveBeenCalled();
		pending.resolve({ id: "old-agent" } as Awaited<ReturnType<typeof options.submit>>); await sending;
		expect(old.refresh).not.toHaveBeenCalled(); expect(options.setError).not.toHaveBeenCalled();
	});

	it("blocks the plan action while busy or awaiting permission and keeps permission decisions separate", () => {
		const plan: DeploymentRun = { ...run, status: "preparing" };
		const value = { run: plan, review: deploymentReviewState(plan), busy: false, canConfirm: true,
			onConfirm: vi.fn(), onReviewPermissions: vi.fn(), onDecideRecovery: vi.fn() };
		const view = DeploymentReview(value);
		click(native(view, "button").find((item) => item.props.className === "deploy-plan-start")!);
		expect(value.onConfirm).toHaveBeenCalledOnce();
		const gated = DeploymentReview({ ...value, review: { ...value.review!, pendingExceptions: ["restart"] } });
		const start = native(gated, "button").find((item) => item.props.className === "deploy-plan-start")!;
		expect(start.props.disabled).toBe(true); click(start); expect(value.onConfirm).toHaveBeenCalledOnce();
		click(native(gated, "button").find((item) => item.props.className === "deploy-plan-permissions")!);
		expect(value.onReviewPermissions).toHaveBeenCalledOnce();
		expect(native(gated, "button").every((item) => item.props.children !== "Approve this command")).toBe(true);
	});
 it("keeps selected build logs while execution advances and retains all four log pages", () => {
  const props = pageProps(); let view = host.render(() => DeploymentPipeline({ run: props.run!, task: props.task, logs: props.logs })); host.commit();
  click(native(view, "button").find((item) => elements(item.props.children).some((child) => child.props.children === "Build"))!);
  props.run = { ...run, updatedAt: 21, stages: { ...run.stages, upload: { status: "success", log: "" }, restart: { status: "running", log: "" } } };
  view = host.render(() => DeploymentPipeline({ run: props.run!, task: props.task, logs: props.logs }));
  const stages = native(view, "li") as ReactElement<{ "data-current": boolean; "data-selected": boolean }>[];
  expect(stages.map((item) => item.props["data-current"])).toEqual([false, false, false, true, false]);
  expect(stages.map((item) => item.props["data-selected"])).toEqual([false, true, false, false, false]);
  const pages = native(view, "div").filter((item) => item.props.className === "deploy-stage-log-page");
  expect(pages).toHaveLength(4); expect(pages.filter((item) => !item.props.hidden)).toHaveLength(1); expect(pages[0]?.key).toBe(`${run.id}:build`);
 });
 it("opens preparation without changing execution and restores the same log pages when returning", () => {
  const props = pageProps();
  const render = () => host.render(() => DeploymentPipeline({ run: props.run!, task: props.task, logs: props.logs }));
  let view = render(); host.commit();
  const pagesBefore = native(view, "div").filter((item) => item.props.className === "deploy-stage-log-page");
  click(native(view, "button").find((item) => elements(item.props.children).some((child) => child.props.children === "Prepare"))!);
  view = render();
  expect(elements(view).some((item) => item.props.className === "deploy-stage-plan")).toBe(true);
  expect(native(view, "div").find((item) => item.props.className === "deploy-stage-logs")?.props.hidden).toBe(true);
  const stages = native(view, "li") as ReactElement<{ "data-current": boolean; "data-selected": boolean }>[];
  expect(stages.map((item) => item.props["data-current"])).toEqual([false, false, true, false, false]);
  expect(stages.map((item) => item.props["data-selected"])).toEqual([true, false, false, false, false]);
  click(native(view, "button").find((item) => elements(item.props.children).some((child) => child.props.children === "Upload"))!);
  view = render();
  expect(native(view, "div").find((item) => item.props.className === "deploy-stage-logs")?.props.hidden).toBe(false);
  expect(native(view, "div").filter((item) => item.props.className === "deploy-stage-log-page").map((item) => item.key)).toEqual(pagesBefore.map((item) => item.key));
  expect(props.run!.stages.upload.status).toBe("running");
 });
 it("retains a draft while its mounted page switches between docked and enlarged presentation", () => {
  const props = pageProps(); let view = page(props); host.commit(); typeDraft(view, "Keep this requirement");
  props.fullscreen = false; view = page(props); expect(native(view, "form")[0]?.props.hidden).toBe(true);
  expect(native(view, "textarea")[0]?.props.value).toBe("Keep this requirement");
  props.fullscreen = true; view = page(props); expect(native(view, "textarea")[0]?.props.value).toBe("Keep this requirement"); expect(props.onSubmit).not.toHaveBeenCalled();
 });
 it("blocks duplicate submit events before the next render and clears only the sent draft", async () => {
  const props = pageProps(); const pending = deferred<boolean>(); props.onSubmit = vi.fn(() => pending.promise);
  let view = page(props); host.commit(); typeDraft(view, "Check the build"); view = page(props);
  const first = submit(view); const duplicate = submit(view); expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("Check the build");
  pending.resolve(true); await Promise.all([first, duplicate]); view = page(props); expect(native(view, "textarea")[0]?.props.value).toBe("");
 });
 it("preserves text entered while the previous suggestion is being sent", async () => {
  const props = pageProps(); const pending = deferred<boolean>(); props.onSubmit = vi.fn(() => pending.promise);
  let view = page(props); host.commit(); typeDraft(view, "First requirement"); view = page(props);
  const sending = submit(view); view = page(props); typeDraft(view, "Additional requirement");
  pending.resolve(true); await sending; view = page(props); expect(native(view, "textarea")[0]?.props.value).toBe("Additional requirement");
 });
 it("retains a rejected draft and ignores a prior Session's late response", async () => {
  const props = pageProps(); props.onSubmit = vi.fn(async () => false);
  let view = page(props); host.commit(); typeDraft(view, "Retry requirement"); view = page(props); await submit(view);
  view = page(props); expect(native(view, "textarea")[0]?.props.value).toBe("Retry requirement");
  const pending = deferred<boolean>(); props.onSubmit = vi.fn(() => pending.promise); view = page(props); const sending = submit(view);
  props.sessionId = "session-2"; page(props); host.commit(); view = page(props); typeDraft(view, "New Session requirement");
  pending.resolve(true); await sending; view = page(props); expect(native(view, "textarea")[0]?.props.value).toBe("New Session requirement");
 });
 it("does not send after deployment ends and delegates return and exit independently", async () => {
  const props = pageProps(); let view = page(props); host.commit(); typeDraft(view, "Requirement");
  props.task = { ...task, phase: "finished", deployment: { ...task.deployment, outcome: "cancelled", finishedAt: 30 } };
  view = page(props); await submit(view); expect(props.onSubmit).not.toHaveBeenCalled();
  click(native(view, "button").find((item) => item.props.children === "Back to conversation")!);
  click(native(view, "button").find((item) => item.props.children === "Exit deployment")!);
  expect(props.onReturnConversation).toHaveBeenCalledOnce(); expect(props.onExit).toHaveBeenCalledOnce();
 });
});

function logChunks(view: ReactNode) { return native(view, "span").filter((item) => item.props.className?.includes("deploy-log-chunk")); }
function logViewport(view: ReactNode) { return native(view, "div").find((item) => item.props.className?.includes("deploy-log-viewport"))!; }
function logToggle(view: ReactNode) { return native(view, "button").find((item) => item.props.className === "deploy-log-toggle")!; }
const chunk = (sequence: number, executionId: string, text: string): DeploymentLogChunk => ({ deploymentRunId: run.id, stage: "build", sequence, executionId, timestamp: sequence, kind: "output", text });
async function logFixture() {
 const store = new DeploymentLogStore("session", async (_s, _r, _t, cursor) => ({ chunks: cursor === 0 ? [chunk(1, "build-1", "[ERROR] missing dependency\n"), chunk(2, "build-2", "BUILD SUCCESS\n")] : [], nextSequence: 2, hasMore: false }));
 await store.load(run.id, "build"); return { store, render: () => host.render(() => DeploymentLogs({ run, stage: "build", store })) };
}
function button(view: ReactNode, label: string) { return native(view, "button").find((item) => item.props.children === label)!; }

describe("deployment log interaction", () => {
 it("appends retries to one text viewport, keeps the entire panel collapsed and opens it to locate an error", async () => {
  const fixture = await logFixture(); let view = fixture.render(); host.commit(); click(logToggle(view));
  view = fixture.render(); expect(logViewport(view).props.hidden).toBe(true);
  fixture.store.append(chunk(3, "build-3", "post-build output\n")); view = fixture.render();
  expect(logToggle(view).props["aria-expanded"]).toBe(false);
  expect(logViewport(view).props.hidden).toBe(true);
  expect(native(view, "pre")).toHaveLength(1);
  expect(logChunks(view).map((item) => item.props.children).join("")).toBe("[ERROR] missing dependency\nBUILD SUCCESS\npost-build output\n");
  const viewport = { scrollTop: 10, clientHeight: 200, getBoundingClientRect: () => ({ top: 100 }) };
  (logViewport(view).props.ref as { current: unknown }).current = viewport;
  const target = { getBoundingClientRect: () => ({ top: 500, height: 40 }), focus: vi.fn() };
  const first = logChunks(view)[0]!;
  if (typeof first.props.ref === "function") first.props.ref(target as unknown as HTMLSpanElement);
  click(button(view, "Jump to error")); view = fixture.render(); expect(logViewport(view).props.hidden).toBe(false);
  expect(logToggle(view).props["aria-expanded"]).toBe(true);
  host.flushLayout(); expect(viewport.scrollTop).toBe(330); expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(button(view, "Follow output").props["aria-pressed"]).toBe(false);
 });
 it("preserves the old log position and ignores hidden viewport measurements", async () => {
  const observers: (() => void)[] = [];
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} });
  const fixture = await logFixture(); let view = fixture.render(); const viewport = { clientHeight: 200, scrollHeight: 1000, scrollTop: 0 };
  const element = native(view, "div").find((item) => item.props.className?.includes("deploy-log-viewport"))!;
  (element.props.ref as { current: unknown }).current = viewport; host.commit(); expect(viewport.scrollTop).toBe(1000);
  viewport.scrollTop = 100; element.props.onScroll?.({} as React.UIEvent<HTMLDivElement>);
  fixture.store.append(chunk(3, "build-2", "More output\n")); view = fixture.render(); host.commit(); expect(viewport.scrollTop).toBe(100);
  click(button(view, "Follow output")); expect(viewport.scrollTop).toBe(1000);
  viewport.clientHeight = 0; viewport.scrollTop = 100; for (const resize of observers) resize(); expect(viewport.scrollTop).toBe(100);
  viewport.clientHeight = 200; for (const resize of observers) resize(); expect(viewport.scrollTop).toBe(1000);
 });
 it("locates a legacy error tail without fabricating an execution", () => {
  const legacy = { ...run, stages: { ...run.stages, build: { status: "failed" as const, log: "[ERROR] legacy build\n" } } };
  const store = pageProps().logs; let view = host.render(() => DeploymentLogs({ run: legacy, stage: "build", store }));
  const viewport = { scrollTop: 10, clientHeight: 200, getBoundingClientRect: () => ({ top: 100 }) };
  const logViewport = native(view, "div").find((item) => item.props.className?.includes("deploy-log-viewport"))!;
  (logViewport.props.ref as { current: unknown }).current = viewport;
  const target = { getBoundingClientRect: () => ({ top: 500, height: 40 }), focus: vi.fn() };
  const pre = elements(view).find((item) => item.type === "pre") as ReactElement<ComponentProps<"pre">>;
  if (typeof pre.props.ref === "function") pre.props.ref(target as unknown as HTMLPreElement);
  click(button(view, "Jump to error")); view = host.render(() => DeploymentLogs({ run: legacy, stage: "build", store })); host.flushLayout();
  expect(logChunks(view)).toHaveLength(0); expect(target.focus).toHaveBeenCalledOnce();
 });
 it("opens collapsed output when following resumes and retains content while hidden", async () => {
  const fixture = await logFixture(); let view = fixture.render(); host.commit(); click(logToggle(view));
  view = fixture.render(); expect(logViewport(view).props.hidden).toBe(true);
  click(button(view, "Follow output")); view = fixture.render();
  expect(logViewport(view).props.hidden).toBe(false);
  expect(logChunks(view)).toHaveLength(2);
  expect(button(view, "Follow output").props["aria-pressed"]).toBe(true);
 });
});

describe("deployment build command navigation", () => {
 function fixture(): DeploymentRun {
  if (run.plan.version !== 2) throw new Error("Expected a multi-step plan");
  return { ...run, plan: { ...run.plan, buildSteps: [1, 2, 3, 4].map((index) => ({ cwd: "/project", command: `build-${index}` })) },
   stages: { ...run.stages, build: { ...run.stages.build, status: "running", step: { current: 4, total: 4, cwd: "/project", command: "build-4" } } } };
 }
 function render(value: DeploymentRun) { return host.render(() => DeploymentBuildSteps({ run: value })); }
 function previous(view: ReactNode) { return native(view, "button").find((item) => item.props["aria-label"] === "Previous step command")!; }
 function next(view: ReactNode) { return native(view, "button").find((item) => item.props["aria-label"] === "Next step command")!; }
 it("browses all commands with bounded previous and next controls without changing execution", () => {
  const value = fixture(); let view = render(value);
  expect(native(view, "code")[0]?.props.children).toBe("build-4"); expect(next(view).props.disabled).toBe(true);
  for (let index = 3; index >= 1; index--) { click(previous(view)); view = render(value); expect(native(view, "code")[0]?.props.children).toBe(`build-${index}`); }
  expect(previous(view).props.disabled).toBe(true); click(previous(view)); view = render(value);
  expect(native(view, "code")[0]?.props.children).toBe("build-1");
  click(next(view)); view = render(value); expect(native(view, "code")[0]?.props.children).toBe("build-2");
  expect(value.stages.build.step?.current).toBe(4);
 });
 it("follows live steps until browsing, then keeps that selection until another execution starts", () => {
  let value = fixture(); value.stages.build.step!.current = 2; value.stages.build.step!.command = "build-2";
  let view = render(value); expect(native(view, "code")[0]?.props.children).toBe("build-2");
  value = { ...value, stages: { ...value.stages, build: { ...value.stages.build, step: { ...value.stages.build.step!, current: 3, command: "build-3" } } } };
  view = render(value); expect(native(view, "code")[0]?.props.children).toBe("build-3");
  click(previous(view)); view = render(value);
  value.stages.build.step = { ...value.stages.build.step!, current: 4, command: "build-4" };
  view = render(value); expect(native(view, "code")[0]?.props.children).toBe("build-2");
  value = { ...value, stages: { ...value.stages, build: { ...value.stages.build, executionId: "build-3" } } };
  view = render(value); expect(native(view, "code")[0]?.props.children).toBe("build-4");
 });
 it("supports a legacy single command without inventing additional steps", () => {
  const value: DeploymentRun = { ...run, plan: { ...run.plan, version: undefined,
   build: { cwd: "/project", command: "legacy-build", artifact: "/project/api.jar" }, upload: { remotePath: "/srv/app/api.jar" } } };
  const view = render(value);
  expect(native(view, "code")[0]?.props.children).toBe("legacy-build");
  expect(previous(view).props.disabled).toBe(true); expect(next(view).props.disabled).toBe(true);
 });
});


describe("deployment module launcher interaction", () => {
 function props(): ComponentProps<typeof DeploymentModulePicker> { return {
  discovery: { host: "example.org", errors: [], latest: null, activeDiscussion: null, profiles: [
   { file: "deploy-a.md", project: "A", target: { host: "example.org" }, modules: [{ id: "api", name: "API" }, { id: "worker", name: "Worker" }] },
   { file: "deploy-b.md", project: "B", target: { host: "example.org" }, modules: [{ id: "api", name: "API" }] },
  ] }, loading: false, busy: false, disabled: false, error: null,
  onSelect: vi.fn(async () => undefined), onSetup: vi.fn(), onClose: vi.fn(), onRetry: vi.fn(),
 }; }
 function render(value: ComponentProps<typeof DeploymentModulePicker>) { return host.render(() => DeploymentModulePicker(value)); }
 function rows(view: ReactNode) { return native(view, "input").filter((item) => item.props.type === "radio"); }
 function panel(view: ReactNode) { return native(view, "div")[0]!; }
 function checked(view: ReactNode) { return rows(view).map((row) => row.props.checked); }
 function select(node: ReactElement<ComponentProps<"input">>) {
  node.props.onClick?.({} as MouseEvent<HTMLInputElement>);
  node.props.onChange?.({ target: { checked: true } } as ChangeEvent<HTMLInputElement>);
 }
 function key(node: ReactElement<ComponentProps<"div"> | ComponentProps<"input">>, value: string, details: { target?: unknown; repeat?: boolean } = {}) {
  const event = { key: value, repeat: details.repeat ?? false, target: details.target ?? node, currentTarget: node,
   preventDefault: vi.fn(), stopPropagation: vi.fn() };
  node.props.onKeyDown?.(event as unknown as KeyboardEvent<HTMLInputElement> & KeyboardEvent<HTMLDivElement>); return event;
 }
 function attachRows(view: ReactNode) {
  return rows(view).map((row) => { const target = { focus: vi.fn(), disabled: false };
   if (typeof row.props.ref === "function") row.props.ref(target as unknown as HTMLInputElement); return target; });
 }
 beforeEach(() => { vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
 it("preselects the first asynchronously loaded module without starting deployment or moving the panel focus", () => {
  const value = props(); value.loading = true; let view = render(value);
  const panel = { focus: vi.fn() };
  (native(view, "div")[0]!.props.ref as { current: unknown }).current = panel;
  host.commit(); expect(panel.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  expect(rows(view)).toHaveLength(0); expect(value.onSelect).not.toHaveBeenCalled();
  value.loading = false; view = render(value);
  const targets = attachRows(view);
  host.commit(); expect(targets[0]!.focus).not.toHaveBeenCalled();
  expect(checked(view)).toEqual([true, false, false]); expect(value.onSelect).not.toHaveBeenCalled();
 });
 it("confirms the default first module with Enter from the initially focused panel", () => {
  const value = props(); const view = render(value);
  const event = key(panel(view), "Enter");
  expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
  expect(value.onSelect).toHaveBeenCalledExactlyOnceWith("deploy-a.md", "api");
 });
 it("moves the panel selection with up/down, wraps at the ends and supports Home/End without dispatching", () => {
  const value = props(); let view = render(value); const targets = attachRows(view);
  expect(key(panel(view), "ArrowDown").preventDefault).toHaveBeenCalledOnce();
  view = render(value); expect(checked(view)).toEqual([false, true, false]); expect(targets[1]!.focus).toHaveBeenCalledOnce();
  key(panel(view), "ArrowDown"); view = render(value); expect(checked(view)).toEqual([false, false, true]);
  key(panel(view), "ArrowDown"); view = render(value); expect(checked(view)).toEqual([true, false, false]);
  key(panel(view), "ArrowUp"); view = render(value); expect(checked(view)).toEqual([false, false, true]);
  key(panel(view), "Home"); view = render(value); expect(checked(view)).toEqual([true, false, false]);
  key(panel(view), "End"); view = render(value); expect(checked(view)).toEqual([false, false, true]);
  expect(value.onSelect).not.toHaveBeenCalled();
 });
 it("navigates focused radios without native selection dispatch and confirms the exact cross-profile module with Enter", () => {
  const value = props(); let view = render(value); const targets = attachRows(view);
  const event = key(rows(view)[0]!, "ArrowUp");
  expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
  view = render(value); expect(checked(view)).toEqual([false, false, true]); expect(targets[2]!.focus).toHaveBeenCalledOnce();
  key(rows(view)[2]!, "ArrowLeft"); view = render(value); expect(checked(view)).toEqual([false, true, false]);
  key(rows(view)[1]!, "ArrowRight"); view = render(value); expect(checked(view)).toEqual([false, false, true]);
  expect(value.onSelect).not.toHaveBeenCalled();
  key(rows(view)[2]!, "Enter"); expect(value.onSelect).toHaveBeenCalledExactlyOnceWith("deploy-b.md", "api");
 });
 it("changes selection on radio focus or change without treating navigation as confirmation", () => {
  const value = props(); let view = render(value);
  rows(view)[2]!.props.onFocus?.({} as Parameters<NonNullable<ComponentProps<"input">["onFocus"]>>[0]);
  view = render(value); expect(checked(view)).toEqual([false, false, true]);
  rows(view)[1]!.props.onChange?.({ target: { checked: true } } as ChangeEvent<HTMLInputElement>);
  view = render(value); expect(checked(view)).toEqual([false, true, false]); expect(value.onSelect).not.toHaveBeenCalled();
  key(panel(view), "Enter"); expect(value.onSelect).toHaveBeenCalledExactlyOnceWith("deploy-a.md", "worker");
 });
 it("activates the already checked default module when clicked", () => {
  const value = props(); const view = render(value); expect(rows(view)[0]?.props.checked).toBe(true);
  select(rows(view)[0]!); expect(value.onSelect).toHaveBeenCalledExactlyOnceWith("deploy-a.md", "api");
 });
 it("closes with Escape or the close control and lets an outside pointer retain its own focus", () => {
  const value = props(); const view = render(value); const root = native(view, "div")[0]!;
  class Target {} vi.stubGlobal("Node", Target); const inside = new Target();
  (root.props.ref as { current: unknown }).current = { contains: (target: unknown) => target === inside, focus: vi.fn() };
  host.commit();
  const listener = vi.mocked(document.addEventListener).mock.calls[0]![1] as (event: { target: unknown }) => void;
  listener({ target: inside }); expect(value.onClose).not.toHaveBeenCalled();
  listener({ target: new Target() }); expect(value.onClose).toHaveBeenLastCalledWith(false);
  const event = key(root, "Escape"); expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
  expect(value.onClose).toHaveBeenLastCalledWith(true);
  click(native(view, "button")[0]!); expect(value.onClose).toHaveBeenCalledTimes(3);
  host.dispose(); expect(document.removeEventListener).toHaveBeenCalledWith("pointerdown", listener);
 });
 it("selects the exact profile once while a choice is pending and permits another attempt afterwards", async () => {
  const value = props(); const pending = deferred<void>(); value.onSelect = vi.fn(() => pending.promise);
  const view = render(value); select(rows(view)[2]!); select(rows(view)[0]!);
  expect(rows(render(value)).map((row) => row.props.checked)).toEqual([false, false, true]);
  expect(value.onSelect).toHaveBeenCalledExactlyOnceWith("deploy-b.md", "api");
  pending.resolve(); await pending.promise; await Promise.resolve();
  expect(checked(render(value))).toEqual([true, false, false]);
  select(rows(view)[2]!); expect(value.onSelect).toHaveBeenCalledTimes(2);
 });
 it.each(["disabled", "busy", "loading"] as const)("does not navigate or confirm while %s", (state) => {
  const value = props(); value[state] = true; let view = render(value);
  key(panel(view), "ArrowDown"); view = render(value); key(panel(view), "Enter");
  if (state === "loading") expect(rows(view)).toHaveLength(0);
  else {
   select(rows(view)[0]!); key(rows(view)[0]!, "Enter");
   expect(checked(render(value))).toEqual([true, false, false]);
   expect(rows(view).every((row) => row.props.disabled)).toBe(true);
  }
  expect(value.onSelect).not.toHaveBeenCalled();
 });
 it("ignores navigation and Enter for an empty module list", () => {
  const value = props(); value.discovery = null; const view = render(value);
  key(panel(view), "ArrowDown"); key(panel(view), "ArrowUp"); key(panel(view), "Enter");
  expect(rows(view)).toHaveLength(0); expect(value.onSelect).not.toHaveBeenCalled();
 });
 it("ignores repeated Enter and locks duplicate confirmations until the pending choice finishes", async () => {
  const value = props(); const pending = deferred<void>(); value.onSelect = vi.fn(() => pending.promise);
  let view = render(value); key(panel(view), "Enter", { repeat: true }); expect(value.onSelect).not.toHaveBeenCalled();
  key(panel(view), "Enter"); key(rows(view)[0]!, "Enter"); select(rows(view)[2]!);
  expect(value.onSelect).toHaveBeenCalledExactlyOnceWith("deploy-a.md", "api");
  expect(checked(render(value))).toEqual([true, false, false]);
  pending.resolve(); await pending.promise; await Promise.resolve(); view = render(value);
  key(panel(view), "Enter"); expect(value.onSelect).toHaveBeenCalledTimes(2);
 });
 it("lets Enter on close, retry and setup keep their native button actions", () => {
  const value = props(); value.error = "Try again"; const view = render(value);
  const buttons = native(view, "button");
  for (const target of buttons) {
   const event = key(panel(view), "Enter", { target });
   expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
   click(target);
  }
  expect(value.onClose).toHaveBeenCalledExactlyOnceWith(true);
  expect(value.onRetry).toHaveBeenCalledOnce(); expect(value.onSetup).toHaveBeenCalledOnce();
  expect(value.onSelect).not.toHaveBeenCalled();
 });
 it("keeps selection by profile/module identity on refresh and falls back to the first remaining module if it disappears", () => {
  const value = props(); let view = render(value); key(panel(view), "End"); view = render(value);
  expect(checked(view)).toEqual([false, false, true]);
  const original = value.discovery!;
  value.discovery = { ...original, profiles: [original.profiles[1]!, original.profiles[0]!] };
  view = render(value); expect(checked(view)).toEqual([true, false, false]);
  value.discovery = { ...original, profiles: [original.profiles[0]!] };
  view = render(value); expect(checked(view)).toEqual([true, false]); expect(value.onSelect).not.toHaveBeenCalled();
  key(panel(view), "Enter"); expect(value.onSelect).toHaveBeenCalledExactlyOnceWith("deploy-a.md", "api");
 });
});
