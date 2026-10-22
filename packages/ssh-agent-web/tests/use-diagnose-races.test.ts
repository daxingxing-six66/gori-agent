import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookDriver, deferred } from "./helpers/hook-driver";
import type { DiagnoseNode, DiagnoseTask } from "../features/diagnose/model/diagnose";
import type { DiagnoseChatResult } from "../features/diagnose/api/diagnose-api";

let driver: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof React>(),
	useState: (initial: unknown) => driver.state(initial), useRef: (initial: unknown) => driver.ref(initial),
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => driver.effect(effect, deps),
	useCallback: <T,>(callback: T, deps: readonly unknown[]) => driver.memo(() => callback, deps),
}));
vi.mock("../features/i18n/components/locale-context", () => ({ useLocale: () => ({ locale: "zh-CN" }) }));
vi.mock("../features/i18n/components/use-localized-error-message", () => ({ useLocalizedErrorMessage: () => (error: unknown) => String(error) }));
vi.mock("../features/diagnose/api/diagnose-api", () => ({ diagnoseApi: { active: vi.fn(), get: vi.fn(), nodes: vi.fn(), start: vi.fn(), conclude: vi.fn(), cancel: vi.fn() } }));
import { diagnoseApi } from "../features/diagnose/api/diagnose-api";
import { useDiagnose } from "../features/diagnose/runtime/use-diagnose";

class FakeEventSource {
	static current: FakeEventSource;
	private listeners = new Map<string, ((event: Event) => void)[]>();
	constructor(_url: string) { FakeEventSource.current = this; }
	addEventListener(type: string, listener: (event: Event) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
	emit(type: string, value: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(value) })); }
	close() {}
}
const task: DiagnoseTask = { id: "task", sessionId: "s", workspaceId: "w", requestId: "first", title: "Intermittent errors", status: "active", revision: 1,
	currentSequence: 0, conclusionAvailable: false, createdAt: 1, updatedAt: 1 };
const node: DiagnoseNode = { taskId: task.id, sequence: 1, direction: "Logs", status: "diagnosing", explanation: "one", revision: 1, createdAt: 2, updatedAt: 2 };
let sessionId = "s";
const attachRun = vi.fn();
const onHistoryResync = vi.fn<() => Promise<void>>();
let value: ReturnType<typeof useDiagnose>;
function render() { value = driver.render(() => useDiagnose({ sessionId, workspaceId: "w", model: null, thinkingLevel: "off", serverInteractionMode: "command", attachRun,
	onHistoryMessage: vi.fn(), onHistoryResync })); return value; }
async function settle() { for (let count = 0; count < 5; count++) { for (let tick = 0; tick < 10; tick++) await Promise.resolve(); render(); } }
beforeEach(async () => {
	vi.resetAllMocks(); vi.stubGlobal("EventSource", FakeEventSource); sessionId = "s"; driver = new HookDriver();
	onHistoryResync.mockResolvedValue(undefined);
	vi.mocked(diagnoseApi.active).mockResolvedValue(task); vi.mocked(diagnoseApi.get).mockResolvedValue(task); vi.mocked(diagnoseApi.nodes).mockResolvedValue({ nodes: [], nextBeforeSequence: null });
	render(); await settle();
});
afterEach(() => { driver.unmount(); vi.unstubAllGlobals(); });

describe("diagnosis scope and event races", () => {
	it("reconciles the history card after a start response without a Run, even when its SSE was missed", async () => {
		driver.unmount(); vi.mocked(diagnoseApi.active).mockResolvedValue(null); driver = new HookDriver(); render(); await settle();
		vi.mocked(diagnoseApi.start).mockResolvedValue({ task });
		expect(await value.show()).toBe(true); render();
		expect(onHistoryResync).toHaveBeenCalledOnce(); expect(attachRun).not.toHaveBeenCalled();
		expect(value.selectedTaskId).toBe(task.id);
	});
	it("recovers the persisted card when task creation succeeded but the initial Chat request failed", async () => {
		driver.unmount(); vi.mocked(diagnoseApi.active).mockResolvedValue(null); driver = new HookDriver(); render(); await settle();
		vi.mocked(diagnoseApi.start).mockRejectedValue(new Error("Model unavailable")); vi.mocked(diagnoseApi.active).mockResolvedValue(task);
		expect(await value.show()).toBe(false); render();
		expect(onHistoryResync).toHaveBeenCalledOnce(); expect(value.activeTask?.id).toBe(task.id);
		expect(value.error).toContain("Model unavailable");
	});
	it("does not refresh the new Session after a delayed start response or failure", async () => {
		driver.unmount(); vi.mocked(diagnoseApi.active).mockResolvedValue(null); driver = new HookDriver(); render(); await settle();
		const pending = deferred<DiagnoseChatResult>(); vi.mocked(diagnoseApi.start).mockReturnValueOnce(pending.promise);
		const starting = value.show(); sessionId = "other"; render(); await settle();
		pending.reject(new Error("Old request failed")); expect(await starting).toBe(false); await settle();
		expect(onHistoryResync).not.toHaveBeenCalled(); expect(value.open).toBe(false); expect(value.error).toBeNull();
	});
	it("hides and reveals the active identity without creating or ending it", async () => {
		expect(value.open).toBe(true); value.hide(); render(); expect(value.open).toBe(false);
		expect(await value.show()).toBe(true); render(); expect(value.selectedTaskId).toBe(task.id);
		expect(diagnoseApi.start).not.toHaveBeenCalled(); expect(diagnoseApi.cancel).not.toHaveBeenCalled();
	});
	it("accepts the node after its task event and rejects older revisions independently", () => {
		FakeEventSource.current.emit("diagnose.task.updated", { ...task, revision: 2, currentSequence: 1 }); render();
		FakeEventSource.current.emit("diagnose.node.updated", { sessionId: "s", workspaceId: "w", node: { ...node, revision: 2, explanation: "new" } }); render();
		FakeEventSource.current.emit("diagnose.node.updated", { sessionId: "s", workspaceId: "w", node }); render();
		expect(value.selected?.nodes).toMatchObject([{ revision: 2, explanation: "new" }]);
	});
	it("does not reactivate a finished task from delayed REST or SSE", async () => {
		const pending = deferred<DiagnoseTask | null>(); vi.mocked(diagnoseApi.active).mockReturnValueOnce(pending.promise);
		const refreshing = value.refresh();
		const ended = { ...task, revision: 3, status: "cancelled" as const, finishedAt: 3 };
		FakeEventSource.current.emit("diagnose.task.updated", ended); render();
		pending.resolve(task); await refreshing; await settle();
		FakeEventSource.current.emit("diagnose.task.updated", task); render();
		expect(value.activeTask).toBeUndefined(); expect(value.selected?.task?.status).toBe("cancelled");
	});
	it("keeps history selection when active events arrive, including late initial reconciliation", async () => {
		const old = { ...task, id: "old", status: "completed" as const, conclusionAvailable: true, revision: 4 };
		vi.mocked(diagnoseApi.get).mockResolvedValue(old); value.openHistory("old"); render(); await settle();
		FakeEventSource.current.emit("diagnose.task.updated", { ...task, revision: 2 }); render();
		expect(value.selectedTaskId).toBe("old"); expect(value.activeTask?.id).toBe("task");
	});
	it("discards previous Session responses and preserves view state across hide/show", async () => {
		value.view.update(task.id, { expanded: { 1: true, 2: true }, recordsScroll: 143, conclusionScroll: 72 }); render();
		value.hide(); render(); await value.show(); render(); expect(value.view.get(task.id)).toMatchObject({ expanded: { 1: true, 2: true }, recordsScroll: 143, conclusionScroll: 72 });
		const pending = deferred<DiagnoseTask | null>(); vi.mocked(diagnoseApi.active).mockReturnValueOnce(pending.promise); const refreshing = value.refresh();
		sessionId = "other"; vi.mocked(diagnoseApi.active).mockResolvedValue(null); render(); await settle(); pending.resolve(task); await refreshing; await settle();
		expect(value.open).toBe(false); expect(value.activeTask).toBeUndefined();
	});
	it("allows direct exit while a conclusion request is unresolved", async () => {
		const pending = deferred<DiagnoseChatResult>(); vi.mocked(diagnoseApi.conclude).mockReturnValueOnce(pending.promise);
		const concluding = value.conclude(); render();
		vi.mocked(diagnoseApi.cancel).mockResolvedValue({ ...task, status: "cancelled", revision: 3 });
		await value.cancel(); render();
		expect(value.selected?.task?.status).toBe("cancelled"); expect(attachRun).not.toHaveBeenCalled();
		pending.resolve({ task }); await concluding; render(); expect(value.activeTask).toBeUndefined();
	});
});
