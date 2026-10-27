import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Check, CircleAlert, Copy } from "lucide-react";
import { zhCNDiagnoseMessages } from "../features/i18n/messages/zh-CN/diagnose";
import { enUSDiagnoseMessages } from "../features/i18n/messages/en-US/diagnose";

let host: ComponentHost;
let messages: Record<string, string>;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useRef: (initial: unknown) => host.ref(initial),
	useState: (initial: unknown) => host.state(initial),
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => host.effect(effect, deps),
	useLayoutEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => host.effect(effect, deps),
}));
vi.mock("react-intl", () => ({ useIntl: () => ({ formatMessage: ({ id }: { id: string }) => messages[id] }) }));
vi.mock("../features/i18n/components/use-localized-error-message", () => ({ useLocalizedErrorMessage: () => String }));
vi.mock("../features/diagnose/api/diagnose-api", () => ({ diagnoseApi: { conclusion: vi.fn() } }));
import { diagnoseApi } from "../features/diagnose/api/diagnose-api";
import { DiagnoseCopyConclusion } from "../features/diagnose/components/diagnose-copy-conclusion";
import { DiagnoseConclusionPage } from "../features/diagnose/components/diagnose-conclusion-page";

/** Runs real component handlers and effect cleanup without a browser or network. */
class ComponentHost {
	private values: unknown[] = [];
	private cursor = 0;
	private pending: (() => void)[] = [];
	private effects = new Map<number, { deps: readonly unknown[]; cleanup?: () => void }>();
	updates = 0;
	render<T>(render: () => T): T { this.cursor = 0; return render(); }
	ref<T>(initial: T): { current: T } {
		const index = this.cursor++;
		if (!(index in this.values)) this.values[index] = { current: initial };
		return this.values[index] as { current: T };
	}
	state<T>(initial: T): [T, (next: T | ((value: T) => T)) => void] {
		const index = this.cursor++;
		if (!(index in this.values)) this.values[index] = initial;
		return [this.values[index] as T, (next) => {
			this.updates++;
			this.values[index] = typeof next === "function" ? (next as (value: T) => T)(this.values[index] as T) : next;
		}];
	}
	effect(effect: () => void | (() => void), deps: readonly unknown[]): void {
		const index = this.cursor++;
		const previous = this.effects.get(index);
		if (previous?.deps.length === deps.length && deps.every((value, offset) => Object.is(value, previous.deps[offset]))) return;
		const current = { deps, cleanup: previous?.cleanup };
		this.effects.set(index, current);
		this.pending.push(() => { current.cleanup?.(); current.cleanup = effect() || undefined; });
	}
	commit(): void { const pending = this.pending; this.pending = []; pending.forEach((effect) => effect()); }
	unmount(): void { this.effects.forEach((effect) => effect.cleanup?.()); this.effects.clear(); }
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
	const result: ReactElement<Record<string, unknown>>[] = [];
	Children.forEach(node, (child) => {
		if (!isValidElement<Record<string, unknown>>(child)) return;
		result.push(child, ...elements(child.props.children as ReactNode));
	});
	return result;
}
const markdown = "# 诊断结论\n\n## 已证实\n- 上游超时\n\n```sh\ncurl -I localhost\n```\n\n| 证据 | 结果 |\n|---|---|\n| 日志 | 502 |\n";
function renderCopy() {
	const tree = host.render(() => DiagnoseCopyConclusion({ markdown })); host.commit();
	const button = elements(tree).find((node) => node.type === "button") as ReactElement<ComponentProps<"button">>;
	return { tree, button, click: () => button.props.onClick?.({} as Parameters<NonNullable<typeof button.props.onClick>>[0]) };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => { host = new ComponentHost(); messages = zhCNDiagnoseMessages; vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { host.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("diagnosis conclusion icon copy", () => {
	it.each([zhCNDiagnoseMessages, enUSDiagnoseMessages])("uses an icon without visible button text, with a localized accessible name", (catalog) => {
		messages = catalog;
		const { button } = renderCopy();
		expect(button.props["aria-label"]).toBe(catalog["diagnose.copyConclusion"]);
		expect(button.props.title).toBe(catalog["diagnose.copyConclusion"]);
		const icon = Children.only(button.props.children) as ReactElement;
		expect(icon.type).toBe(Copy);
		expect(icon.props).toMatchObject({ "aria-hidden": "true" });
	});

	it("copies the full Markdown once during a pending write and briefly shows success", async () => {
		let resolve!: () => void;
		const writeText = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		const initial = renderCopy(); initial.click(); initial.click();
		expect(writeText).toHaveBeenCalledExactlyOnceWith(markdown);
		expect(renderCopy().button.props).toMatchObject({ disabled: true, "aria-busy": true });
		resolve(); await flush();
		const success = renderCopy();
		expect(success.button.props["aria-label"]).toBe("已复制");
		expect((Children.only(success.button.props.children) as ReactElement).type).toBe(Check);
		vi.advanceTimersByTime(1500);
		expect(renderCopy().button.props["aria-label"]).toBe("复制结论");
	});

	it("reports a rejected clipboard write and allows retry", async () => {
		const writeText = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		renderCopy().click(); await flush();
		const failed = renderCopy();
		expect(failed.button.props).toMatchObject({ disabled: false, "aria-label": "复制失败，请重试" });
		expect((Children.only(failed.button.props.children) as ReactElement).type).toBe(CircleAlert);
		failed.click(); await flush();
		expect(renderCopy().button.props["aria-label"]).toBe("已复制");
		expect(writeText).toHaveBeenCalledTimes(2);
	});

	it("handles an unavailable clipboard without throwing", () => {
		vi.stubGlobal("navigator", {});
		expect(() => renderCopy().click()).not.toThrow();
		expect(renderCopy().button.props["aria-label"]).toBe("复制失败，请重试");
	});

	it("ignores clipboard completion after leaving the conclusion and cleans up its timer", async () => {
		let resolve!: () => void;
		vi.stubGlobal("navigator", { clipboard: { writeText: () => new Promise<void>((done) => { resolve = done; }) } });
		renderCopy().click(); host.unmount();
		const updates = host.updates;
		resolve(); await flush();
		expect(host.updates).toBe(updates);
		host = new ComponentHost();
		vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
		renderCopy().click(); await flush(); renderCopy();
		expect(vi.getTimerCount()).toBe(1);
		host.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("exposes copy only after the saved conclusion loads, without another API read", async () => {
		vi.mocked(diagnoseApi.conclusion).mockResolvedValue(markdown);
		const render = () => {
			const tree = host.render(() => DiagnoseConclusionPage({ sessionId: "s", taskId: "t" })); host.commit();
			return elements(tree).find((node) => node.type === DiagnoseCopyConclusion);
		};
		expect(render()).toBeUndefined();
		await flush();
		expect(render()?.props.markdown).toBe(markdown);
		expect(diagnoseApi.conclusion).toHaveBeenCalledExactlyOnceWith("s", "t");
	});

	it("does not expose copy when loading the conclusion fails", async () => {
		vi.mocked(diagnoseApi.conclusion).mockRejectedValue(new Error("offline"));
		host.render(() => DiagnoseConclusionPage({ sessionId: "s", taskId: "t" })); host.commit(); await flush();
		const tree = host.render(() => DiagnoseConclusionPage({ sessionId: "s", taskId: "t" }));
		expect(elements(tree).some((node) => node.type === DiagnoseCopyConclusion)).toBe(false);
		expect(elements(tree).some((node) => node.props.role === "alert")).toBe(true);
	});
});
