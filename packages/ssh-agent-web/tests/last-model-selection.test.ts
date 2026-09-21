import { afterEach, describe, expect, it, vi } from "vitest";
import { readLastModelSelection, rememberModelSelection } from "../features/llm-provider/model/last-model-selection";

afterEach(() => vi.unstubAllGlobals());
describe("global last model preference", () => {
	it("stores model identity across workspaces and skips duplicate writes", () => {
		let stored: string | null = null;
		const setItem = vi.fn((_key: string, value: string) => { stored = value; });
		vi.stubGlobal("localStorage", { getItem: () => stored, setItem });
		expect(readLastModelSelection()).toBeNull();
		rememberModelSelection({ providerId: "one", modelId: "model" });
		expect(readLastModelSelection()).toEqual({ providerId: "one", modelId: "model" });
		rememberModelSelection({ providerId: "one", modelId: "model" });
		expect(setItem).toHaveBeenCalledTimes(1);
		rememberModelSelection({ providerId: "two", modelId: "model" });
		expect(readLastModelSelection()).toEqual({ providerId: "two", modelId: "model" });
		expect(setItem).toHaveBeenCalledTimes(2);
	});
	it.each(["invalid", "null", "{}", '{"providerId":"p","modelId":2}', '{"providerId":"","modelId":"m"}'])("ignores malformed preference %s", (value) => {
		vi.stubGlobal("localStorage", { getItem: () => value });
		expect(readLastModelSelection()).toBeNull();
	});
	it("tolerates disabled browser storage", () => {
		vi.stubGlobal("localStorage", { getItem: () => { throw new Error("disabled"); }, setItem: () => { throw new Error("quota"); } });
		expect(readLastModelSelection()).toBeNull();
		expect(() => rememberModelSelection({ providerId: "p", modelId: "m" })).not.toThrow();
	});
});
