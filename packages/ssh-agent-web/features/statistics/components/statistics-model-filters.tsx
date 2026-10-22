"use client";

import { useIntl } from "react-intl";
import { CustomSelect } from "@/components/custom-select";
import type { StatisticsLocation } from "../model/statistics-location";
import type { StatisticsOptions } from "../model/statistics";

export function StatisticsModelFilters({ location, models, update }: {
	location: Pick<StatisticsLocation, "providerId" | "model">;
	models: StatisticsOptions["models"];
	update(patch: Partial<StatisticsLocation>): void;
}) {
	const intl = useIntl();
	const { providerId, model } = location;
	const providers = [...new Set(models.map(row => row.providerId))];
	if (providerId && !providers.includes(providerId)) providers.unshift(providerId);
	const available = models.filter(row => row.providerId === providerId);
	const selected = model ? JSON.parse(model) as [string, string] : null;
	// Keep a restored selection visible while options load or after a model disappears.
	if (selected?.[0] === providerId && !available.some(row => row.modelId === selected[1]))
		available.unshift({ providerId, modelId: selected[1] });
	return <>
		<div className="stats-filter stats-provider-filter"><span>{intl.formatMessage({ id: "statistics.provider" })}</span>
			<CustomSelect compact ariaLabel={intl.formatMessage({ id: "statistics.provider" })} value={providerId}
				onChange={next => { if (next !== providerId) update({ providerId: next, model: "" }); }} options={[
					{ value: "", label: intl.formatMessage({ id: "statistics.allProviders" }) },
					...providers.map(id => ({ value: id, label: id })),
				]} />
		</div>
		<div className="stats-filter stats-model-filter"><span>{intl.formatMessage({ id: "statistics.model" })}</span>
			<CustomSelect key={providerId} compact ariaLabel={intl.formatMessage({ id: "statistics.model" })} value={model} disabled={!providerId}
				onChange={next => update({ providerId, model: next })} options={[
					{ value: "", label: intl.formatMessage({ id: providerId ? "statistics.allModels" : "statistics.selectProviderFirst" }) },
					...available.map(row => ({ value: JSON.stringify([row.providerId, row.modelId]), label: row.modelId })),
				]} />
		</div>
	</>;
}
