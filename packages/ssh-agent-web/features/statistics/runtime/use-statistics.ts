"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchStatistics, type StatisticsResponses } from "../api/statistics-api";
import { parseStatisticsLocation, type StatisticsLocation } from "../model/statistics-location";

export function useStatisticsLocation() {
	const [location, setLocation] = useState<StatisticsLocation | null>(null);
	const read = useCallback(() => setLocation(parseStatisticsLocation(new URLSearchParams(window.location.search),
		Intl.DateTimeFormat().resolvedOptions().timeZone, Date.now())), []);
	useEffect(() => { read(); window.addEventListener("popstate", read); return () => window.removeEventListener("popstate", read); }, [read]);
	const update = useCallback((patch: Partial<StatisticsLocation>) => {
		const url = new URL(window.location.href);
		for (const [key, value] of Object.entries(patch)) {
			if (value === "") url.searchParams.delete(key); else url.searchParams.set(key, String(value));
		}
		if (!("cursor" in patch)) url.searchParams.delete("cursor");
		window.history.pushState(null, "", `${url.pathname}${url.search}`);
		read();
	}, [read]);
	return { location, update };
}

export function useStatistics<E extends keyof StatisticsResponses>(endpoint: E, query: string | null, refresh: number) {
	const [state, setState] = useState<{ key: string; data: StatisticsResponses[E] | null; error: unknown; loading: boolean }>(
		{ key: "", data: null, error: null, loading: true });
	const key = `${endpoint}?${query ?? ""}#${refresh}`;
	useEffect(() => {
		if (query === null) return;
		const controller = new AbortController();
		setState({ key, data: null, error: null, loading: true });
		void fetchStatistics(endpoint, new URLSearchParams(query), controller.signal).then(
			(data) => { if (!controller.signal.aborted) setState({ key, data, error: null, loading: false }); },
			(error: unknown) => { if (!controller.signal.aborted) setState({ key, data: null, error, loading: false }); },
		);
		return () => controller.abort();
	}, [endpoint, query, refresh, key]);
	return state.key === key ? state : { data: null, error: null, loading: true };
}
