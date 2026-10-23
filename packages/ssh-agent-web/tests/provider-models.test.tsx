import { Children, isValidElement, type ChangeEvent, type ComponentProps, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { createIntl } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enUSMessages } from "../features/i18n/messages/en-US";
import { deriveLlmProviderState, type CustomLlmProvider, type LlmModel, type LlmProvider, type LlmProviderModels } from "../features/llm-provider/model/llm-provider";
import { deferred, HookDriver } from "./helpers/hook-driver";

let hooks: HookDriver;
const intl = createIntl({ locale: "en-US", messages: enUSMessages });
const api = vi.hoisted(() => ({
	listModels: vi.fn<(providerId: string, signal?: AbortSignal) => Promise<LlmProviderModels>>(),
	refreshModels: vi.fn<(providerId: string, signal?: AbortSignal) => Promise<LlmProviderModels>>(),
}));
const subscription = vi.hoisted(() => ({
	connection: vi.fn<() => Promise<{ connected: boolean; email: string | null; sharing: boolean; manageUsageUrl: string }>>(),
	cancel: vi.fn<() => Promise<void>>(), refreshProviders: vi.fn<() => Promise<LlmProvider[]>>(),
}));
vi.mock("react", async (original) => ({
	...await original<typeof import("react")>(),
	useId: () => "provider-models-test",
	useState: (initial: unknown) => hooks.state(initial),
	useRef: (initial: unknown) => hooks.ref(initial),
	useMemo: <T,>(factory: () => T, deps?: readonly unknown[]) => hooks.memo(factory, deps),
	useCallback: <T,>(callback: T, deps?: readonly unknown[]) => hooks.memo(() => callback, deps),
	useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => hooks.effect(effect, deps),
}));
vi.mock("react-intl", async (original) => ({ ...await original<typeof import("react-intl")>(), useIntl: () => intl }));
vi.mock("../features/llm-provider/api/llm-provider-api", () => ({ llmProviderApi: api }));
vi.mock("../features/llm-provider/api/chatgpt-api", () => ({ chatGptApi: { connection: subscription.connection, cancel: subscription.cancel } }));
vi.mock("../features/llm-provider/components/llm-provider-context", () => ({ useLlmProviders: () => ({ refreshProviders: subscription.refreshProviders }) }));
import { ProviderModelsPanel } from "../features/llm-provider/components/provider-models-panel";
import { ProviderList } from "../features/llm-provider/components/provider-list";
import { ChatGptConnection } from "../features/llm-provider/components/chatgpt-connection";

const provider: LlmProvider = {
	id: "custom-example", name: "Example Service", custom: true, baseUrl: "https://example.test/v1",
	auth: { apiKey: true, oauth: false }, configured: true,
	credential: { providerId: "custom-example", type: "api_key", revision: 1, createdAt: 1, updatedAt: 1 }, modelCount: 1,
};
function model(id: string, name = id): LlmModel {
	return { id, name, providerId: provider.id, api: "openai-completions", reasoning: false,
		supportedThinkingLevels: ["off"], input: ["text", "image"], contextWindow: 128_000, maxTokens: 8_192 };
}
function catalog(...models: LlmModel[]): LlmProviderModels { return { providerId: provider.id, models }; }
function props(): ComponentProps<typeof ProviderModelsPanel> {
	return { provider, initialRefresh: false, onBusyChange: vi.fn(), onRefreshed: vi.fn(async () => undefined) };
}
function render(value: ComponentProps<typeof ProviderModelsPanel>) { return hooks.render(() => ProviderModelsPanel(value)); }
function elements(node: ReactNode): ReactElement<{ children?: ReactNode; role?: string }>[] {
	const result: ReactElement<{ children?: ReactNode; role?: string }>[] = [];
	Children.forEach(node, (child) => {
		if (!isValidElement<{ children?: ReactNode; role?: string }>(child)) return;
		if (typeof child.type === "function") {
			const component = child.type as (props: { children?: ReactNode }) => ReactNode;
			result.push(...elements(component(child.props)));
		} else result.push(child, ...elements(child.props.children));
	});
	return result;
}
function native<T extends "button" | "input" | "li" | "dd">(node: ReactNode, type: T): ReactElement<ComponentProps<T>>[] {
	return elements(node).filter((element) => element.type === type) as ReactElement<ComponentProps<T>>[];
}
function text(node: ReactNode): string {
	let result = "";
	Children.forEach(node, (child) => {
		if (typeof child === "string" || typeof child === "number") result += child;
		else if (isValidElement<{ children?: ReactNode }>(child)) result += text(child.props.children);
	});
	return result;
}
function click(node: ReactElement<ComponentProps<"button">>) { node.props.onClick?.({} as MouseEvent<HTMLButtonElement>); }
function refresh(view: ReactNode) { click(native(view, "button")[0]!); }
async function settle() { for (let count = 0; count < 12; count++) await Promise.resolve(); }

beforeEach(() => {
	hooks = new HookDriver(); vi.resetAllMocks(); api.listModels.mockResolvedValue(catalog(model("old-model"))); api.refreshModels.mockResolvedValue(catalog(model("new-model")));
	subscription.connection.mockResolvedValue({ connected: true, sharing: true, email: "test@example.test", manageUsageUrl: "https://usage.example.test" });
	subscription.refreshProviders.mockResolvedValue([]); subscription.cancel.mockResolvedValue();
});
afterEach(() => hooks.unmount());

describe("Provider model catalog details", () => {
	it("reads the effective catalog without refreshing its source and displays provider identity and model capabilities", async () => {
		const value = props(); let view = render(value); await settle(); view = render(value);
		expect(api.listModels).toHaveBeenCalledExactlyOnceWith(provider.id, expect.any(AbortSignal));
		expect(api.refreshModels).not.toHaveBeenCalled(); expect(value.onRefreshed).not.toHaveBeenCalled();
		expect(text(view)).toContain(provider.id); expect(text(view)).toContain(provider.baseUrl);
		expect(text(view)).toContain("API Key"); expect(text(view)).toContain("old-model");
		expect(text(view)).toContain("128,000"); expect(text(view)).toContain("8,192");
		expect(text(view)).toContain("openai-completions"); expect(native(view, "button")[0]?.props.disabled).toBe(false);
		expect(value.onBusyChange).toHaveBeenLastCalledWith(false);
	});

	it("refreshes once for same-frame clicks, replaces the list and keeps the operation busy until metadata synchronizes", async () => {
		const value = props(); const pending = deferred<LlmProviderModels>(); const metadata = deferred<void>();
		api.refreshModels.mockReturnValue(pending.promise); value.onRefreshed = vi.fn(() => metadata.promise);
		let view = render(value); await settle(); view = render(value);
		refresh(view); refresh(view); view = render(value);
		expect(api.refreshModels).toHaveBeenCalledExactlyOnceWith(provider.id, expect.any(AbortSignal));
		expect(native(view, "button")[0]?.props.disabled).toBe(true); expect(value.onBusyChange).toHaveBeenLastCalledWith(true);
		pending.resolve(catalog(model("new-model"))); await settle(); view = render(value);
		expect(text(view)).toContain("new-model"); expect(text(view)).not.toContain("old-model");
		expect(value.onRefreshed).toHaveBeenCalledOnce(); expect(native(view, "button")[0]?.props.disabled).toBe(true);
		metadata.resolve(); await settle(); view = render(value);
		expect(native(view, "button")[0]?.props.disabled).toBe(false); expect(value.onBusyChange).toHaveBeenLastCalledWith(false);
		expect(elements(view).some((element) => element.props.role === "status")).toBe(true);
	});

	it("keeps the last catalog visible when a manual refresh fails and allows retry", async () => {
		const value = props(); let view = render(value); await settle(); view = render(value);
		api.refreshModels.mockRejectedValueOnce(new Error("Refresh unavailable")); refresh(view); await settle(); view = render(value);
		expect(text(view)).toContain("old-model"); expect(text(view)).toContain(intl.formatMessage({ id: "common.error.requestFailed" }));
		expect(text(view)).not.toContain("Refresh unavailable");
		expect(elements(view).some((element) => element.props.role === "alert")).toBe(true);
		expect(value.onRefreshed).not.toHaveBeenCalled(); expect(native(view, "button")[0]?.props.disabled).toBe(false);
		refresh(view); await settle(); view = render(value);
		expect(api.refreshModels).toHaveBeenCalledTimes(2); expect(text(view)).toContain("new-model");
		expect(elements(view).some((element) => element.props.role === "alert")).toBe(false);
	});

	it("loads the old catalog before a row-initiated refresh and retains it on failure", async () => {
		const value = props(); value.initialRefresh = true; api.refreshModels.mockRejectedValueOnce(new Error("Offline"));
		render(value); await settle(); const view = render(value);
		expect(api.listModels).toHaveBeenCalledOnce(); expect(api.refreshModels).toHaveBeenCalledOnce();
		expect(api.listModels.mock.invocationCallOrder[0]).toBeLessThan(api.refreshModels.mock.invocationCallOrder[0]!);
		expect(text(view)).toContain("old-model"); expect(text(view)).toContain(intl.formatMessage({ id: "common.error.requestFailed" })); expect(value.onRefreshed).not.toHaveBeenCalled();
	});

	it("still performs an explicit refresh if reading the prior catalog fails", async () => {
		const value = props(); value.initialRefresh = true; api.listModels.mockRejectedValueOnce(new Error("Read failed"));
		render(value); await settle(); const view = render(value);
		expect(api.refreshModels).toHaveBeenCalledOnce(); expect(text(view)).toContain("new-model"); expect(text(view)).not.toContain("Read failed");
		expect(value.onRefreshed).toHaveBeenCalledOnce();
	});

	it("retries a failed read without triggering source refresh and supports empty catalogs", async () => {
		const value = props(); api.listModels.mockRejectedValueOnce(new Error("Read failed"));
		render(value); await settle(); let view = render(value);
		expect(text(view)).toContain(intl.formatMessage({ id: "common.error.requestFailed" })); expect(native(view, "button")).toHaveLength(2);
		api.listModels.mockResolvedValueOnce(catalog()); click(native(view, "button")[1]!); await settle(); view = render(value);
		expect(api.listModels).toHaveBeenCalledTimes(2); expect(api.refreshModels).not.toHaveBeenCalled(); expect(native(view, "li")).toHaveLength(0);
		expect(text(view)).toContain(intl.formatMessage({ id: "provider.models.empty" }));
	});

	it("cancels a row-initiated refresh before its initial read completes", async () => {
		const value = props(); value.initialRefresh = true; const pending = deferred<LlmProviderModels>(); api.listModels.mockReturnValueOnce(pending.promise);
		render(value); await settle(); const signal = api.listModels.mock.calls[0]?.[1]; hooks.unmount();
		expect(signal?.aborted).toBe(true); expect(value.onBusyChange).toHaveBeenLastCalledWith(false);
		pending.resolve(catalog(model("late"))); await settle();
		expect(api.refreshModels).not.toHaveBeenCalled(); expect(value.onRefreshed).not.toHaveBeenCalled();
	});

	it("aborts an in-flight manual refresh on unmount and ignores its late response", async () => {
		const value = props(); const pending = deferred<LlmProviderModels>(); api.refreshModels.mockReturnValueOnce(pending.promise);
		let view = render(value); await settle(); view = render(value); refresh(view); render(value);
		const signal = api.refreshModels.mock.calls[0]?.[1]; hooks.unmount(); expect(signal?.aborted).toBe(true);
		pending.resolve(catalog(model("late"))); await settle(); expect(value.onRefreshed).not.toHaveBeenCalled();
		expect(value.onBusyChange).toHaveBeenLastCalledWith(false);
	});

	it("retains the updated model list if metadata synchronization fails", async () => {
		const value = props(); value.onRefreshed = vi.fn(async () => { throw new Error("Metadata unavailable"); });
		let view = render(value); await settle(); view = render(value); refresh(view); await settle(); view = render(value);
		expect(text(view)).toContain("new-model"); expect(text(view)).not.toContain("old-model");
		expect(text(view)).toContain(intl.formatMessage({ id: "common.error.requestFailed" })); expect(native(view, "button")[0]?.props.disabled).toBe(false);
	});

	it("keeps one refresh across parent metadata rerenders and uses the latest synchronization callback", async () => {
		const value = props(); value.initialRefresh = true; const originalCallback = value.onRefreshed;
		const pending = deferred<LlmProviderModels>(); api.refreshModels.mockReturnValueOnce(pending.promise);
		render(value); await settle(); expect(api.refreshModels).toHaveBeenCalledOnce();
		value.provider = { ...provider, modelCount: 2 }; value.onRefreshed = vi.fn(async () => undefined); render(value);
		pending.resolve(catalog(model("updated"))); await settle(); render(value);
		expect(api.listModels).toHaveBeenCalledOnce(); expect(api.refreshModels).toHaveBeenCalledOnce();
		expect(originalCallback).not.toHaveBeenCalled(); expect(value.onRefreshed).toHaveBeenCalledOnce();
	});

	it("filters models by name or ID and does not send requests while searching", async () => {
		const value = props(); api.listModels.mockResolvedValueOnce(catalog(model("model-a", "Alpha"), model("model-b", "Beta")));
		let view = render(value); await settle(); view = render(value);
		native(view, "input")[0]!.props.onChange?.({ target: { value: "MODEL-B" } } as ChangeEvent<HTMLInputElement>);
		view = render(value); expect(native(view, "li")).toHaveLength(1); expect(text(view)).toContain("Beta"); expect(text(view)).not.toContain("Alpha");
		expect(api.listModels).toHaveBeenCalledOnce(); expect(api.refreshModels).not.toHaveBeenCalled();
	});

	it("allows reading an unconfigured provider but blocks a manual refresh", async () => {
		const value = props(); value.provider = { ...provider, configured: false };
		let view = render(value); await settle(); view = render(value); refresh(view);
		expect(api.listModels).toHaveBeenCalledOnce(); expect(api.refreshModels).not.toHaveBeenCalled(); expect(native(view, "button")[0]?.props.disabled).toBe(true);
	});
});

describe("Provider model entry points", () => {
	function listProps(): ComponentProps<typeof ProviderList> {
		const builtin: LlmProvider = { ...provider, id: "api-example", name: "API Example", custom: false,
			credential: { ...provider.credential!, providerId: "api-example" } };
		const custom: CustomLlmProvider = { id: provider.id, name: provider.name, baseUrl: provider.baseUrl!, api: "openai-completions", authMode: "api_key", compat: {}, models: [], revision: 1, createdAt: 1, updatedAt: 1 };
		const providers = [builtin, provider];
		return { activeTab: "connections", onTabChange: vi.fn(), busy: false, subscription: null, providers, providersError: null,
			providerState: deriveLlmProviderState(providers), loading: false, customProviders: [custom], customError: null, customLoading: false,
			onReloadProviders: vi.fn(), onReloadCustomProviders: vi.fn(), onCreateCustom: vi.fn(), onEditCustom: vi.fn(), onCreateCredential: vi.fn(), onEditCredential: vi.fn(), onViewModels: vi.fn(), onRefreshModels: vi.fn() };
	}
	function action(view: ReactNode, id: "provider.models.view" | "provider.models.refresh") {
		return native(view, "button").find((button) => text(button) === intl.formatMessage({ id }))!;
	}
	it.each(["connections", "custom"] as const)("shows view and refresh beside the exact %s provider without opening credential forms", (tab) => {
		const value = listProps(); value.activeTab = tab; const view = hooks.render(() => ProviderList(value));
		expect(action(view, "provider.models.view").props.disabled).toBe(false); expect(action(view, "provider.models.refresh").props.disabled).toBe(false);
		click(action(view, "provider.models.view")); click(action(view, "provider.models.refresh"));
		const id = tab === "connections" ? "api-example" : provider.id;
		expect(value.onViewModels).toHaveBeenCalledExactlyOnceWith(id); expect(value.onRefreshModels).toHaveBeenCalledExactlyOnceWith(id);
		expect(value.onEditCredential).not.toHaveBeenCalled(); expect(value.onEditCustom).not.toHaveBeenCalled();
	});
	it("allows viewing an unconfigured API provider while disabling refresh", () => {
		const value = listProps(); value.providers = value.providers!.map((entry) => ({ ...entry, configured: false })); value.providerState = deriveLlmProviderState(value.providers);
		const view = hooks.render(() => ProviderList(value)); expect(action(view, "provider.models.view").props.disabled).toBe(false); expect(action(view, "provider.models.refresh").props.disabled).toBe(true);
	});
	it.each(["connections", "custom"] as const)("disables both %s model actions while settings are busy", (tab) => {
		const value = listProps(); value.activeTab = tab; value.busy = true; const view = hooks.render(() => ProviderList(value));
		expect(action(view, "provider.models.view").props.disabled).toBe(true); expect(action(view, "provider.models.refresh").props.disabled).toBe(true);
	});
	it("shows subscription view and refresh actions without opening the more menu", async () => {
		const value: ComponentProps<typeof ChatGptConnection> = { onBusyChange: vi.fn(), onViewModels: vi.fn(), onRefreshModels: vi.fn() };
		hooks.render(() => ChatGptConnection(value)); await settle(); const view = hooks.render(() => ChatGptConnection(value));
		expect(action(view, "provider.models.view").props.disabled).toBe(false); expect(action(view, "provider.models.refresh").props.disabled).toBe(false);
		click(action(view, "provider.models.view")); click(action(view, "provider.models.refresh"));
		expect(value.onViewModels).toHaveBeenCalledOnce(); expect(value.onRefreshModels).toHaveBeenCalledOnce();
		expect(native(view, "button").some((button) => button.props["aria-expanded"] === true)).toBe(false);
	});
	it("disables subscription refresh without plan permission while retaining catalog inspection", async () => {
		subscription.connection.mockResolvedValueOnce({ connected: true, sharing: false, email: "test@example.test", manageUsageUrl: "https://usage.example.test" });
		const value: ComponentProps<typeof ChatGptConnection> = { onBusyChange: vi.fn(), onViewModels: vi.fn(), onRefreshModels: vi.fn() };
		hooks.render(() => ChatGptConnection(value)); await settle(); const view = hooks.render(() => ChatGptConnection(value));
		expect(action(view, "provider.models.view").props.disabled).toBe(false); expect(action(view, "provider.models.refresh").props.disabled).toBe(true);
	});
});
