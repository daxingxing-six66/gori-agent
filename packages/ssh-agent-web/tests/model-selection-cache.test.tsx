import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ModelThinkingSelector } from "../features/llm-provider/components/model-thinking-selector";
import type { LlmModel } from "../features/llm-provider/model/llm-provider";

const state = vi.hoisted(() => ({ select: null as null | ((model: LlmModel | null) => void) }));
vi.mock("../features/llm-provider/components/model-selector", () => ({ ModelSelector: (props: { onSelect(model: LlmModel | null): void }) => { state.select = props.onSelect; return null; } }));
vi.mock("../features/llm-provider/components/thinking-level-selector", () => ({ ThinkingLevelSelector: () => null }));
afterEach(() => vi.unstubAllGlobals());
it("writes only on a user model change, not rendering or choosing the same model", () => {
	const setItem = vi.fn();
	vi.stubGlobal("localStorage", { getItem: () => null, setItem });
	const selected = { id: "m", providerId: "p", supportedThinkingLevels: ["off"] } as LlmModel;
	const onSelect = vi.fn();
	renderToStaticMarkup(<ModelThinkingSelector selectedModel={selected} thinkingLevel="off" onSelectModel={onSelect} onSelectThinkingLevel={() => {}} />);
	expect(setItem).not.toHaveBeenCalled();
	state.select!(selected);
	expect(setItem).not.toHaveBeenCalled();
	state.select!({ ...selected, providerId: "other" });
	expect(setItem).toHaveBeenCalledExactlyOnceWith("gori:last-model-selection:v1", JSON.stringify({ providerId: "other", modelId: "m" }));
	expect(onSelect).toHaveBeenCalledTimes(2);
});
