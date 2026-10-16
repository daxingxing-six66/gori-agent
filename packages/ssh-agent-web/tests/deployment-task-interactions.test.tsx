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
import { DeploymentTaskPage } from "../features/deploy/components/deployment-task-page";
import { DeploymentModulePicker } from "../features/deploy/components/deployment-module-picker";
import { DeploymentLogs } from "../features/deploy/components/deployment-logs";

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
function native<T extends "textarea" | "form" | "button" | "input" | "li" | "div">(node: ReactNode, type: T): ReactElement<ComponentProps<T>>[] {
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
 it("keeps selected build logs while execution advances and retains all four log pages", () => {
  const props = pageProps(); let view = page(props); host.commit();
  click(native(view, "button").find((item) => elements(item.props.children).some((child) => child.props.children === "Build"))!);
  props.run = { ...run, updatedAt: 21, stages: { ...run.stages, upload: { status: "success", log: "" }, restart: { status: "running", log: "" } } };
  view = page(props);
  const stages = native(view, "li") as ReactElement<{ "data-current": boolean; "data-selected": boolean }>[];
  expect(stages.map((item) => item.props["data-current"])).toEqual([false, false, false, true, false]);
  expect(stages.map((item) => item.props["data-selected"])).toEqual([false, true, false, false, false]);
  const pages = native(view, "div").filter((item) => item.props.className === "deploy-stage-log-page");
  expect(pages).toHaveLength(4); expect(pages.filter((item) => !item.props.hidden)).toHaveLength(1); expect(pages[0]?.key).toBe(`${run.id}:build`);
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

type GroupProps = { chunks: DeploymentLogChunk[]; open: boolean; onToggle(): void; registerChunk(sequence: number, element: HTMLElement | null): void };
function groups(view: ReactNode): ReactElement<GroupProps>[] { return elements(view).filter((item) => typeof item.type === "function" && item.type.name === "LogGroup") as ReactElement<GroupProps>[]; }
const chunk = (sequence: number, executionId: string, text: string): DeploymentLogChunk => ({ deploymentRunId: run.id, stage: "build", sequence, executionId, timestamp: sequence, kind: "output", text });
async function logFixture() {
 const store = new DeploymentLogStore("session", async (_s, _r, _t, cursor) => ({ chunks: cursor === 0 ? [chunk(1, "build-1", "[ERROR] missing dependency\n"), chunk(2, "build-2", "BUILD SUCCESS\n")] : [], nextSequence: 2, hasMore: false }));
 await store.load(run.id, "build"); return { store, render: () => host.render(() => DeploymentLogs({ run, stage: "build", store })) };
}
function button(view: ReactNode, label: string) { return native(view, "button").find((item) => item.props.children === label)!; }

describe("deployment log interaction", () => {
 it("retains collapsed history on append and opens the error group before focusing it", async () => {
  const fixture = await logFixture(); let view = fixture.render(); host.commit(); groups(view)[0]!.props.onToggle();
  view = fixture.render(); expect(groups(view)[0]?.props.open).toBe(false);
  fixture.store.append(chunk(3, "build-2", "post-build output\n")); view = fixture.render();
  expect(groups(view)).toHaveLength(2); expect(groups(view)[0]?.props.open).toBe(false);
  const viewport = { scrollTop: 10, clientHeight: 200, getBoundingClientRect: () => ({ top: 100 }) };
  const logViewport = native(view, "div").find((item) => item.props.className?.includes("deploy-log-viewport"))!;
  (logViewport.props.ref as { current: unknown }).current = viewport;
  const target = { getBoundingClientRect: () => ({ top: 500, height: 40 }), focus: vi.fn() }; groups(view)[0]!.props.registerChunk(1, target as unknown as HTMLElement);
  click(button(view, "Jump to error")); view = fixture.render(); expect(groups(view)[0]?.props.open).toBe(true);
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
  expect(groups(view)).toHaveLength(0); expect(target.focus).toHaveBeenCalledOnce();
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
 function select(node: ReactElement<ComponentProps<"input">>) { node.props.onChange?.({ target: { checked: true } } as ChangeEvent<HTMLInputElement>); }
 function key(node: ReactElement<ComponentProps<"div"> | ComponentProps<"input">>, value: string) {
  const event = { key: value, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  node.props.onKeyDown?.(event as unknown as KeyboardEvent<HTMLInputElement> & KeyboardEvent<HTMLDivElement>); return event;
 }
 beforeEach(() => { vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
 it("focuses the panel without highlighting a module and supports arrow, Home and End navigation", () => {
  const value = props(); value.loading = true; let view = render(value);
  const panel = { focus: vi.fn() };
  (native(view, "div")[0]!.props.ref as { current: unknown }).current = panel;
  host.commit(); expect(panel.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  value.loading = false; view = render(value);
  const targets = rows(view).map((row) => { const target = { focus: vi.fn(), disabled: false };
   if (typeof row.props.ref === "function") row.props.ref(target as unknown as HTMLInputElement); return target; });
  host.commit(); expect(targets[0]!.focus).not.toHaveBeenCalled();
  expect(key(rows(view)[0]!, "ArrowUp").preventDefault).toHaveBeenCalledOnce(); expect(targets[2]!.focus).toHaveBeenCalledOnce();
  key(rows(view)[2]!, "ArrowDown"); expect(targets[0]!.focus).toHaveBeenCalledOnce();
  key(rows(view)[0]!, "End"); key(rows(view)[2]!, "Home");
  expect(targets[2]!.focus).toHaveBeenCalledTimes(2); expect(targets[0]!.focus).toHaveBeenCalledTimes(2);
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
  expect(rows(render(value)).every((row) => !row.props.checked)).toBe(true);
  select(rows(view)[2]!); expect(value.onSelect).toHaveBeenCalledTimes(2);
 });
 it("does not dispatch a stale row handler after selection is disabled", () => {
  const value = props(); value.disabled = true; const view = render(value); select(rows(view)[0]!);
  expect(value.onSelect).not.toHaveBeenCalled();
  expect(rows(view).every((row) => row.props.disabled)).toBe(true);
 });
});
