import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomSelectOption } from "../components/custom-select";
import type { StatisticsLocation } from "../features/statistics/model/statistics-location";
import { messagesByLocale } from "../features/i18n/messages/messages";

type SelectProps = { ariaLabel: string; value: string; options: CustomSelectOption[]; disabled?: boolean; onChange(value: string): void };
const controls = vi.hoisted(() => ({ current: [] as SelectProps[] }));
vi.mock("../components/custom-select", () => ({ CustomSelect: (props: SelectProps) => { controls.current.push(props); return null; } }));
import { StatisticsModelFilters } from "../features/statistics/components/statistics-model-filters";

const models = [{ providerId: "one", modelId: "same-name" }, { providerId: "one", modelId: "other-model" }, { providerId: "two", modelId: "same-name" }];
beforeEach(() => { controls.current = []; });
function render(location: Pick<StatisticsLocation, "providerId" | "model">, locale: "zh-CN" | "en-US" = "zh-CN", available = models) {
	const update = vi.fn();
	renderToStaticMarkup(<IntlProvider locale={locale} messages={messagesByLocale[locale]}>
		<StatisticsModelFilters location={location} models={available} update={update} />
	</IntlProvider>);
	return { provider: controls.current[0], model: controls.current[1], update };
}

describe("statistics provider and model filters", () => {
	it.each(["zh-CN", "en-US"] as const)("requires a provider before choosing a model in %s", locale => {
		const result = render({ providerId: "", model: "" }, locale);
		expect(result.provider.options.map(option => option.value)).toEqual(["", "one", "two"]);
		expect(result.model.disabled).toBe(true);
		expect(result.model.options).toHaveLength(1);
		expect(result.model.options[0].label).toBe(locale === "zh-CN" ? "请先选择厂商" : "Select a provider first");
	});
	it("limits models to the selected provider and clears a model only when the provider changes", () => {
		const selected = JSON.stringify(["two", "same-name"]);
		const result = render({ providerId: "two", model: selected });
		expect(result.model.disabled).toBe(false);
		expect(result.model.options.map(option => option.value)).toEqual(["", selected]);
		expect(result.model.options[1].label).toBe("same-name");
		result.provider.onChange("two"); expect(result.update).not.toHaveBeenCalled();
		result.provider.onChange("one"); expect(result.update).toHaveBeenLastCalledWith({ providerId: "one", model: "" });
		result.provider.onChange(""); expect(result.update).toHaveBeenLastCalledWith({ providerId: "", model: "" });
	});
	it("keeps the inferred provider when clearing a model from an old shared link", () => {
		const result = render({ providerId: "one", model: JSON.stringify(["one", "same-name"]) });
		result.model.onChange("");
		expect(result.update).toHaveBeenCalledWith({ providerId: "one", model: "" });
	});
	it("preserves restored historical choices while options load or no longer contain them", () => {
		const selected = JSON.stringify(["historical", "old-model"]);
		const result = render({ providerId: "historical", model: selected }, "zh-CN", []);
		expect(result.provider.options.map(option => option.value)).toEqual(["", "historical"]);
		expect(result.model.value).toBe(selected);
		expect(result.model.options.map(option => option.value)).toEqual(["", selected]);
		expect(result.update).not.toHaveBeenCalled();
	});
});
