import { Children, isValidElement, type ComponentProps, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { createIntl } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enUSMessages } from "../features/i18n/messages/en-US";
import type { LlmModel, LlmProvider, LlmProviderModels } from "../features/llm-provider/model/llm-provider";
import { deferred, HookDriver } from "./helpers/hook-driver";

let hooks: HookDriver;
const intl = createIntl({ locale: "en-US", messages: enUSMessages });
const api = vi.hoisted(() => ({ listModels: vi.fn<(providerId: string, signal?: AbortSignal) => Promise<LlmProviderModels>>() }));
const providerState = vi.hoisted(() => ({ providers: [] as LlmProvider[], loading: false, error: null, refreshProviders: vi.fn<() => Promise<LlmProvider[]>>() }));
vi.mock("react", async (original) => ({
	...await original<typeof import("react")>(),
	useState: (initial: unknown) => hooks.state(initial), useRef: (initial: unknown) => hooks.ref(initial),
	useMemo: <T,>(factory: () => T, deps?: readonly unknown[]) => hooks.memo(factory, deps),
	useCallback: <T,>(callback: T, deps?: readonly unknown[]) => hooks.memo(() => callback, deps),
	useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => hooks.effect(effect, deps),
	useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => hooks.effect(effect, deps),
}));
vi.mock("react-dom", async (original) => ({ ...await original<typeof import("react-dom")>(), createPortal: (children: ReactNode) => children }));
vi.mock("react-intl", async (original) => ({ ...await original<typeof import("react-intl")>(), useIntl: () => intl }));
vi.mock("../features/llm-provider/api/llm-provider-api", () => ({ llmProviderApi: api }));
vi.mock("../features/llm-provider/components/llm-provider-context", () => ({ useLlmProviders: () => providerState }));
vi.mock("../features/settings/components/settings-context", () => ({ useSettings: () => ({ openSettings: vi.fn() }) }));
import { ModelSelector } from "../features/llm-provider/components/model-selector";

function provider(id: string): LlmProvider { return { id, name: `Provider ${id}`, custom: false, baseUrl: null, auth: { apiKey: true, oauth: false }, configured: true, credential: null, modelCount: 1 }; }
function model(id: string, providerId = "first"): LlmModel { return { id, name: id, providerId, api: "test", reasoning: false, supportedThinkingLevels: ["off"], input: ["text"], contextWindow: 32_768, maxTokens: 4_096 }; }
function catalog(id: string, providerId = "first"): LlmProviderModels { return { providerId, models: [model(id, providerId)] }; }
function props(): ComponentProps<typeof ModelSelector> { return { selectedModel: null, onSelect: vi.fn() }; }
function render(value: ComponentProps<typeof ModelSelector>): ReactNode { return hooks.render(() => ModelSelector(value)); }
function text(node: ReactNode): string {
	let value = ""; Children.forEach(node, (child) => {
		if (typeof child === "string" || typeof child === "number") value += child;
		else if (isValidElement<{ children?: ReactNode }>(child)) value += text(child.props.children);
	}); return value;
}
function buttons(node: ReactNode): ReactElement<ComponentProps<"button">>[] {
	const result: ReactElement<ComponentProps<"button">>[] = [];
	Children.forEach(node, (child) => {
		if (!isValidElement<{ children?: ReactNode }>(child)) return;
		if (child.type === "button") result.push(child as ReactElement<ComponentProps<"button">>);
		result.push(...buttons(child.props.children));
	}); return result;
}
function click(node: ReactElement<ComponentProps<"button">>) { node.props.onClick?.({} as MouseEvent<HTMLButtonElement>); }
function attach(view: ReactNode) {
	if (!isValidElement<{ ref: { current: unknown } }>(view)) throw new Error("Missing selector root");
	view.props.ref.current = { contains: () => false, closest: () => null };
}
async function settle() { for (let count = 0; count < 12; count++) await Promise.resolve(); }
async function commit(value: ComponentProps<typeof ModelSelector>) { render(value); await settle(); return render(value); }

beforeEach(() => {
	hooks = new HookDriver(); vi.resetAllMocks(); providerState.providers = [provider("first"), provider("second")];
	providerState.refreshProviders.mockResolvedValue(providerState.providers); api.listModels.mockResolvedValue(catalog("fresh-model"));
	vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { hooks.unmount(); vi.unstubAllGlobals(); });

describe("Model selector catalog freshness", () => {
	it("reads the latest effective models on every reopen instead of reusing the old picker catalog", async () => {
		const value = props(); let view = render(value); attach(view); click(buttons(view)[0]!); view = await commit(value);
		expect(text(view)).toContain("fresh-model"); expect(api.listModels).toHaveBeenCalledTimes(1);
		click(buttons(view)[0]!); view = render(value); api.listModels.mockResolvedValueOnce(catalog("refreshed-model"));
		click(buttons(view)[0]!); view = await commit(value);
		expect(api.listModels).toHaveBeenCalledTimes(2); expect(text(view)).toContain("refreshed-model"); expect(text(view)).not.toContain("fresh-model");
		expect(value.onSelect).not.toHaveBeenCalled();
	});

	it("refetches a provider when returning to it after browsing another provider", async () => {
		const value = props(); let view = render(value); attach(view); click(buttons(view)[0]!); view = await commit(value);
		api.listModels.mockResolvedValueOnce(catalog("second-model", "second"));
		click(buttons(view).find((button) => text(button) === "Provider second")!); view = await commit(value);
		expect(text(view)).toContain("second-model"); api.listModels.mockResolvedValueOnce(catalog("updated-first"));
		click(buttons(view).find((button) => text(button) === "Provider first")!); view = await commit(value);
		expect(api.listModels.mock.calls.map(([id]) => id)).toEqual(["first", "second", "first"]);
		expect(text(view)).toContain("updated-first"); expect(text(view)).not.toContain("fresh-model");
	});

	it("aborts the old request on close and ignores its late response after reopening", async () => {
		const value = props(); const old = deferred<LlmProviderModels>(); api.listModels.mockReturnValueOnce(old.promise);
		let view = render(value); attach(view); click(buttons(view)[0]!); view = await commit(value);
		const oldSignal = api.listModels.mock.calls[0]?.[1]; click(buttons(view)[0]!); view = render(value);
		expect(oldSignal?.aborted).toBe(true); api.listModels.mockResolvedValueOnce(catalog("current-model"));
		click(buttons(view)[0]!); view = await commit(value); old.resolve(catalog("outdated-model")); await settle(); view = render(value);
		expect(text(view)).toContain("current-model"); expect(text(view)).not.toContain("outdated-model");
	});

	it("aborts the pending model read when the selector unmounts", async () => {
		const value = props(); const pending = deferred<LlmProviderModels>(); api.listModels.mockReturnValueOnce(pending.promise);
		const view = render(value); attach(view); click(buttons(view)[0]!); await commit(value);
		const signal = api.listModels.mock.calls[0]?.[1]; hooks.unmount(); expect(signal?.aborted).toBe(true);
		pending.resolve(catalog("late-model")); await settle(); expect(value.onSelect).not.toHaveBeenCalled();
	});

	it("reloads an open provider after catalog metadata changes even when its model count is unchanged", async () => {
		const value = props(); const old = deferred<LlmProviderModels>(); api.listModels.mockReturnValueOnce(old.promise);
		let view = render(value); attach(view); click(buttons(view)[0]!); view = await commit(value);
		const oldSignal = api.listModels.mock.calls[0]?.[1];
		providerState.providers = providerState.providers.map((entry) => ({ ...entry }));
		api.listModels.mockResolvedValueOnce(catalog("same-count-current-model")); view = await commit(value);
		expect(oldSignal?.aborted).toBe(true); expect(api.listModels.mock.calls.map(([id]) => id)).toEqual(["first", "first"]);
		expect(text(view)).toContain("same-count-current-model");
		old.resolve(catalog("before-refresh-model")); await settle(); view = render(value);
		expect(text(view)).toContain("same-count-current-model"); expect(text(view)).not.toContain("before-refresh-model");
	});

	it("clears a selected model that is absent from a successfully fetched directory", async () => {
		const value = props(); value.selectedModel = model("removed-model");
		api.listModels.mockResolvedValueOnce(catalog("replacement-model"));
		const view = render(value); attach(view); click(buttons(view)[0]!); await commit(value);
		expect(value.onSelect).toHaveBeenCalledExactlyOnceWith(null);
	});

	it("forwards updated capabilities for the selected model ID so its parent can reconcile thinking settings", async () => {
		const value = props(); value.selectedModel = model("same-model");
		const updated: LlmModel = { ...value.selectedModel, reasoning: true, supportedThinkingLevels: ["low", "high"], input: ["text", "image"], contextWindow: 128_000, maxTokens: 8_192 };
		api.listModels.mockResolvedValueOnce({ providerId: "first", models: [updated] });
		const view = render(value); attach(view); click(buttons(view)[0]!); await commit(value);
		expect(value.onSelect).toHaveBeenCalledExactlyOnceWith(updated);
	});

	it("does not reselect an equivalent model when the response uses a different object property order", async () => {
		const value = props(); value.selectedModel = model("same-model");
		const { contextWindow, ...otherFields } = value.selectedModel;
		const equivalent: LlmModel = { contextWindow, ...otherFields };
		api.listModels.mockResolvedValueOnce({ providerId: "first", models: [equivalent] });
		const view = render(value); attach(view); click(buttons(view)[0]!); await commit(value);
		expect(value.onSelect).not.toHaveBeenCalled();
	});

	it("does not clear the selected model when its directory read fails", async () => {
		const value = props(); value.selectedModel = model("selected-model"); api.listModels.mockRejectedValueOnce(new Error("Unavailable"));
		const view = render(value); attach(view); click(buttons(view)[0]!); await commit(value);
		expect(value.onSelect).not.toHaveBeenCalled();
	});

	it("does not compare a selected model against a different provider's directory", async () => {
		const value = props(); value.selectedModel = model("selected-model"); api.listModels.mockResolvedValueOnce(catalog("selected-model"));
		let view = render(value); attach(view); click(buttons(view)[0]!); view = await commit(value);
		api.listModels.mockResolvedValueOnce(catalog("different-model", "second"));
		click(buttons(view).find((button) => text(button) === "Provider second")!); await commit(value);
		expect(value.onSelect).not.toHaveBeenCalled();
	});
});
