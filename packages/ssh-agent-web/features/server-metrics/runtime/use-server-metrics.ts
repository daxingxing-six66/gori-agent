"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useLocale } from "@/features/i18n/components/locale-context";
import { INITIAL_SERVER_METRICS_STATE } from "../model/server-metrics";
import { createServerMetricsStore } from "./server-metrics-store";
import { openServerMetricsStream } from "./server-metrics-stream";

const store = createServerMetricsStore(openServerMetricsStream);
const serverSnapshot = () => INITIAL_SERVER_METRICS_STATE;

export function useServerMetrics(workspaceId: string) {
	const { locale } = useLocale();
	const resource = useMemo(() => store.resource(workspaceId, locale), [workspaceId, locale]);
	return useSyncExternalStore(resource.subscribe, resource.getSnapshot, serverSnapshot);
}
